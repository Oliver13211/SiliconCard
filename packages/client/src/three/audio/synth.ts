/**
 * 音效引擎（M4-SND1）——SoundSpec 解释层：振荡器 + 噪声缓冲 + 包络。
 *
 * 硬性要求与实现对照：
 * - 零音频资产 / 零外部依赖 / 零网络请求：全部声音程序化合成；
 * - AudioContext 惰性创建：首次 unlock（用户手势）或首次 play 时才建，
 *   构造不触碰任何全局对象，node/无头环境天然走降级路径；
 * - 自动播放策略：浏览器策略下 context 以 suspended 出生，unlock() 在
 *   用户手势里 resume；解锁前的调度会在解锁后顺次发声（不丢拍）；
 * - 不可用环境静默降级：无 window / 无 AudioContext / 构造抛异常 →
 *   available=false，一切播放调用退化为 no-op，绝不抛错；
 * - 节点释放纪律：一次性节点（振荡器/噪声源/滤波/增益）全部在 onended 里
 *   disconnect 交给 GC；白噪声缓冲全引擎共享一份（池化）；同时发声的
 *   voice 有上限（MAX_VOICES），病态事件洪峰下宁可丢音也不爆音。
 */

import { fxEnabled } from '../fx/quality'
import type { NoiseLayerSpec, SoundLayer, SoundSpec, ToneLayerSpec } from './spec'

/** AudioContext 构造器注入点（测试用 mock；缺省走浏览器全局守卫） */
export type AudioContextFactory = () => AudioContext | null

export interface SynthDeps {
  ctxFactory?: AudioContextFactory
}

/** 同时发声上限：事件洪峰（如一整次 endTurn 的事件批）下保护主线程与耳朵 */
export const MAX_VOICES = 64

/** BGM 总线开关电平（pad/节拍的绝对音量在 bgm.ts 配方里，已是「不喧宾夺主」档） */
const MUSIC_BUS_LEVEL = 1

function defaultCtxFactory(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
    const Ctor = w.AudioContext ?? w.webkitAudioContext
    return Ctor ? new Ctor() : null
  } catch {
    return null
  }
}

function clampGain(value: number): number {
  return Math.min(1, Math.max(0.0001, value))
}

export class Synth {
  private ctx: AudioContext | null = null
  private ctxFailed = false
  private master: GainNode | null = null
  private sfxBus: GainNode | null = null
  private musicBus: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private voices = 0
  // 设置快照：总线未建时先存，总线建成后立即可用（设置先行于 context 创建）
  private masterLevel = 0.8
  private muted = false
  private musicOn = true

  constructor(private readonly deps: SynthDeps = {}) {}

  /** Web Audio 是否可用（惰性探测一次并缓存结论） */
  get available(): boolean {
    return this.ensureContext() !== null
  }

  /** 当前 AudioContext（未创建/不可用为 null；BGM 接线用） */
  get context(): AudioContext | null {
    return this.ensureContext()
  }

  /** BGM 自建节点的接入总线（未创建/不可用为 null） */
  get musicInput(): GainNode | null {
    this.ensureContext()
    return this.musicBus
  }

