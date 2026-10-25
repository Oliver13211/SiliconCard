/**
 * ReplayPlayerStore —— 回放播放器的页面级 zustand store（P2-UI3）。
 *
 * 职责边界（架构铁律 3）：
 * - 重驱事实全部来自 replayDriver（引擎逐步 applyAction 的产物），本 store 只持有
 *   时间轴光标（已播放事件数）与两份官方 viewFor 切片的投影，不自维护对局事实；
 * - 上帝视角 = replaySlicesOf 对重驱完整状态的 P1/P2 双切片组合（复盘语义，
 *   区别于对局期 viewFor 裁剪），不触碰 core；
 * - 3D 演出/音效经 onReplayFrames 帧通道接入（与 gameStore.onBattleEvents 同构：
 *   每帧先 syncView 对账再 enqueueEvents 播放），本 store 不 import three；
 * - 光标推进单位 = 单个引擎事件；3D 演出单位 = 批次（一次 applyAction 的事件流，
 *   与对局演出同粒度）——批次内步进只刷新 HUD/战报，不重复触发演出。
 */

import { create } from 'zustand'
import { REPLAY_SCHEMA_VERSION, type GameEvent, type PlayerView, type ReplayRecording } from '@siliconcard/core'
import {
  buildReplayTimeline,
  eventsOfStateIndex,
  replaySlicesOf,
  stateIndexForCursor,
  type ReplayTimeline,
} from './replayDriver'
import type { ReplayMeta } from './types'
import { useReplayStore } from './replayStore'

export type ReplaySpeed = 0.5 | 1 | 2 | 4

export const REPLAY_SPEEDS: readonly ReplaySpeed[] = [0.5, 1, 2, 4]

/** 1× 下单个事件的基准播放间隔（ms）；3D 批次演出在其内自行走完 */
export const REPLAY_EVENT_INTERVAL_MS = 1100

/** 3D/音效帧：view 恒为 P1 切片（3D 牌桌坐 P1 位）；events 为该批事件（对账帧为 null） */
export interface ReplayFrame {
  view: PlayerView
  events: readonly GameEvent[] | null
}

const frameListeners = new Set<(frame: ReplayFrame) => void>()

/** 3D/音效线订阅口（ReplayTable3D 挂载时订阅，返回退订函数） */
export function onReplayFrames(listener: (frame: ReplayFrame) => void): () => void {
  frameListeners.add(listener)
  return () => {
    frameListeners.delete(listener)
  }
}

function emitFrame(frame: ReplayFrame): void {
  for (const listener of frameListeners) listener(frame)
}

interface ReplayPlayerStore {
  status: 'idle' | 'ready'
  meta: ReplayMeta | null
  timeline: ReplayTimeline | null
  /** 已播放事件数（0..events.length）——时间轴/战报联动/3D 帧的唯一游标 */
  cursor: number
  playing: boolean
  speed: ReplaySpeed
  /** 「与当前卡池版本不符」横幅文案（null = 校验通过） */
  versionNotice: string | null
  /** 光标处的双方官方切片（上帝视角的 UI 投影；P1 切片同时喂 3D） */
  viewP1: PlayerView | null
  viewP2: PlayerView | null

  /** 挂载时装载：一次性快放重建时间轴并自动开播 */
  load: (meta: ReplayMeta, body: ReplayRecording) => void
  play: () => void
  pause: () => void
  togglePlay: () => void
  setSpeed: (speed: ReplaySpeed) => void
  cycleSpeed: () => void
  /** 逐事件步进（自动先暂停） */
  stepForward: () => void
  /** seek：跳到「已播放 cursor 个事件」处（引擎从头快放的预计算态，幂等） */
  seekToCursor: (cursor: number) => void
  /** 播放节拍：推进一个事件（到尾自动停）；屏幕的 setInterval 每拍调用 */
  advance: () => void
  /** 退出播放器：停播清场并回回放库屏 */
  exit: () => void
}

/** 批次演出去重：同一批次只在首个事件处触发一次演出帧（对局演出同粒度） */
let lastAnimatedStateIndex = -1

function clampCursor(timeline: ReplayTimeline, cursor: number): number {
  return Math.max(0, Math.min(cursor, timeline.events.length))
}

