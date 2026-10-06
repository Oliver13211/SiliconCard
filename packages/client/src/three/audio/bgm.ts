/**
 * 程序化 BGM（M4-SND1）——对局内循环的环境底噪：低音 pad + 轻节拍。
 *
 * 方案（零资产、零依赖、零网络）：
 * - pad：A1/E2/A2 三只失谐振荡器（两只锯齿 + 一只三角）过低通，
 *   0.05Hz 的 LFO 慢扫截止频率，音量极低（峰值 0.028）——只是「屋里有机箱在哼」；
 * - 节拍：92 BPM 前瞻调度器（setInterval 90ms，向前看 0.25s）——底鼓每 4 拍两记、
 *   沙锤每拍一粒、每 8 拍一记轻风铃；fx quality low 档整层关闭（audioExtras 门），
 *   只留 pad，关键事件音不受影响；
 * - 生命周期：start/stop 由 AudioDirector 按「是否在对局屏」驱动（对局内循环，
 *   菜单/结算静）；stop 走 0.7s 淡出后停振、断链，不留悬挂节点；
 * - 挂起安全：页面隐藏时 AudioContext 整体 suspend，currentTime 冻结 →
 *   前瞻调度器自然停摆，恢复后无补拍风暴。
 */

import { fxEnabled } from '../fx/quality'
import type { Synth } from './synth'
import type { Waveform } from './spec'

const BEAT_BPM = 92
const BEAT_SEC = 60 / BEAT_BPM
const LOOKAHEAD_SEC = 0.25
const SCHEDULER_TICK_MS = 90
const PAD_FADE_IN_SEC = 2.5
const PAD_FADE_OUT_SEC = 0.7

/** pad 配方：[波形, 频率, 峰值增益, 失谐音分] */
const PAD_VOICES: readonly [Waveform, number, number, number][] = [
  ['sawtooth', 55, 0.028, -5],
  ['sawtooth', 82.41, 0.02, 6],
  ['triangle', 110, 0.018, 0],
]

interface PadNodes {
  osc: OscillatorNode
  gain: GainNode
}

export class BgmController {
  private running = false
  private padNodes: PadNodes[] = []
  private padFilter: BiquadFilterNode | null = null
  private lfo: OscillatorNode | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private beatIndex = 0
  private nextBeatTime = 0

  constructor(private readonly synth: Synth) {}

  get isRunning(): boolean {
    return this.running
  }

  /** 起播（幂等）：pad 淡入 2.5s；high 档另起节拍调度器 */
  start(): void {
    if (this.running) return
    const ctx = this.synth.context
    const dest = this.synth.musicInput
    if (!ctx || !dest) return
    this.running = true
    const now = ctx.currentTime

    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(240, now)
    filter.Q.setValueAtTime(0.8, now)
    filter.connect(dest)
    this.padFilter = filter

    for (const [wave, freq, gainValue, detune] of PAD_VOICES) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = wave
      osc.frequency.setValueAtTime(freq, now)
      osc.detune.setValueAtTime(detune, now)
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.linearRampToValueAtTime(gainValue, now + PAD_FADE_IN_SEC)
      osc.connect(gain)
      gain.connect(filter)
      osc.start(now)
      osc.onended = () => {
        gain.disconnect()
        osc.disconnect()
      }
      this.padNodes.push({ osc, gain })
    }

    // 超慢 LFO 推低通截止：让 pad 有「机箱风扇起起伏伏」的呼吸感
    const lfo = ctx.createOscillator()
    const lfoGain = ctx.createGain()
    lfo.type = 'sine'
    lfo.frequency.setValueAtTime(0.05, now)
    lfoGain.gain.setValueAtTime(90, now)
    lfo.connect(lfoGain)
    lfoGain.connect(filter.frequency)
    lfo.start(now)
    lfo.onended = () => lfoGain.disconnect()
    this.lfo = lfo

    // 节拍层只在 high 质量档运行（low 档减 BGM 层，pad 保留）
    if (fxEnabled('audioExtras')) {
      this.beatIndex = 0
      this.nextBeatTime = now + 0.3
      this.timer = setInterval(() => this.scheduleBeats(), SCHEDULER_TICK_MS)
    }
  }

  /** 停播（幂等）：0.7s 淡出后停振断链；清理调度器 */
  stop(): void {
    if (!this.running) return
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    const ctx = this.synth.context
    const pads = this.padNodes
    const filter = this.padFilter
    const lfo = this.lfo
    this.padNodes = []
    this.padFilter = null
    this.lfo = null
    if (!ctx || pads.length === 0) {
      filter?.disconnect()
      return
    }
    const now = ctx.currentTime
    const stopAt = now + PAD_FADE_OUT_SEC + 0.15
    for (const { osc, gain } of pads) {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(Math.max(0.0001, gain.gain.value), now)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + PAD_FADE_OUT_SEC)
      osc.stop(stopAt)
    }
    lfo?.stop(stopAt)
    // 滤波器在 pad 停振后断链（挂在首个 pad 的 onended 上，避免淡出中途哑火）
    const first = pads[0]
    if (first) {
      const prevHandler = first.osc.onended
      first.osc.onended = (event) => {
        prevHandler?.call(first.osc, event)
        filter?.disconnect()
      }
    } else {
      filter?.disconnect()
    }
  }

  /** 前瞻调度：把 LOOKAHEAD 窗口内的节拍逐个落到 musicBus */
  private scheduleBeats(): void {
    const ctx = this.synth.context
    const dest = this.synth.musicInput
    if (!ctx || !dest || !this.running) return
    const ahead = ctx.currentTime + LOOKAHEAD_SEC
    // 上限保护：极端环境（时钟倒退/挂起恢复竞态）也不在单次 tick 内狂排
    let guard = 8
    while (this.nextBeatTime < ahead && guard > 0) {
      this.scheduleBeat(this.beatIndex, this.nextBeatTime)
      this.beatIndex = (this.beatIndex + 1) % 8
      this.nextBeatTime += BEAT_SEC
      guard -= 1
    }
  }

  private scheduleBeat(index: number, when: number): void {
    const dest = this.synth.musicInput
    if (!dest) return
    // 底鼓：每 4 拍的头尾（84→40Hz 下坠正弦）
    if (index % 4 === 0) {
      this.synth.scheduleLayer(
        { kind: 'tone', wave: 'sine', freq: 84, glideTo: 40, dur: 0.14, gain: 0.11, attack: 0.002 },
        when,
        dest,
      )
    }
    // 沙锤：每拍一粒高频短噪（像机箱风扇偶尔的轻响）
    this.synth.scheduleLayer(
      { kind: 'noise', dur: 0.035, gain: 0.03, filter: { type: 'highpass', freq: 6800 } },
      when,
      dest,
    )
    // 每 8 拍一记轻风铃，几乎在意识阈值下
    if (index === 6) {
      this.synth.scheduleLayer(
        { kind: 'tone', wave: 'sine', freq: 659.26, dur: 0.5, gain: 0.02, attack: 0.01 },
        when,
        dest,
      )
    }
  }
}
