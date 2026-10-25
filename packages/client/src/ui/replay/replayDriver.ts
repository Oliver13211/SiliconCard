/**
 * ReplayDriver —— 回放重驱内核（P2-UI3，无头纯逻辑，测试直测）。
 *
 * 重驱方案（任务书交付 1）：录制体是 seed + 双方卡组 + 动作序列（core 契约，
 * 确定性保证逐帧一致），本模块 initGame → 逐步 applyAction 一次性快放重建：
 * - states[k] = 第 k 个动作结算后的完整 GameState（states[0] = 开局初始态），
 *   加载时预计算——seek 语义仍是「引擎从头快放至目标事件」，只是把快放
 *   提前到加载时一次做完（引擎毫秒级重放，结果完全等价，seek 变 O(1)）；
 * - 开局事件（GAME_START + 首个 TURN_START）按 battleDriver.start 同一裁决
 *   合成（rules.md §2.1/§6，复用 synthesizeOpeningEvents）；
 * - 卡池漂移时某个动作可能非法（RuleError）：重驱在该处截断并记 driveError——
 *   播放器据此亮「与当前卡池版本不符」横幅、只读开放已重驱部分（不崩不假播）。
 *
 * 上帝视角（任务书交付 3，不改 core）：viewFor 会裁剪对手手牌（铁律 3 的
 * 对局期语义），回放是复盘场景、录制体本就含全部信息——用重驱出的完整
 * GameState 对 P1/P2 各取一份官方视角切片，UI 侧组合两份切片即双方手牌
 * 全量可见。切片全部出自引擎 viewFor，无第二套视图逻辑。
 */

import {
  createEngine,
  getCardDefinition,
  stableHash,
  RuleError,
  type Engine,
  type GameEvent,
  type GameState,
  type PlayerView,
  type ReplayRecording,
} from '@siliconcard/core'
import { eventsToLogEntries, type LogEntry } from '../game/eventLog'
import { synthesizeOpeningEvents } from '../game/opening'

/** 关键事件标记种类（时间轴着色点，任务书交付 2） */
export type ReplayMarkerKind = 'attack' | 'summon' | 'legendary' | 'trip' | 'end'

export const MARKER_LABEL: Record<ReplayMarkerKind, string> = {
  attack: '攻击',
  summon: '召唤',
  legendary: '传说入场',
  trip: '跳闸',
  end: '终局',
}

export interface ReplayKeyMarker {
  /** 事件下标（0 起）；跳转 = 播放到该事件（cursor = eventIndex + 1） */
  eventIndex: number
  kind: ReplayMarkerKind
}

export interface ReplayTimeline {
  events: readonly GameEvent[]
  /** states[k] = 第 k 个动作结算后的完整状态；states[0] = 开局初始态 */
  states: readonly GameState[]
  /** eventIndex → 该事件所属批次终态的 states 下标（开局事件 → 0） */
  stateIndexOfEvent: readonly number[]
  markers: readonly ReplayKeyMarker[]
  /** 与 events 一一对应的战报条目（个别事件不进战报 → null 占位） */
  log: readonly (LogEntry | null)[]
  /** 成功重驱的事件总数（卡池漂移截断时 < 全量） */
  drivableEventCount: number
  /** 重驱失败原因（null = 完整重驱成功；非 null 即「与当前卡池版本不符」） */
  driveError: string | null
  /** 终态 stableHash（回归校验与 golden 对齐用） */
  finalStateHash: string
}

/** 引擎单例：无状态纯函数集（createEngine 只装配四函数），全播放器共享一份 */
let engineInstance: Engine | null = null

export function replayEngine(): Engine {
  engineInstance ??= createEngine()
  return engineInstance
}

function markerOf(event: GameEvent): ReplayMarkerKind | null {
  switch (event.type) {
    case 'ATTACK_DECLARED':
      return 'attack'
    case 'MINION_SUMMONED':
      return event.source === 'play' ? 'summon' : null
    case 'CARD_PLAYED':
      return getCardDefinition(event.cardId)?.rarity === 'legendary' ? 'legendary' : null
    case 'BURN_OUT':
      return 'trip'
    case 'GAME_END':
      return 'end'
    default:
      return null
  }
}

