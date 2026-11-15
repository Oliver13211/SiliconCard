/**
 * 电费抵扣券（P2-ENG1 先手平衡，docs/phase2-plan.md §P2-ENG1）—— 引擎内建特殊卡。
 *
 * 机制（用户拍板，量纲不得更改）：
 * - 后手玩家（opponentOf(FIRST_PLAYER)，即 P2）在 initGame 起手阶段**额外**获得
 *   一张电费抵扣券：一次性卡，打出后本回合供电 +VOUCHER_BONUS（300W，可超
 *   MAX_MANA 上限）；不占 30 张卡组名额（起手照旧 3 张 + 券）、不经牌库
 *   （不可被抽牌复制、洗牌不涉及、永不进牌库）；
 * - **过期**（rules.md §2.1/§2.5）：券仅在其持有者的第 1 个自身回合内可用，
 *   该回合结束仍未打出即失效消失（移出手牌、不进墓地、无任何结算效果）。
 *   失效先于手牌超限烧牌结算——券在任何 burnExcessHand 场景前已离手；
 * - **旧回放兼容（uid 隔离，P2-ENG1 定稿）**：手牌（h 前缀）与场上实例（u 前缀）
 *   共用 nextInstanceId 全局游标；券若占用游标会使旧录制回放的后续全部 uid
 *   后移、ATTACK/PLAY_CARD 逐动作重放即断。故券 uid 用独立常量 VOUCHER_UID
 *   （'vc1'，v 命名空间），全局游标序列与一期引擎逐字节一致；
 * - **发放事件**：并入 CARD_DRAWN 加 source:'coin_grant'（事件目录维持 17 种，
 *   定稿理由见 types/events.ts 注释）；发放时点在常规起手发牌之后、GAME_START
 *   之前，与 GAME_START/首个 TURN_START 同属 initGame 开局语义时点（initGame
 *   不携带事件流的签名裁决不变，消费方按 rules.md §6 从初始视图确定性合成）。
 *
 * 注册模式与内置派系技能同款：模块加载即自动注册进卡牌定义注册表，
 * 宿主 import core 即生效；content 包无此卡，后写覆盖风险不存在。
 */

import { VOUCHER_BONUS, VOUCHER_CARD_ID, VOUCHER_UID } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { GameState, HandCard, PlayerId } from '../types/state'
import { registerCardDefinitions, getCardDefinition } from './registry'
import { applyHandCosts } from './aura'
import { ownTurnNumber } from './turn'

/**
 * 券定义：type 取 'driver'（出牌即结算、不占扩展槽、不可攻击——与"一次性卡"
 * 语义完全贴合）；cost 0（打出零功耗，+300W 为净增益）；效果走既有原语组合
 * （gainMana，第 13 原语），无一次性逻辑。
 * art 为展示参数（引擎不消费）：金色 palette（phase2-plan「显示金色」）、
 * shape 'voucher' 不在已知形体表——客户端 pickShapeKind 对未知 shape 确定性
 * 映射到既有形体，属数据驱动扩展通道（CardFace.ts 契约）。
 */
export const VOUCHER_DEFINITION: CardDefinition = {
  id: VOUCHER_CARD_ID,
  name: '电费抵扣券',
  faction: 'neutral',
  type: 'driver',
  cost: 0,
  effect: {
    trigger: 'onPlay',
    steps: [{ op: 'gainMana', player: 'sourceOwner', amount: VOUCHER_BONUS }],
  },
  rarity: 'rare',
  flavor: '后开工的电力补偿：这 300W 是电网欠你的，本回合不用就作废——摸鱼也是要交电费的。',
  art: { shape: 'voucher', palette: '#f7c948', glow: '#fff3c4' },
}

/** 券定义是否已注册（测试隔离断言用） */
export function isVoucherRegistered(): boolean {
  return getCardDefinition(VOUCHER_CARD_ID) !== undefined
}

let registered = false

/** 幂等注册：模块加载与 clearCardDefinitions 后的测试恢复共用 */
export function registerVoucherDefinition(): void {
  if (registered) return
  registerCardDefinitions([VOUCHER_DEFINITION])
  registered = true
}

/** 测试隔离辅助：clearCardDefinitions 后强制重注册（供 voucher 单测使用） */
export function resetVoucherDefinition(): void {
  registered = false
  registerVoucherDefinition()
}

// 模块加载即注册（与 engine/factions.ts 内置派系技能同模式）
registerVoucherDefinition()

/**
 * 起手阶段向后手玩家发放券（initGame 专用，P2-ENG1）：
 * - 追加在常规起手发牌**之后**（手牌序 = 3 张起手 + 券）；
 * - uid 取独立命名空间常量 VOUCHER_UID，**不消耗** nextInstanceId 全局游标
 *   （旧回放兼容的关键不变量：init 后 nextInstanceId 仍 = 2×OPENING_HAND_SIZE+1）；
 * - 发 CARD_DRAWN{source:'coin_grant'} 恰一次（开局内部事件序列）；
 * - 手牌上限由常量不变量保证（OPENING_HAND_SIZE + 1 < HAND_LIMIT），无需烧牌路径。
 */
export function grantVoucherToPlayer(state: GameState, playerId: PlayerId, events: GameEvent[]): void {
  const player = state.players[playerId]
  const card: HandCard = { uid: VOUCHER_UID, cardId: VOUCHER_CARD_ID, cost: VOUCHER_DEFINITION.cost }
  player.hand = [...player.hand, card]
  applyHandCosts(state) // 手牌集合变化纪律（aura.ts）：cost 光环对券同样绝对重算
  events.push({ type: 'CARD_DRAWN', playerId, cardId: VOUCHER_CARD_ID, source: 'coin_grant' })
}

/**
 * 回合结束的券过期结算（apply.ts END_TURN 分支专用，先于胜负判定与手牌烧牌）：
 * 行动方处于自身第 1 个回合且手牌中仍有券 → 移除并发 CARD_BURNED{reason:'voucher_expired'}。
 * 门槛（自身第 1 回合）在函数内部判定——先手方与第 2+ 回合调用均无事发生；
 * 过期先于 checkGameEnd：回合以终局收尾时券同样视为已过期离手（终局状态与
 * 一期引擎对齐，旧回放兼容面最大化）。券不进墓地（过期非死亡、无结算效果）。
 * 返回是否发生了过期（供测试断言；引擎内其余调用方忽略返回值）。
 */
export function expireUnplayedVouchers(state: GameState, playerId: PlayerId, events: GameEvent[]): boolean {
  if (ownTurnNumber(state.turn, playerId) !== 1) return false
  const player = state.players[playerId]
  const remaining = player.hand.filter((card) => card.cardId !== VOUCHER_CARD_ID)
  if (remaining.length === player.hand.length) return false
  player.hand = remaining
  applyHandCosts(state) // 手牌集合变化纪律（aura.ts）
  events.push({ type: 'CARD_BURNED', playerId, cardId: VOUCHER_CARD_ID, reason: 'voucher_expired' })
  return true
}
