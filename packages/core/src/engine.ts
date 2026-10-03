/**
 * 无头引擎接口 —— core 唯一对外契约（架构铁律 3：一切经 initGame / applyAction /
 * getLegalActions / viewFor 四个函数；UI/AI/网络不得绕过）。
 * 实现属 M1-ENG1..7。
 */

import type { Action } from './types/actions'
import type { GameEvent } from './types/events'
import type { GameSetup, GameState, PlayerId, PlayerView } from './types/state'

export type RuleErrorCode =
  | 'GAME_ENDED'
  | 'NOT_YOUR_TURN'
  | 'UNKNOWN_ACTION'
  | 'CARD_NOT_IN_HAND'
  | 'INSUFFICIENT_MANA'
  | 'INVALID_TARGET'
  | 'UNIT_NOT_ON_BOARD'
  | 'UNIT_CANNOT_ATTACK'
  | 'TAUNT_BLOCKING'
  | 'BOARD_FULL'
  | 'DECK_INVALID'
  // —— M1-ENG7 additive 扩容（契约评审授权项，见 M1-ENG5/ENG7 汇报与 rules.md §3/§4）——
  /** 本回合派系技能已使用（每回合限一次）；替换 ENG5 对 INVALID_TARGET 的语义借位 */
  | 'HERO_POWER_USED'
  /** 开局校验：玩家 faction 未注册派系技能（宿主需先 registerFactionSkills）；替换 DECK_INVALID 借位 */
  | 'FACTION_UNREGISTERED'

/** 非法动作/规则冲突——错误信息必须可指导调用方（UI 提示、Agent 重试）自行纠正 */
export class RuleError extends Error {
  constructor(
    readonly code: RuleErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`[${code}] ${message}`)
    this.name = 'RuleError'
  }
}

export interface EngineResult {
  state: GameState
  events: readonly GameEvent[]
}

export interface Engine {
  /** 开局：按 seed 与双方卡组构建初始状态（发牌、确定先手） */
  initGame(setup: GameSetup): GameState
  /** 结算一个合法动作；非法抛 RuleError。返回新状态与事件流 */
  applyAction(state: Readonly<GameState>, action: Action): EngineResult
  /** 指定玩家的全部合法动作（AI / Agent / UI 可交互性共用） */
  getLegalActions(state: Readonly<GameState>, playerId: PlayerId): readonly Action[]
  /** 视角裁剪：隐藏对手手牌内容、牌库顺序与 rng 状态 */
  viewFor(state: Readonly<GameState>, playerId: PlayerId): PlayerView
}
