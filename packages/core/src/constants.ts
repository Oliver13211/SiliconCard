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
