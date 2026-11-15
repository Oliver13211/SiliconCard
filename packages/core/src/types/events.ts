/**
 * 事件目录（v1 定稿，17 种）—— 渲染/日志/音效的唯一驱动源（架构铁律 3）。
 * 精确发出时机见 docs/rules.md §6；修改走 WF-ENGINE 并通报 client-3d / client-ui。
 */

import type { CardId, InstanceId, Keyword } from './cards'
import type { PlayerId, TargetRef } from './actions'
import type { BoardUnit } from './state'

export type DamageSource =
  | { kind: 'unit'; instanceId: InstanceId }
  | { kind: 'heroPower'; playerId: PlayerId }
  | { kind: 'effect'; ref?: string }
  | { kind: 'fatigue' }

export type GameEndReason = 'health_zero' | 'concede'

export type GameEvent =
  | { type: 'GAME_START'; seed: number; firstPlayer: PlayerId }
  | { type: 'TURN_START'; turn: number; playerId: PlayerId; maxMana: number; drawCount: number }
  | { type: 'TURN_END'; turn: number; playerId: PlayerId }
  /**
   * cardId 为 null 表示从疲劳伤害中"抽牌"（deck 已空）。
   * source 语义（P2-ENG1 additive 扩展）：'deck' 牌库抽取 / 'fatigue' 疲劳 /
   * 'coin_grant' 开局直接发放入手（电费抵扣券，不经牌库与抽牌流程）。
   * 事件目录维持 17 种定稿：新增 GameEvent 变体会强制 three/anim 与 ui/preview
   * 的 `[K in GameEvent['type']]` 全键映射表扩键（禁碰文件），故券发放并入本事件。
   */
  | { type: 'CARD_DRAWN'; playerId: PlayerId; cardId: CardId | null; source: 'deck' | 'fatigue' | 'coin_grant' }
  | { type: 'CARD_PLAYED'; playerId: PlayerId; uid: string; cardId: CardId; cost: number; target: TargetRef | null }
  /**
   * 卡牌未经打出离开手牌。reason（P2-ENG1 additive 扩展）：
   * 'hand_full' 手牌超限烧牌 / 'voucher_expired' 电费抵扣券过期作废（自身第 1 回合
   * 结束未打出；过期不进墓地、无任何结算效果，见 rules.md §2.5）。
   */
  | { type: 'CARD_BURNED'; playerId: PlayerId; cardId: CardId; reason: 'hand_full' | 'voucher_expired' }
  | { type: 'MINION_SUMMONED'; unit: BoardUnit; source: 'play' | 'effect' }
  | { type: 'MINION_DIED'; unit: BoardUnit; cause: 'damage' | 'destroy' | 'sacrifice' }
  | { type: 'ATTACK_DECLARED'; attackerId: InstanceId; target: TargetRef }
  | {
      type: 'DAMAGE_DEALT'
      source: DamageSource
      target: TargetRef
      amount: number
      /** 结算后的剩余血量（单位血量或 CPU 体质） */
      remainingHealth: number
      armorAbsorbed?: number
      shieldConsumed?: boolean
    }
  | { type: 'HEALING'; target: TargetRef; amount: number; resultingHealth: number }
  | { type: 'KEYWORD_TRIGGERED'; keyword: Keyword; instanceId: InstanceId; detail: string }
  | { type: 'HERO_POWER_USED'; playerId: PlayerId; skillId: string; target: TargetRef | null }
  | { type: 'FATIGUE'; playerId: PlayerId; fatigueCount: number; damage: number }
  /** 跳闸结算：下回合功耗被锁定 */
  | { type: 'BURN_OUT'; playerId: PlayerId; lockedMana: number }
  | { type: 'ARMOR_GAINED'; playerId: PlayerId; amount: number; totalArmor: number }
  | { type: 'GAME_END'; winner: PlayerId | null; reason: GameEndReason }