  /** 用户手势解锁（自动播放策略：resume 需在手势调用栈里触发） */
  unlock(): void {
    const ctx = this.ensureContext()
    if (!ctx) return
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {
        // 简历被拒（非手势环境）：保持静默，下次手势再试
      })
    }
  }

  /** 页面隐藏时整体暂停（visibilitychange 接线） */
  suspend(): void {
    if (!this.ctx || this.ctx.state !== 'running') return
    void this.ctx.suspend().catch(() => {})
  }

  /** 页面回前台恢复 */
  resume(): void {
    if (!this.ctx || this.ctx.state !== 'suspended') return
    void this.ctx.resume().catch(() => {})
  }

  /** 应用设置（muted/volume → 主总线；musicOn → BGM 总线淡入淡出） */
  applySettings(settings: { muted: boolean; volume: number; musicOn: boolean }): void {
    this.muted = settings.muted
    this.masterLevel = Math.min(1, Math.max(0, settings.volume))
    this.musicOn = settings.musicOn
    this.applyBusGains(0.05)
  }

  /** 播一条事件音（extras 装饰层受质量门控制：low 档跳过，关键音层保留） */
  play(spec: SoundSpec): void {
    const ctx = this.ensureContext()
    if (!ctx || !this.sfxBus) return
    const t0 = ctx.currentTime + 0.03
    for (const layer of spec.layers) {
      this.scheduleLayer(layer, t0 + Math.max(0, layer.delay ?? 0), this.sfxBus)
    }
    if (spec.extras && fxEnabled('audioExtras')) {
      for (const layer of spec.extras) {
        this.scheduleLayer(layer, t0 + Math.max(0, layer.delay ?? 0), this.sfxBus)
      }
    }
  }

  /**
   * 在指定时间把一层声音调度到指定总线（BGM 节拍复用同一套包络逻辑）。
   * when 为 AudioContext 时钟绝对时间；节点在 onended 时自断开释放。
   */
  scheduleLayer(layer: SoundLayer, when: number, dest: AudioNode): void {
    if (layer.kind === 'tone') this.scheduleTone(layer, when, dest)
    else this.scheduleNoise(layer, when, dest)
  }

  /** 释放全部资源（App 级卸载才调用；平时节点自管理） */
  close(): void {
    try {
      void this.ctx?.close().catch(() => {})
    } catch {
      // 关闭失败不致命（GC 兜底）
    }
    this.ctx = null
    this.master = null
    this.sfxBus = null
    this.musicBus = null
    this.noiseBuffer = null
    this.ctxFailed = false
  }

  // —— 内部 ——

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx
    if (this.ctxFailed) return null
    try {
      const factory = this.deps.ctxFactory ?? defaultCtxFactory
      const ctx = factory()
      if (!ctx) {
        this.ctxFailed = true
        return null
      }
      this.ctx = ctx
      this.buildBuses()
      return this.ctx
    } catch {
      this.ctxFailed = true
      return null
    }
  }

  private buildBuses(): void {
    const ctx = this.ctx
    if (!ctx || this.master) return
    this.master = ctx.createGain()
    this.master.connect(ctx.destination)
    this.sfxBus = ctx.createGain()
    this.sfxBus.connect(this.master)
    this.musicBus = ctx.createGain()
    this.musicBus.connect(this.master)
    this.applyBusGains(0)
  }

  private applyBusGains(smoothing: number): void {
    const when = this.ctx?.currentTime ?? 0
    if (this.master) this.setBusGain(this.master, this.muted ? 0 : this.masterLevel, when, smoothing)
    if (this.musicBus) this.setBusGain(this.musicBus, this.musicOn ? MUSIC_BUS_LEVEL : 0, when, smoothing)
  }

  private setBusGain(bus: GainNode, value: number, when: number, smoothing: number): void {
    if (smoothing > 0) bus.gain.setTargetAtTime(value, when, smoothing)
    else bus.gain.setValueAtTime(value, when)
  }

  private scheduleTone(layer: ToneLayerSpec, when: number, dest: AudioNode): void {
    const ctx = this.ctx
    if (!ctx || this.voices >= MAX_VOICES) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const dur = Math.max(0.01, layer.dur)
    const attack = Math.min(layer.attack ?? 0.004, dur * 0.5)
    const peak = clampGain(layer.gain)
    osc.type = layer.wave
    if (layer.detune !== undefined) osc.detune.setValueAtTime(layer.detune, when)
    osc.frequency.setValueAtTime(Math.max(1, layer.freq), when)
    if (layer.glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, layer.glideTo), when + dur * 0.9)
    }
    // 包络：瞬态起音 → 峰值 → 指数衰减到听阈下（0.0001，指数斜坡要求正值）
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.linearRampToValueAtTime(peak, when + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    osc.connect(gain)
    gain.connect(dest)
    this.voices += 1
    osc.onended = () => {
      this.voices -= 1
      gain.disconnect()
      osc.disconnect()
    }
    osc.start(when)
    osc.stop(when + dur + 0.02)
  }

  private scheduleNoise(layer: NoiseLayerSpec, when: number, dest: AudioNode): void {
    const ctx = this.ctx
    if (!ctx || this.voices >= MAX_VOICES) return
    const buffer = this.ensureNoiseBuffer(ctx)
    if (!buffer) return
    const src = ctx.createBufferSource()
    src.buffer = buffer
    const gain = ctx.createGain()
    const dur = Math.max(0.01, layer.dur)
    const attack = Math.min(layer.attack ?? 0.003, dur * 0.5)
    const peak = clampGain(layer.gain)
    const nodes: AudioNode[] = [src]
    let head: AudioNode = src
    if (layer.filter) {
      const filter = ctx.createBiquadFilter()
      filter.type = layer.filter.type
      filter.frequency.setValueAtTime(Math.max(10, layer.filter.freq), when)
      if (layer.filter.q !== undefined) filter.Q.setValueAtTime(layer.filter.q, when)
      if (layer.filter.sweepTo !== undefined) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(10, layer.filter.sweepTo), when + dur)
      }
      src.connect(filter)
      head = filter
      nodes.push(filter)
    }
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.linearRampToValueAtTime(peak, when + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + dur)
    head.connect(gain)
    gain.connect(dest)
    nodes.push(gain)
    this.voices += 1
    src.onended = () => {
      this.voices -= 1
      for (const node of nodes) node.disconnect()
    }
    // 随机切片偏移：同一份白噪声每次听起来不完全一样
    const offset = Math.random() * Math.max(0, buffer.duration - dur - 0.01)
    src.start(when, offset, dur + 0.02)
    // 显式 stop 兜底（start 的 duration 已限长；显式停振让 onended → 断链确定触发）
    src.stop(when + dur + 0.04)
  }

  /** 共享白噪声缓冲（全引擎一份，池化复用） */
  private ensureNoiseBuffer(ctx: AudioContext): AudioBuffer | null {
    if (this.noiseBuffer) return this.noiseBuffer
    try {
      const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate)), ctx.sampleRate)
      const data = buffer.getChannelData(0)
      for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
      this.noiseBuffer = buffer
      return buffer
    } catch {
      return null
    }
  }
}
