/**
 * 卡面大改版无头测试：质感层规格派生（cardArt/texture 纯函数）+ 布局常量（cardArt/layout）。
 * - 确定性：同 (palette, tier, seed) 恒同输出（禁 Math.random/Date）；
 * - 分级：光泽/暗角/金属高光随稀有度单调上调，光泽峰值封顶（不抢 SVG 主体）；
 * - 金属框：暗缘色 = shade(primary, 0.35) 派生（新派系零改动即可成色）；
 * - 布局承诺：插画窗竖向 ≥40%、边框信息带锚点有序、角标压框不出界。
 * 不 import 触发 DOM canvas 的执行路径（drawFaceTexture 绘制留给 WF-VISUAL 截图验收）。
 */

import { describe, expect, it } from 'vitest'
import { fnv1a, resolvePalette, shade } from '../cardArt/color'
import {
  ART_WINDOW,
  COST_BADGE,
  FACE_H,
  FACE_W,
  FLAVOR_Y1,
  FLAVOR_Y2,
  GEM,
  KEYWORD_ROW_Y,
  NAME_Y,
  RARITY_GEM,
  STAT_R,
  STAT_X_IN,
  STAT_X_OUT,
  STAT_Y,
  TYPE_Y,
} from '../cardArt/layout'
import { faceTexture } from '../cardArt/texture'

const HEX_RE = /^#[0-9a-f]{6}$/
const TIERS = ['common', 'rare', 'epic', 'legendary'] as const

describe('faceTexture（质感层规格派生）', () => {
  const pal = resolvePalette({ shape: 'fan', palette: 'nvidia' }, 'nvidia')

  it('确定性：同 (palette, tier, seed) 恒同输出', () => {
    for (const tier of TIERS) {
      const seed = fnv1a('rtx-5090')
      expect(faceTexture(pal, tier, seed)).toEqual(faceTexture(pal, tier, seed))
    }
    // 未知派系哈希色板同样成立（数据驱动扩展零改动）
    const odd = resolvePalette({ shape: 'wave', palette: 'mystery-brand' }, 'mystery-brand')
    expect(faceTexture(odd, 'legendary', fnv1a('odd-card'))).toEqual(faceTexture(odd, 'legendary', fnv1a('odd-card')))
  })

  it('稀有度分级：光泽/暗角/金属高光/内阴影随档位单调上调', () => {
    let lastGloss = -1
    let lastVignette = -1
    let lastHi = -1
    let lastShadow = -1
    for (const tier of TIERS) {
      const spec = faceTexture(pal, tier, fnv1a('tier-check'))
      expect(spec.gloss.alpha).toBeGreaterThan(lastGloss)
      expect(spec.vignette.alpha).toBeGreaterThan(lastVignette)
      expect(spec.frameMetal.hiAlpha).toBeGreaterThan(lastHi)
      expect(spec.innerShadow.alpha).toBeGreaterThan(lastShadow)
      lastGloss = spec.gloss.alpha
      lastVignette = spec.vignette.alpha
      lastHi = spec.frameMetal.hiAlpha
      lastShadow = spec.innerShadow.alpha
    }
  })

  it('光泽扫过不抢主体：峰值 alpha ≤ 0.1，几何参数确定且在卡面上半区', () => {
    for (const tier of TIERS) {
      const spec = faceTexture(pal, tier, fnv1a('gloss-check'))
      expect(spec.gloss.alpha).toBeLessThanOrEqual(0.1)
      expect(spec.gloss.y).toBeGreaterThan(0)
      expect(spec.gloss.y + spec.gloss.height).toBeLessThan(FACE_H * 0.5)
      expect(spec.gloss.bandWidth).toBeGreaterThan(0)
      expect(spec.gloss.bandWidth).toBeLessThanOrEqual(1)
      expect(Math.abs(spec.gloss.angle)).toBeGreaterThan(0) // 斜向光带
    }
  })

  it('金属框：高光白色、暗缘 = shade(primary, 0.35)（色源与派系色板同源）', () => {
    for (const [name, hex] of Object.entries({ nvidia: '#76b900', amd: '#ed1c24', intel: '#0068b5' })) {
      const p = resolvePalette({ shape: 'fan', palette: hex }, name)
      const spec = faceTexture(p, 'epic', fnv1a('metal-check'))
      expect(spec.frameMetal.hiColor).toBe('#ffffff')
      expect(spec.frameMetal.edgeColor).toBe(shade(p.primary, 0.35))
      expect(spec.frameMetal.edgeColor).toMatch(HEX_RE)
    }
  })

  it('纸纹与微走线：种子 32 位无符号、异卡异种子、密度在预算内', () => {
    const a = faceTexture(pal, 'rare', fnv1a('grain-a'))
    const b = faceTexture(pal, 'rare', fnv1a('grain-b'))
    for (const spec of [a, b]) {
      expect(spec.grain.seed).toBeGreaterThanOrEqual(0)
      expect(spec.grain.seed).toBeLessThan(2 ** 32)
      expect(spec.microTraces.seed).toBeGreaterThanOrEqual(0)
      expect(spec.microTraces.seed).toBeLessThan(2 ** 32)
      expect(spec.grain.count).toBeGreaterThanOrEqual(620)
      expect(spec.grain.count).toBeLessThanOrEqual(799)
      expect(spec.microTraces.count).toBeGreaterThanOrEqual(4)
      expect(spec.microTraces.count).toBeLessThanOrEqual(6)
      expect(spec.microTraces.color).toMatch(HEX_RE)
      expect(spec.microTraces.color).toBe(pal.primary)
    }
    expect(a.grain.seed).not.toBe(b.grain.seed)
    expect(a.microTraces.seed).not.toBe(b.microTraces.seed)
  })

  it('未知档位（防御式）按 common 处理', () => {
    const spec = faceTexture(pal, 'not-a-tier' as never, fnv1a('fallback'))
    expect(spec).toEqual(faceTexture(pal, 'common', fnv1a('fallback')))
  })
})

