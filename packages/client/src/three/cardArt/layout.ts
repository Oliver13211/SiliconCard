/**
 * 卡面布局常量（卡面大改版·SVG 主体主视觉）—— 纯数据，零 DOM 依赖。
 *
 * 改版核心承诺：
 * - 中央插画窗（ART_WINDOW）是卡面主视觉：竖向占比 372/718 ≈ 51.8%（≥40%），
 *   横向占比 452/512 ≈ 88.3%，派系母题与形制骨架在此放大到「一眼可辨」；
 * - 名称/类型/关键词/flavor/攻血收敛为插画窗以外的深色边框信息带，
 *   费用徽与稀有度宝石压在插画窗上沿两角（框上层）；
 * - 全部锚点为确定性常量，供 CardFace 绘制与无头测试共同引用。
 */

import type { RarityTier } from './derive'

/** 卡面画布尺寸（约 5:7；CardFace 再导出保持既有 API） */
export const FACE_W = 512
export const FACE_H = 718

/** 中央插画窗（卡面主视觉：形制骨架 × 派系母题 × 稀有度插画区环） */
export const ART_WINDOW = { x: 30, y: 64, w: 452, h: 372, r: 20 } as const

// —— 边框信息带（插画窗以下的深色区，白字对比度安全区） ——

/** 名称基线 y（800 字重 38px） */
export const NAME_Y = 472
/** 类型行基线 y（600 字重 22px） */
export const TYPE_Y = 512
/** 关键词角标行基线 y（SVG 层圆标 r=14） */
export const KEYWORD_ROW_Y = 552
/** flavor 两行基线 y（italic 19px，最多两行截断） */
export const FLAVOR_Y1 = 592
export const FLAVOR_Y2 = 615
/** 攻/血徽圆心 y 与半径（gpu 专用） */
export const STAT_Y = 664
export const STAT_R = 38
export const STAT_X_IN = 76
export const STAT_X_OUT = 436

/** 费用徽（压在插画窗左上角，框上层） */
export const COST_BADGE = { x: 66, y: 64, r: 42 } as const
/** 稀有度宝石（压在插画窗右上角，框上层） */
export const GEM = { x: 446, y: 64, r: 15 } as const

/**
 * 稀有度宝石色（卡面宝石与插画区稀有度环同源；common 无宝石）。
 * 稀有度在插画区可读的承诺：rare 蓝 / epic 紫 / legendary 金。
 */
export const RARITY_GEM: Record<RarityTier, string | null> = {
  common: null,
  rare: '#3f9dff',
  epic: '#b45cff',
  legendary: '#ff9d2e',
}
