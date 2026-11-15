/**
 * 卡牌法线贴图规格派生（P2-R3D1）—— 纯函数，零 DOM / 零 Three 依赖。
 *
 * 法线贴图不由卡面位图反推（任务书红线：禁像素分析）：全部凹凸特征从
 * cardArt/layout.ts 的布局几何纯数据派生，与卡面绘制层（CardFace 底版）
 * 的既有形制一一对应：
 * - 边框凸起       ：金属外框 ridge（几何镜像 CardFace.drawMetalFrame 的
 *                    m=10 内缩 + 9px 暗缘 + 5px 主金属，crest ≈ inset 13）；
 * - 金属框高光带   ：上边框附加 ridge（epic/legendary 档，对应顶部高光段）；
 * - 插画窗下沉     ：ART_WINDOW 外沿 pit（壁面向窗内倾斜）+ 细微唇沿；
 * - 稀有度框槽     ：插画窗内沿浅槽 groove（SVG 稀有度环带的浮雕位，
 *                    common 无环 → 无槽）；
 * - 角标凸起       ：费用徽圆币 + 稀有度宝石穹顶（RARITY_GEM[tier] 为 null
 *                    的档位无宝石凸起，与卡面绘制条件同源）。
 *
 * 类型相关角标（攻/血徽，仅 gpu 卡绘制）刻意不入法线：法线按稀有度分档共享，
 * 若含攻/血徽则驱动卡（无徽）会出现空凸，故舍弃——游玩距离下不可感知。
 *
 * 档位参数（唯一事实源，调浮雕强度只动 TIER_NORMAL）：common 最平，legendary
 * 最强——与卡面质感层（cardArt/texture 的 gloss/hi 单调上调）同方向分级。
 *
 * 法线编码约定（切线空间；CanvasTexture flipY=true，v 向上 = canvas −y）：
 * 倾斜向 canvas +x → R>128；倾斜向 canvas −y（即 +v）→ G>128；平坦 = rgb(128,128,255)。
 * 凹凸以「脊线」描述：crest 圆角矩/圆 + 外坡（tilt 向外）+ 内坡（tilt 向内），
 * 负强度 = 槽（groove，坡向翻转朝脊线）。
 */

import type { RarityTier } from '../cardArt/derive'
import { ART_WINDOW, COST_BADGE, FACE_H, FACE_W, GEM, RARITY_GEM } from '../cardArt/layout'

/** 圆角矩形脊线（凸起/下沉/槽共用）：crest 路径 + 外坡宽/强 + 内坡宽/强 */
export interface RidgeRectSpec {
  x: number
  y: number
  w: number
  h: number
  /** crest 圆角半径 */
  r: number
  /** 外坡宽（px，crest 向卡缘方向） */
  outer: number
  /** 内坡宽（px，crest 向卡心方向） */
  inner: number
  /** 外坡强度（正 = 凸坡向外倾，负 = 槽壁向内倾） */
  sOuter: number
  /** 内坡强度（正 = 凸坡向内倾，负 = 槽壁向外倾） */
  sInner: number
}

/** 圆形脊线（角标圆币 / 宝石穹顶） */
export interface RidgeCircleSpec {
  cx: number
  cy: number
  /** crest 半径 */
  r: number
  outer: number
  inner: number
  sOuter: number
  sInner: number
}

/** 卡面法线贴图完整规格（纯数据，可 JSON 序列化） */
export interface CardNormalSpec {
  w: number
  h: number
  tier: RarityTier
  /** 金属外框凸起 */
  frame: RidgeRectSpec
  /** 金属框高光带（上边框附加 ridge；无该档为 null） */
  topBand: RidgeRectSpec | null
  /** 插画窗下沉（内坡 = 坑壁，外坡 = 唇沿） */
  windowPit: RidgeRectSpec
  /** 稀有度框槽（插画窗内沿浅槽；common 无环为 null） */
  rarityRing: RidgeRectSpec | null
  /** 框内 hairline 细槽（极浅，金属框收口） */
  hairline: RidgeRectSpec
  /** 费用徽圆币凸起 */
  costBadge: RidgeCircleSpec
  /** 稀有度宝石穹顶（common 无宝石为 null） */
  gem: RidgeCircleSpec | null
}

/** 卡背法线规格：边框 + 中央硅牌徽记 + 电路走线细脊 */
export interface BackNormalSpec {
  w: number
  h: number
  frame: RidgeRectSpec
  emblem: RidgeRectSpec
  traces: RidgeRectSpec[]
}

/** 各稀有度档浮雕强度（0..1；调档只动这里） */
const TIER_NORMAL: Record<RarityTier, { frame: number; pit: number; ring: number; badge: number; topBand: boolean }> = {
  common: { frame: 0.5, pit: 0.45, ring: 0, badge: 0.55, topBand: false },
  rare: { frame: 0.62, pit: 0.55, ring: 0.45, badge: 0.65, topBand: false },
  epic: { frame: 0.78, pit: 0.65, ring: 0.6, badge: 0.8, topBand: true },
  legendary: { frame: 0.95, pit: 0.78, ring: 0.8, badge: 0.95, topBand: true },
}

// —— CardFace.drawMetalFrame 几何镜像（只读常量；CardFace 内嵌值未导出且禁改其源） ——

