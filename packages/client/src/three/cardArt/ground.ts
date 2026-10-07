/**
 * 卡面底色分级（演出修正阶段二·需求 1）—— 纯函数，零 DOM 依赖。
 *
 * 用户验收反馈：派系底色偏暗偏素，要求「一眼可辨」并按稀有度分级。
 * 方案：对角渐变从「派系主色提亮版」铺起（左上角最亮），至中段压回暗色、
 * 末端近黑——派系色集中在卡面上半区与边缘，名称/类型/flavor 所在的下半
 * 文字带保持深底，白字对比度不劣化（>7:1，见 __tests__/cardGround.test.ts）。
 *
 * 稀有度四档（common 素 → legendary 浓艳）：
 * - common   ：角部派系色 45% 强度，无辉光——素但可辨；
 * - rare     ：62% + 顶部点缀色微光；
 * - epic     ：80% + 更亮的顶部辉光；
 * - legendary：95% + 金色底光（与 SVG 金色框饰/顶冠呼应）+ 暖色中段，
 *              整卡带金调，明显高一档。
 *
 * 确定性铁律：一切参数 = f(palette, rarityTier) 纯函数派生，禁 Math.random/Date；
 * rarityTier 派生自 def.rarity（cardFaceCacheKey 已含 rarity），同一张卡恒同图。
 */

import { saturate, shade, type Palette } from './color'
import type { RarityTier } from './derive'

/** 传说金（与 CardFace.rarityColor 的 legendary 宝石色同源，呼应金色框饰） */
export const LEGENDARY_GOLD = '#ff9d2e'
/** 传说档底部金光色（比框金更亮一档的辉光核心） */
export const LEGENDARY_GLOW_GOLD = '#ffc53d'

/** 渐变停靠点（at ∈ 0..1 单调递增，color 须为 #rrggbb） */
export interface GroundStop {
  at: number
  color: string
}

/** 顶部辉光层（radial，压在渐变上、走线/网格之下） */
export interface GroundGlow {
  color: string
  /** 峰值 alpha（0..1） */
  alpha: number
}

/** 一档底色的完整规格（纯数据，可 JSON 序列化） */
export interface FaceGroundSpec {
  /** 对角渐变（左上 → 右下）：角部派系色 → 中段暗色 → 末端近黑 */
  stops: readonly GroundStop[]
  /** 顶部稀有度辉光；common 为 null（素） */
  glow: GroundGlow | null
}

/** 各档角部派系色强度（shade 提亮系数）、增艳系数（saturate）与渐变覆盖行程 */
interface TierGrade {
  cornerShade: number
  cornerSaturate: number
  cornerStop: number
  midStop: number
  glowColor: string | null
  glowAlpha: number
  /** legendary 暖色中段（金调卡身），其余档中性暗色 */
  midColor: string
}

const NEUTRAL_MID = '#0d1117'
const WARM_MID = '#131009'
const NEUTRAL_END = '#05070b'

/** 四档分级参数表（唯一事实源；调色只动这里） */
const TIERS: Record<RarityTier, TierGrade> = {
  common: { cornerShade: 0.45, cornerSaturate: 1, cornerStop: 0.42, midStop: 0.55, glowColor: null, glowAlpha: 0, midColor: NEUTRAL_MID },
  rare: { cornerShade: 0.62, cornerSaturate: 1.1, cornerStop: 0.4, midStop: 0.53, glowColor: 'accent', glowAlpha: 0.1, midColor: NEUTRAL_MID },
  epic: { cornerShade: 0.8, cornerSaturate: 1.18, cornerStop: 0.38, midStop: 0.51, glowColor: 'accent', glowAlpha: 0.17, midColor: NEUTRAL_MID },
  legendary: { cornerShade: 0.95, cornerSaturate: 1.28, cornerStop: 0.36, midStop: 0.5, glowColor: 'gold', glowAlpha: 0.24, midColor: WARM_MID },
}

/**
 * 派系色板 + 稀有度档位 → 底色规格（纯函数，同输入恒同输出）。
 * 未知档位（防御式）按 common 处理。
 */
export function faceGround(pal: Palette, tier: RarityTier): FaceGroundSpec {
  const g = TIERS[tier] ?? TIERS.common
  const corner = saturate(shade(pal.primary, g.cornerShade), g.cornerSaturate)
  const stops: GroundStop[] = [
    { at: 0, color: corner },
    { at: g.cornerStop, color: corner },
    { at: g.midStop, color: g.midColor },
    { at: 1, color: NEUTRAL_END },
  ]
  let glow: GroundGlow | null = null
  if (g.glowColor === 'accent') glow = { color: pal.accent, alpha: g.glowAlpha }
  else if (g.glowColor === 'gold') glow = { color: LEGENDARY_GLOW_GOLD, alpha: g.glowAlpha }
  return { stops, glow }
}