/**
 * 一次性快放录制体构建播放时间轴（见模块头注释）。
 * 任何动作结算失败即截断（已成功的部分照常可播），不抛出。
 */
export function buildReplayTimeline(recording: ReplayRecording): ReplayTimeline {
  const engine = replayEngine()
  const setup = { seed: recording.seed, players: recording.players }

  let state: GameState
  try {
    state = engine.initGame(setup)
  } catch (error) {
    return {
      events: [],
      states: [],
      stateIndexOfEvent: [],
      markers: [],
      log: [],
      drivableEventCount: 0,
      driveError: `开局重建失败（与当前卡池版本不符）：${error instanceof Error ? error.message : String(error)}`,
      finalStateHash: '',
    }
  }

  const states: GameState[] = [state]
  const events: GameEvent[] = []
  const stateIndexOfEvent: number[] = []
  const markers: ReplayKeyMarker[] = []

  // 开局事件合成（与 BattleDriver.start 同一 §2.1/§6 裁决）：归属初始态批次
  const opening = synthesizeOpeningEvents(engine.viewFor(state, 'P1'), recording.seed)
  for (const event of opening) {
    events.push(event)
    stateIndexOfEvent.push(0)
  }

  let driveError: string | null = null
  for (let actionIndex = 0; actionIndex < recording.actions.length; actionIndex += 1) {
    const action = recording.actions[actionIndex] as (typeof recording.actions)[number]
    try {
      const result = engine.applyAction(state, action)
      state = result.state
      states.push(state)
      const stateIndex = states.length - 1
      for (const event of result.events) {
        const eventIndex = events.length
        events.push(event)
        stateIndexOfEvent.push(stateIndex)
        const kind = markerOf(event)
        if (kind) markers.push({ eventIndex, kind })
      }
    } catch (error) {
      const reason = error instanceof RuleError ? error.message : String(error)
      driveError = `第 ${actionIndex + 1}/${recording.actions.length} 个动作无法重放（与当前卡池版本不符）：${reason}`
      break
    }
  }

  // 战报逐事件预生成：描述目标用的视图取该事件批次终态（与对局 eventsToLogEntries 同参语义）
  const log = events.map((event, eventIndex) => {
    const view = engine.viewFor(states[stateIndexOfEvent[eventIndex] as number] as GameState, 'P1')
    return eventsToLogEntries(view, [event])[0] ?? null
  })

  return {
    events,
    states,
    stateIndexOfEvent,
    markers,
    log,
    drivableEventCount: events.length,
    driveError,
    finalStateHash: states.length > 0 ? stableHash(states[states.length - 1] as GameState) : '',
  }
}

// —— 光标几何（cursor = 已播放事件数，0..events.length） ——

/** 播放光标所在批次的 states 下标（HUD 视图 / 3D 对账都用它） */
export function stateIndexForCursor(timeline: ReplayTimeline, cursor: number): number {
  if (cursor <= 0) return 0
  const index = timeline.stateIndexOfEvent[cursor - 1]
  return index ?? 0
}

/** 某批次对应的全部事件（对局中一批 = 一次 applyAction 的事件流，3D 演出以批为单位） */
export function eventsOfStateIndex(timeline: ReplayTimeline, stateIndex: number): GameEvent[] {
  const batch: GameEvent[] = []
  for (let i = 0; i < timeline.events.length; i += 1) {
    if (timeline.stateIndexOfEvent[i] === stateIndex) batch.push(timeline.events[i] as GameEvent)
  }
  return batch
}

// —— 上帝视角切片（不改 core：两份官方 viewFor 切片，UI 侧组合） ——

export interface ReplaySlices {
  p1: PlayerView
  p2: PlayerView
}

/** 对重驱出的完整状态取 P1/P2 双官方视角切片——双方手牌全量可见的依据 */
export function replaySlicesOf(state: GameState): ReplaySlices {
  const engine = replayEngine()
  return { p1: engine.viewFor(state, 'P1'), p2: engine.viewFor(state, 'P2') }
}
