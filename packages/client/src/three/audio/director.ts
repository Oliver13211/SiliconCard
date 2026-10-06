/**
 * 音频导演（M4-SND1）——音效线的唯一接线口，与 AnimationDirector 同层级。
 *
 * 事件源：与 3D 演出共用同一条 GameEvent 流（经 wiring 注入的订阅口 = ui 侧
 * onBattleEvents），逐条经 eventSoundMap 路由——音画同拍的同源保证。
 * 依赖方向：three/audio 不 import ui（与 three 线纪律一致），ui 通过
 * initAudio({ getViewer, subscribeEvents }) 注入两个 ui 侧钩子。
 *
 * 全局职责：
 * - 首次手势解锁（pointerdown/click → AudioContext.resume，自动播放策略）；
 * - UI 点击音：document 级 click 监听 + button 命中判定（零组件侵入）；
 * - 页面隐藏暂停 / 回前台恢复（visibilitychange → ctx.suspend/resume）；
 * - BGM 生命周期：对局屏挂载期 start，其余 stop（菜单/结算静）；
 * - 设置落地：muted/volume → 主总线，bgmEnabled → BGM 总线（淡变）；
 * - 任何音频异常按事件逐条吞掉并 console.error——音频永不炸对局。
 */

import type { GameEvent, PlayerId } from '@siliconcard/core'
import { BgmController } from './bgm'
import { resolveEventSound } from './soundMap'
import { loadAudioSettings, type AudioSettings } from './settings'
import { Synth, type SynthDeps } from './synth'
import { noise, tone, type SoundSpec } from './spec'

/** ui 侧注入的两个钩子（three/audio 不反向依赖 ui） */
export interface AudioWiring {
  /** 当前视角方（TURN_START/GAME_END 的胜败变体分流） */
  getViewer(): PlayerId
  /** 引擎事件批订阅口（= gameStore 的 onBattleEvents） */
  subscribeEvents(cb: (events: readonly GameEvent[]) => void): () => void
}

export interface AudioDirector {
  /** 挂接事件订阅与 DOM 监听（幂等：重复 start 先拆旧订阅） */
  start(wiring: AudioWiring): void
  /** 拆除全部监听（App 卸载；音频设置与实例保留以便复挂） */
  stop(): void
  /** 对局屏挂载/卸载 → BGM 起停 */
  setBattleActive(active: boolean): void
  /** 应用并生效设置（持久化由 ui 侧负责） */
  setSettings(settings: AudioSettings): void
  getSettings(): AudioSettings
  /** 播一批引擎事件音（viewer 决定胜败/回合变体） */
  playEvents(events: readonly GameEvent[], viewer?: PlayerId): void
  /** UI 点击音 */
  uiClick(): void
  /** 用户手势解锁（自动播放策略） */
  unlock(): void
  isAvailable(): boolean
}

/** UI 点击音：短促方波 blip + 高频瞬态（不是事件流的一部分，常驻） */
const UI_CLICK: SoundSpec = {
  layers: [
    tone('square', 1500, 0.05, 0.12, { glideTo: 900 }),
    noise(0.02, 0.08, { filter: { type: 'highpass', freq: 4000 } }),
  ],
}

export function createAudioDirector(deps: SynthDeps = {}): AudioDirector {
  const synth = new Synth(deps)
  const bgm = new BgmController(synth)
  let settings: AudioSettings = loadAudioSettings()
  let battleActive = false
  let unsubscribeEvents: (() => void) | null = null
  let detachDom: (() => void) | null = null

  synth.applySettings({ muted: settings.muted, volume: settings.volume, musicOn: settings.bgmEnabled })

  function applyBgmGate(): void {
    if (battleActive && settings.bgmEnabled) bgm.start()
    else bgm.stop()
  }

  const director: AudioDirector = {
    start(wiring) {
      // 重入安全：先拆旧订阅再挂新的
      if (unsubscribeEvents) unsubscribeEvents()
      unsubscribeEvents = wiring.subscribeEvents((events) => {
        director.playEvents(events, wiring.getViewer())
      })
      if (typeof document === 'undefined') return // 无头/node：无 DOM 监听
      const onPointerDown = () => director.unlock()
      const onClick = (event: MouseEvent) => {
        director.unlock()
        if (event.target instanceof Element && event.target.closest('button')) {
          director.uiClick()
        }
      }
      const onVisibilityChange = () => {
        if (document.hidden) synth.suspend()
        else synth.resume()
      }
      document.addEventListener('pointerdown', onPointerDown, { passive: true })
      document.addEventListener('click', onClick)
      document.addEventListener('visibilitychange', onVisibilityChange)
      detachDom = () => {
        document.removeEventListener('pointerdown', onPointerDown)
        document.removeEventListener('click', onClick)
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    },

    stop() {
      if (unsubscribeEvents) {
        unsubscribeEvents()
        unsubscribeEvents = null
      }
      detachDom?.()
      detachDom = null
      bgm.stop()
    },

    setBattleActive(active) {
      battleActive = active
      applyBgmGate()
    },

    setSettings(next) {
      settings = { ...next }
      synth.applySettings({ muted: next.muted, volume: next.volume, musicOn: next.bgmEnabled })
      applyBgmGate()
    },

    getSettings: () => ({ ...settings }),

    playEvents(events, viewer) {
      const who = viewer ?? 'P1'
      for (const event of events) {
        try {
          synth.play(resolveEventSound(event, who))
        } catch (error) {
          // 单条事件音失败只跳过本条，绝不炸对局（也不中断同批后续事件）
          console.error('[siliconcard-audio] 事件音效失败（已跳过）', event.type, error)
        }
      }
    },

    uiClick() {
      try {
        synth.play(UI_CLICK)
      } catch {
        // UI 音失败静默
      }
    },

    unlock: () => synth.unlock(),
    isAvailable: () => synth.available,
  }

  return director
}

// —— 模块级单例（App 全程一个音频上下文；HMR/测试可重置） ——

let singleton: AudioDirector | null = null

/** 应用挂载时调用一次；返回卸载清理函数 */
export function initAudio(wiring: AudioWiring): () => void {
  if (!singleton) singleton = createAudioDirector()
  singleton.start(wiring)
  return () => singleton?.stop()
}

/** 事件口/对局屏等处取用；未初始化时为 null（一切调用方可选链安全） */
export function getAudioDirector(): AudioDirector | null {
  return singleton
}

/** 测试隔离：停掉并清空单例 */
export function resetAudioForTests(): void {
  singleton?.stop()
  singleton = null
}
