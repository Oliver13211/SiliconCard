/**
 * BattleDriver —— 引擎唯一事实源的持有封装（M1-UI1..3）。
 *
 * 职责边界（架构铁律 3）：
 * - 完整 GameState 只在本模块内流转，zustand store / 组件只拿 viewFor 视图、
 *   getLegalActions 合法动作与 GameEvent 事件流，禁止自维护对局事实；
 * - initGame 不携带事件流（rules.md §2.1 签名裁决）：GAME_START 与首个 TURN_START
 *   由本模块按初始 state 合成（§6：无信息增量，字段齐备）；
 * - 回放录制（P2-INF1）：对局中静默累积 seed + 卡组 + 动作序列，GAME_END 时经
 *   setMatchRecordingSink 注册的回调一次性交付（复用 core ReplayRecording 契约），
 *   录制全程零 UI 依赖、异常静默。
 */

import {
  createEngine,
  FIRST_PLAYER,
  type Action,
  type Engine,
  type GameEvent,
  type GameSetup,
  type GameState,
  type PlayerId,
  type PlayerView,
  type ReplayRecording,
} from '@siliconcard/core'
import type { AiPlayer } from '@siliconcard/ai'
import type { ReplaySource } from '../replay/types'

export interface DispatchReport {
  view: PlayerView
  legalActions: readonly Action[]
  events: readonly GameEvent[]
}

export interface OpeningReport extends DispatchReport {
  openingEvents: readonly GameEvent[]
}

/**
 * 一局完整对局的录制交付物（P2-INF1）：对局中静默累积，
 * GAME_END 时经 sink 一次性交出——语义与 core 黄金回放 ReplayRecording 完全同构
 * （seed + 双方卡组 + 动作序列），外加落库所需的元数据字段。
 */
export interface MatchRecording {
  /** 黄金回放录制体：重驱引擎的唯一输入（确定性保证逐帧一致） */
  recording: ReplayRecording
  /** 录制时本端视角（结算胜负用） */
  viewer: PlayerId
  /** 终局信息（来自 GAME_END 事件，§9 保证最后一条且恰好一次） */
  winner: PlayerId | null
  reason: 'health_zero' | 'concede' | null
  /** 终局回合数（引擎 state.turn） */
  turns: number
  startedAt: number
  endedAt: number
  /** 对局来源（本地人机=local；联机录制由联机线接入后上报） */
  source?: ReplaySource
}

export type MatchRecordingSink = (match: MatchRecording) => void

let engineInstance: Engine | null = null

/**
 * 录制 sink（P2-INF1）：driver 不关心存储细节，AppRoot 注入落库回调。
 * 模块级注册而非实例属性——gameStore 内的 driver 实例不外泄（铁律 3），
 * sink 经此注入即可覆盖所有 driver 实例；置 null 即整体关闭录制。
 */
let matchRecordingSink: MatchRecordingSink | null = null

export function setMatchRecordingSink(sink: MatchRecordingSink | null): void {
  matchRecordingSink = sink
}

function engine(): Engine {
  engineInstance ??= createEngine()
  return engineInstance
}

export class BattleDriver {
  private state: GameState | null = null
  private readonly viewerId: PlayerId
  /** 进行中的录制（仅在 sink 注册时开启）；GAME_END 落盘后置空 */
  private recording: { seed: number; players: GameSetup['players']; actions: Action[]; startedAt: number } | null = null

  constructor(viewer: PlayerId = FIRST_PLAYER) {
    this.viewerId = viewer
  }

  /** 开局：构建初始状态 + 合成开局事件（§2.1/§6） */
  start(setup: GameSetup): OpeningReport {
    const state = engine().initGame(setup)
    this.state = state
    this.recording = matchRecordingSink
      ? { seed: setup.seed, players: setup.players, actions: [], startedAt: Date.now() }
      : null
    const active = state.players[state.activePlayer]
    const openingEvents: GameEvent[] = [
      { type: 'GAME_START', seed: setup.seed, firstPlayer: state.activePlayer },
      {
        type: 'TURN_START',
        turn: state.turn,
        playerId: state.activePlayer,
        maxMana: active.maxMana,
        drawCount: 0,
      },
    ]
    return {
      openingEvents,
      events: openingEvents,
      view: engine().viewFor(state, this.viewerId),
      legalActions: engine().getLegalActions(state, this.viewerId),
    }
  }

  /** 结算一个动作；非法动作原样抛出 RuleError，状态保持不变（引擎保证） */
  dispatch(action: Action): DispatchReport {
    if (!this.state) throw new Error('对局尚未开始，不能结算动作')
    const { state, events } = engine().applyAction(this.state, action)
    this.state = state
    const report = {
      events,
      view: engine().viewFor(state, this.viewerId),
      legalActions: engine().getLegalActions(state, this.viewerId),
    }
    this.observeRecording(action, events)
    return report
  }

  /**
   * 录制观察（P2-INF1，静默）：成功结算的动作追加入录制体；遇 GAME_END
   * （§9：最后一条且恰好一次）向 sink 交付并关闭本次录制。sink 异常一律
   * 吞掉（回放落库是副业，绝不影响对局本身）。
   */
  private observeRecording(action: Action, events: readonly GameEvent[]): void {
    const rec = this.recording
    if (!rec || !matchRecordingSink) return
    rec.actions.push(action)
    const end = events.find((event): event is Extract<GameEvent, { type: 'GAME_END' }> => event.type === 'GAME_END')
    if (!end) return
    this.recording = null
    try {
      matchRecordingSink({
        recording: { seed: rec.seed, players: rec.players, actions: rec.actions },
        viewer: this.viewerId,
        winner: end.winner,
        reason: end.reason,
        turns: this.state?.turn ?? 0,
        startedAt: rec.startedAt,
        endedAt: Date.now(),
      })
    } catch (error) {
      console.warn('[siliconcard-replay] 回放落库失败（静默处理，不影响对局）', error)
    }
  }

  /** 指定玩家的合法动作（仍走引擎公开接口） */
  legalActionsFor(playerId: PlayerId): readonly Action[] {
    if (!this.state) return []
    return engine().getLegalActions(this.state, playerId)
  }

  /**
   * 托管 AI 决策入口（M1-AI1 接线）：完整 state 不出本模块，AI 经 core
   * 公开接口自行观察（防作弊封印闸门在 @siliconcard/ai 内）。
   */
  aiActionFor(playerId: PlayerId, ai: AiPlayer): Action | null {
    if (!this.state || this.isEnded()) return null
    return ai.decideNextAction(engine(), this.state)
  }

  view(): PlayerView | null {
    if (!this.state) return null
    return engine().viewFor(this.state, this.viewerId)
  }

  isEnded(): boolean {
    return this.state?.phase === 'ended'
  }

  get viewer(): PlayerId {
    return this.viewerId
  }

  reset(): void {
    this.state = null
    this.recording = null // 中途弃局不落库（只录制打完的对局）
  }
}