export const useReplayPlayerStore = create<ReplayPlayerStore>()((set, get) => {
  /** 光标落地：刷新双方切片投影 + 视情况发 3D 帧（animate=false 为 seek 对账帧） */
  function publish(cursor: number, animate: boolean): void {
    const timeline = get().timeline
    if (!timeline || timeline.states.length === 0) return
    const safe = clampCursor(timeline, cursor)
    const stateIndex = stateIndexForCursor(timeline, safe)
    const slices = replaySlicesOf(timeline.states[stateIndex] as GameStateLike)
    if (animate) {
      if (stateIndex === lastAnimatedStateIndex) {
        // 批次内步进：只刷 HUD/战报，不打断进行中的演出（中途 syncView 会让实体瞬移）
        set({ cursor: safe, viewP1: slices.p1, viewP2: slices.p2 })
        return
      }
      lastAnimatedStateIndex = stateIndex
      set({ cursor: safe, viewP1: slices.p1, viewP2: slices.p2 })
      emitFrame({ view: slices.p1, events: eventsOfStateIndex(timeline, stateIndex) })
      return
    }
    // seek：标记批次已演出（回到该批次不再补动画），发对账帧（3D syncView 收口）
    lastAnimatedStateIndex = stateIndex
    set({ cursor: safe, viewP1: slices.p1, viewP2: slices.p2 })
    emitFrame({ view: slices.p1, events: null })
  }

  return {
    status: 'idle',
    meta: null,
    timeline: null,
    cursor: 0,
    playing: false,
    speed: 1,
    versionNotice: null,
    viewP1: null,
    viewP2: null,

    load: (meta, body) => {
      const timeline = buildReplayTimeline(body)
      let versionNotice: string | null = null
      if (meta.schemaVersion !== REPLAY_SCHEMA_VERSION) {
        versionNotice = `与当前卡池版本不符（存档 schemaVersion ${meta.schemaVersion} ≠ 当前 ${REPLAY_SCHEMA_VERSION}），已只读开放`
      } else if (timeline.driveError) {
        versionNotice = `与当前卡池版本不符：${timeline.driveError}，中断处之前已只读开放`
      } else if (meta.winner !== null) {
        // 完整重驱成功再对终局：GAME_END 与落库元数据不一致同样是版本漂移信号
        const end = [...timeline.events].reverse().find((event) => event.type === 'GAME_END')
        const winner = end && end.type === 'GAME_END' ? end.winner : null
        if (winner !== meta.winner) {
          versionNotice = `与当前卡池版本不符（重放终局 ${winner ?? '平局'} 与录制时 ${meta.winner} 不一致），已只读开放`
        }
      }
      lastAnimatedStateIndex = -1
      set({ status: 'ready', meta, timeline, cursor: 0, playing: true, speed: 1, versionNotice })
      publish(0, false) // 初始对账帧（3D 摆开局）
      // 开局批次保留演出：对账帧已把 lastAnimated 标成批次 0，这里复位，
      // 首次 advance 播到开局事件时照常发一批演出帧（与对局屏挂载播开局演出同构）
      lastAnimatedStateIndex = -1
    },

    play: () => {
      const { timeline, cursor } = get()
      if (!timeline || cursor >= timeline.events.length) return
      set({ playing: true })
    },

    pause: () => set({ playing: false }),

    togglePlay: () => {
      const { playing, timeline, cursor } = get()
      if (!timeline) return
      if (playing) {
        set({ playing: false })
        return
      }
      if (cursor >= timeline.events.length) return
      set({ playing: true })
    },

    setSpeed: (speed) => set({ speed }),

    cycleSpeed: () => {
      const current = get().speed
      const index = REPLAY_SPEEDS.indexOf(current)
      const next = REPLAY_SPEEDS[(index + 1) % REPLAY_SPEEDS.length] as ReplaySpeed
      set({ speed: next })
    },

    stepForward: () => {
      const { timeline, cursor } = get()
      if (!timeline) return
      set({ playing: false })
      if (cursor >= timeline.events.length) return
      publish(cursor + 1, true)
    },

    seekToCursor: (cursor) => {
      const { timeline } = get()
      if (!timeline) return
      publish(clampCursor(timeline, cursor), false)
    },

    advance: () => {
      const { timeline, cursor } = get()
      if (!timeline) return
      if (cursor >= timeline.events.length) {
        set({ playing: false })
        return
      }
      publish(cursor + 1, true)
      if (get().cursor >= timeline.events.length) set({ playing: false })
    },

    exit: () => {
      set({ status: 'idle', timeline: null, meta: null, cursor: 0, playing: false, viewP1: null, viewP2: null, versionNotice: null })
      lastAnimatedStateIndex = -1
      useReplayStore.getState().closePlayer()
    },
  }
})

/** 播放节拍入口（屏幕的 setInterval 每拍调用） */
export function replayPlayerTick(): void {
  useReplayPlayerStore.getState().advance()
}

/** publish/tick 共用的状态形参（避免 store 文件循环依赖 core 的 GameState 类型别名） */
type GameStateLike = ReplayTimeline['states'][number]