describe('卡面布局常量（主视觉 + 边框信息带）', () => {
  it('插画窗：竖向占比 ≥40%、横向 ≥85%、居中且在边框内', () => {
    expect(ART_WINDOW.h / FACE_H).toBeGreaterThanOrEqual(0.4)
    expect(ART_WINDOW.w / FACE_W).toBeGreaterThanOrEqual(0.85)
    expect(ART_WINDOW.x + ART_WINDOW.w / 2).toBe(FACE_W / 2) // 横向居中
    expect(ART_WINDOW.x).toBeGreaterThanOrEqual(18)
    expect(ART_WINDOW.y + ART_WINDOW.h).toBeLessThanOrEqual(FACE_H - 18)
  })

  it('边框信息带锚点有序：插画窗之下 名称→类型→关键词→flavor→攻血 依次排布', () => {
    const artBottom = ART_WINDOW.y + ART_WINDOW.h
    expect(NAME_Y).toBeGreaterThan(artBottom)
    expect(TYPE_Y).toBeGreaterThan(NAME_Y)
    expect(KEYWORD_ROW_Y).toBeGreaterThan(TYPE_Y)
    expect(FLAVOR_Y1).toBeGreaterThan(KEYWORD_ROW_Y)
    expect(FLAVOR_Y2).toBeGreaterThan(FLAVOR_Y1)
    expect(STAT_Y - STAT_R).toBeGreaterThan(FLAVOR_Y2) // 攻血徽不压 flavor
    expect(STAT_Y + STAT_R).toBeLessThanOrEqual(FACE_H - 14) // 徽不出卡
  })

  it('框上层角标：费用徽/宝石压在插画窗两角且不出卡面', () => {
    expect(COST_BADGE.y - COST_BADGE.r).toBeGreaterThanOrEqual(18)
    expect(COST_BADGE.x - COST_BADGE.r).toBeGreaterThanOrEqual(18)
    expect(GEM.x + GEM.r).toBeLessThanOrEqual(FACE_W - 18)
    expect(GEM.y - GEM.r).toBeGreaterThanOrEqual(18)
    // 费用徽与宝石都骑在插画窗上沿（框上层语义）
    expect(COST_BADGE.y).toBeLessThan(ART_WINDOW.y + ART_WINDOW.r)
    expect(GEM.y).toBeLessThan(ART_WINDOW.y + ART_WINDOW.r)
  })

  it('稀有度宝石色：common 无、其余三档 hex 且互不相同（与插画区稀有度环同源）', () => {
    expect(RARITY_GEM.common).toBeNull()
    const tiers = ['rare', 'epic', 'legendary'] as const
    const colors = tiers.map((t) => RARITY_GEM[t])
    for (const c of colors) expect(c).toMatch(HEX_RE)
    expect(new Set(colors).size).toBe(3)
  })

  it('攻血徽横向对称（底部两角）', () => {
    expect(STAT_X_IN + STAT_X_OUT).toBe(FACE_W)
  })
})
