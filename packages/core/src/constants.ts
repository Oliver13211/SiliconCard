/**
 * 数值基线（v1 定稿）—— 与 docs/rules.md §1 一一对应。
 * 调整任何常量都是规则变更，走 WF-ENGINE。
 */

/** 1v1 固定先手方 */
export const FIRST_PLAYER = 'P1' as const

/** CPU 体质上限 */
export const HERO_MAX_HEALTH = 30

/** 供电上限（W） */
export const MAX_MANA = 1000

/** 每个自身回合增长的供电（W） */
export const MANA_PER_TURN = 100

/** 手牌上限，超出即烧牌 */
export const HAND_LIMIT = 10

/** 扩展槽（场上单位上限） */
export const BOARD_LIMIT = 7

/** 标准卡组张数 */
export const DECK_SIZE = 30

/** 开局起手张数 */
export const OPENING_HAND_SIZE = 3

/** 派系技能功耗 */
export const HERO_POWER_COST = 200

/**
 * 电费抵扣券打出后的本回合供电加成（W，P2-ENG1 先手平衡，用户拍板 +300W）。
 * 唯一允许突破 MAX_MANA 上限的通道：仅作用于打出券的当回合（回合切换即随
 * beginTurn 曲线重置），其余任何路径仍不得越上限（见 rules.md §2.1/§5）。
 */
export const VOUCHER_BONUS = 40

/** 电费抵扣券的引擎内建卡牌 id（不进 content 可收集池，不占 30 张卡组名额） */
export const VOUCHER_CARD_ID = 'siliconcard-voucher'

/**
 * 电费抵扣券的手牌 uid（独立命名空间 `v` 前缀，P2-ENG1 旧回放兼容定稿）：
 * 手牌（h 前缀）与场上实例（u 前缀）共用 nextInstanceId 全局游标，券若占用
 * 该游标会使旧录制回放中的全部后续 uid 后移一格——故券使用独立常量 uid，
 * 全局游标序列与一期引擎逐字节一致，旧回放（seed+动作序列）可原样重放。
 * 每局恰发放一张（initGame 起手阶段），常量 uid 即确定性取值。
 */
export const VOUCHER_UID = 'vc1'
