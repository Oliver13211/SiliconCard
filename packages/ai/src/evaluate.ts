/**
 * 局面评估（纯函数，M1-AI1 启发式的价值标尺）。
 *
 * 只消费 PlayerView（视角裁剪后的公开信息）与卡牌定义注册表（公开游戏数据，
 * 等价于「玩家读得到自己手牌与场上单位的牌面」），不触碰完整 GameState。
 *
 * 评分语义：返回值从 view.you（决策者）视角出发，越大越好。
 * 量纲约定：1 点攻击 / 1 点血 / 1 点 CPU 体质 ≈ 1 分；100W 功耗 ≈ 0.4 分。
 * 精度刻意保持粗粒度——启发式不需要精确，只需要方向正确且可复现（全整数运算
 * + 固定小数权重，无平台相关的浮点分歧风险）。
 */

import type { BoardUnit, Keyword, PlayerView } from '@siliconcard/core'

/** 关键词价值加成（梗化关键词 → 启发式分值；overload 是负面词） */
export const KEYWORD_SCORE: Readonly<Record<Keyword, number>> = {
  taunt: 1, // 信仰充值：逼对手先解我
  divine_shield: 2, // 三年质保：白嫖一次伤害
  charge: 1, // 超频：入场即攻
  windfury: 2, // 双芯 GPU：双倍攻击预算
  deathrattle: 1, // 蓝屏/传家宝：死后留遗产
  stealth: 1, // 无输出亮机：先手权保护
  overload: -1, // 跳闸：下回合锁功耗
}

/** 手牌优势权重（每张） */
export const HAND_CARD_WEIGHT = 0.4
/** 牌库优势权重（每张，疲劳战 tiebreak） */
export const DECK_CARD_WEIGHT = 0.05
/** 未耗功耗惩罚（每 100W）——驱动「功耗曲线填充优先」 */
export const UNSPENT_MANA_WEIGHT_PER_100 = 0.4
/** 疲劳权重（每层） */
export const FATIGUE_WEIGHT = 3

/** 场上单位价值 = 攻 + 当前血 + 关键词加成（当前血：残血单位天然贬值） */
export function unitScore(unit: Pick<BoardUnit, 'attack' | 'health' | 'keywords'>): number {
  let score = unit.attack + unit.health
  for (const keyword of unit.keywords) score += KEYWORD_SCORE[keyword]
  return score
}

/** 关键词总加成（独立导出便于单测） */
export function keywordBonus(keywords: readonly Keyword[]): number {
  let bonus = 0
  for (const keyword of keywords) bonus += KEYWORD_SCORE[keyword]
  return bonus
}

/**
 * 全局局面评估（决策者视角）。
 *
 * 组成：CPU 体质差 + 场面单位价值差 + 手牌/牌库优势 + 疲劳差 + 未耗功耗惩罚。
 * 未耗功耗惩罚只对当前行动方生效（出牌阶段结束 mana 重置，跨回合不持有），
 * 效果是「出牌比攥着功耗多拿 0.4/100W 的隐性收益」，实现曲线填充偏好。
 */
export function evaluateView(view: PlayerView): number {
  let score = view.you.health + view.you.armor - view.opponent.health - view.opponent.armor
  for (const unit of view.board) {
    const value = unitScore(unit)
    score += unit.ownerId === view.you.id ? value : -value
  }
  score += HAND_CARD_WEIGHT * (view.you.hand.length - view.opponent.handSize)
  score += DECK_CARD_WEIGHT * (view.you.deckSize - view.opponent.deckSize)
  score += FATIGUE_WEIGHT * (view.opponent.fatigue - view.you.fatigue)
  if (view.activePlayer === view.you.id) {
    score -= UNSPENT_MANA_WEIGHT_PER_100 * (view.you.mana / 100)
  }
  return score
}