/** 金属框 crest 内缩（暗缘 stroke @inset10 lw9 → 5.5..14.5，主金属 @inset13 lw5 → 10.5..15.5，crest ≈ 13） */
const FRAME_CREST_INSET = 13
/** 框 crest 圆角（略小于 drawMetalFrame 的 26/23 圆角链） */
const FRAME_CREST_R = 21
/** hairline 细槽内缩（drawMetalFrame 内 hairline @inset23 lw1.5） */
const HAIRLINE_INSET = 23
/** 插画窗坑深（px）与唇沿宽 */
const WINDOW_PIT_DEPTH = 6
const WINDOW_LIP = 2.5
/** 稀有度框槽：SVG 稀有度环带的浮雕位（环带距窗沿 ~6..10，取 7）与槽宽 */
const RARITY_RING_INSET = 7
const RARITY_RING_WIDTH = 1.6

/**
 * 稀有度档 → 卡面法线规格（纯函数，同 tier 恒同输出）。
 * 布局锚点全部来自 cardArt/layout（无第二份硬编码）。
 */
export function cardNormalSpecFor(tier: RarityTier): CardNormalSpec {
  const t = TIER_NORMAL[tier]
  const frame: RidgeRectSpec = {
    x: FRAME_CREST_INSET,
    y: FRAME_CREST_INSET,
    w: FACE_W - FRAME_CREST_INSET * 2,
    h: FACE_H - FRAME_CREST_INSET * 2,
    r: FRAME_CREST_R,
    outer: 7.5,
    inner: 3.5,
    sOuter: t.frame,
    sInner: t.frame * 0.85,
  }
  const topBand: RidgeRectSpec | null = t.topBand
    ? {
        x: 26,
        y: 14,
        w: FACE_W - 52,
        h: 3,
        r: 1.5,
        outer: 3.5,
        inner: 2.5,
        sOuter: t.frame * 0.4,
        sInner: t.frame * 0.4,
      }
    : null
  const windowPit: RidgeRectSpec = {
    x: ART_WINDOW.x,
    y: ART_WINDOW.y,
    w: ART_WINDOW.w,
    h: ART_WINDOW.h,
    r: ART_WINDOW.r,
    outer: WINDOW_LIP,
    inner: WINDOW_PIT_DEPTH,
    sOuter: t.pit * 0.4,
    sInner: t.pit,
  }
  const rarityRing: RidgeRectSpec | null =
    t.ring > 0
      ? {
          x: ART_WINDOW.x + RARITY_RING_INSET,
          y: ART_WINDOW.y + RARITY_RING_INSET,
          w: ART_WINDOW.w - RARITY_RING_INSET * 2,
          h: ART_WINDOW.h - RARITY_RING_INSET * 2,
          r: Math.max(4, ART_WINDOW.r - RARITY_RING_INSET),
          outer: RARITY_RING_WIDTH,
          inner: RARITY_RING_WIDTH,
          sOuter: -t.ring * 0.6,
          sInner: -t.ring * 0.6,
        }
      : null
  const hairline: RidgeRectSpec = {
    x: HAIRLINE_INSET,
    y: HAIRLINE_INSET,
    w: FACE_W - HAIRLINE_INSET * 2,
    h: FACE_H - HAIRLINE_INSET * 2,
    r: 18,
    outer: 1.5,
    inner: 1.5,
    sOuter: -0.22,
    sInner: -0.22,
  }
  const costBadge: RidgeCircleSpec = {
    cx: COST_BADGE.x,
    cy: COST_BADGE.y,
    r: COST_BADGE.r - 2,
    outer: 4,
    inner: 0,
    sOuter: t.badge,
    sInner: 0,
  }
  const gem: RidgeCircleSpec | null =
    RARITY_GEM[tier] !== null
      ? { cx: GEM.x, cy: GEM.y, r: GEM.r - 1.5, outer: 1.8, inner: 0, sOuter: t.badge * 0.8, sInner: 0 }
      : null
  return { w: FACE_W, h: FACE_H, tier, frame, topBand, windowPit, rarityRing, hairline, costBadge, gem }
}

/** 卡背法线规格（几何镜像 CardFace.drawCardBack：边框走线 + 中央徽记方块） */
export function cardBackNormalSpec(): BackNormalSpec {
  const traces: RidgeRectSpec[] = []
  for (let i = 0; i < 12; i += 1) {
    const y = 40 + i * ((FACE_H - 80) / 11)
    traces.push({
      x: 24,
      y: y - 1,
      w: FACE_W - 48,
      h: 2,
      r: 1,
      outer: 1.2,
      inner: 1.2,
      sOuter: 0.14,
      sInner: 0.14,
    })
  }
  return {
    w: FACE_W,
    h: FACE_H,
    frame: {
      x: 8,
      y: 8,
      w: FACE_W - 16,
      h: FACE_H - 16,
      r: 22,
      outer: 5,
      inner: 4,
      sOuter: 0.5,
      sInner: 0.5,
    },
    emblem: {
      x: FACE_W / 2 - 84,
      y: FACE_H / 2 - 84,
      w: 168,
      h: 168,
      r: 3,
      outer: 4,
      inner: 0,
      sOuter: 0.5,
      sInner: 0,
    },
    traces,
  }
}

/** 法线贴图缓存键（纯函数；与卡面 TextureCache 同体系，前缀 normal| 防撞键） */
export function cardNormalCacheKey(tier: RarityTier | 'back'): string {
  return `normal|${tier}`
}
