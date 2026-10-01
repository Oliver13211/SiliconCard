/**
 * 对局状态契约 —— GameState 必须始终是可 JSON 序列化的纯数据（架构铁律 1）。
 */

import type { CardId, FactionId, HandCardUid, InstanceId, Keyword } from './cards'
import type { PlayerId } from './actions'

// PlayerId / TargetRef 随状态类型一并对外导出（engine.ts 等从 state 统一引用）
export type { PlayerId, TargetRef } from './actions'

export type GamePhase = 'main' | 'ended'

export interface DeckEntry {
  cardId: CardId
}

export interface HandCard {
  uid: HandCardUid
  cardId: CardId
  /** 当前生效功耗（受光环/费用修正影响） */
  cost: number
}

export interface GraveEntry {
  instanceId: InstanceId
  cardId: CardId
}

/** 场上单位（显卡随从实例） */
export interface BoardUnit {
  instanceId: InstanceId
  cardId: CardId
  ownerId: PlayerId
  attack: number
  health: number
  maxHealth: number
  keywords: Keyword[]
  /** 入场的回合号（召唤失调判定用） */
  summonedOnTurn: number
  /** 本回合剩余攻击次数（windfury = 2） */
  attacksRemaining: number
  /** 本回合是否已攻击过（stealth 判定：未攻击不可被敌方指定） */
  attackedThisTurn: boolean
}

export interface PlayerState {
  id: PlayerId
  faction: FactionId
  heroName: string
  /** 体质（当前血量） */
  health: number
  maxHealth: number
  /** 护甲（能效比等技能获得，先于血量扣减） */
  armor: number
  /** 本回合剩余可用功耗 */
  mana: number
  /** 当前供电上限（随自身回合数增长，至 MAX_MANA） */
  maxMana: number
  /** 下回合被跳闸（overload）锁定的功耗 */
  lockedMana: number
  /** 牌库，抽牌从头部（index 0）取 */
  deck: readonly DeckEntry[]
  hand: readonly HandCard[]
  graveyard: readonly GraveEntry[]
  /** 已触发疲劳的次数 */
  fatigue: number
  heroPowerUsed: boolean
}

/**
 * 完整对局状态。确定性铁律：seed + 动作序列唯一决定本结构的一切取值；
 * rng.state 随状态一起序列化，是回放/联机同步的根基。
 */
export interface GameState {
  /** 全局回合号，从 1 开始，每次 END_TURN +1 */
  turn: number
  activePlayer: PlayerId
  phase: GamePhase
  players: Record<PlayerId, PlayerState>
  /** 全场单位，按入场顺序 */
  board: readonly BoardUnit[]
  nextInstanceId: number
  /** 引擎 PRNG 状态（mulberry32，见 rules.md §11） */
  rng: { readonly state: number }
  winner: PlayerId | null
  endReason: 'health_zero' | 'concede' | null
}

// —— 视角裁剪（联机 / 外部 Agent 只可见的信息，见 rules.md §10） ——

export interface PublicPlayerState {
  id: PlayerId
  faction: FactionId
  heroName: string
  health: number
  maxHealth: number
  armor: number
  mana: number
  maxMana: number
  handSize: number
  deckSize: number
  graveyardSize: number
  fatigue: number
  heroPowerUsed: boolean
}

export interface SelfPlayerState extends PublicPlayerState {
  hand: readonly HandCard[]
}

export interface PlayerView {
  viewer: PlayerId
  turn: number
  phase: GamePhase
  activePlayer: PlayerId
  winner: PlayerId | null
  you: SelfPlayerState
  opponent: PublicPlayerState
  board: readonly Readonly<BoardUnit>[]
}

// —— 开局 ——

export interface DeckSpec {
  cards: readonly { cardId: CardId; count: number }[]
}

export interface PlayerSetup {
  id: PlayerId
  faction: FactionId
  heroName?: string
  deck: DeckSpec
}

export interface GameSetup {
  seed: number
  players: readonly [PlayerSetup, PlayerSetup]
}
