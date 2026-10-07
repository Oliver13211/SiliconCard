/**
 * 演出修正阶段二·需求 1 无头测试：卡面底色分级（cardArt/ground 纯函数）。
 * - 确定性：同 (palette, tier) 恒同输出（禁 Math.random/Date 的纯函数派生）；
 * - 分级：角部派系色亮度/饱和度随稀有度单调上调（common 素 → legendary 浓艳）；
 * - legendary 金色呼应：底光为金色（与 SVG 金框/稀有度宝石同源）；
 * - 对比度：文字带（中段/末段停靠点）保持深底，白字/flavor 对比度不劣化。
 * 不 import 触发 DOM canvas 的执行路径（background.ts 的绘制留给 WF-VISUAL 截图验收）。
 */

import { describe, expect, it } from 'vitest'
import { FACTION_COLORS, resolvePalette, saturate, shade } from '../cardArt/color'
import { LEGENDARY_GLOW_GOLD, faceGround } from '../cardArt/ground'

const HEX_RE = /^#[0-9a-f]{6}$/
const TIERS = ['common', 'rare', 'epic', 'legendary'] as const

/** 相对亮度（WCAG 简化式，0..1） */
function luma(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const lr = (v: number) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lr((n >> 16) & 0xff) + 0.7152 * lr((n >> 8) & 0xff) + 0.0722 * lr(n & 0xff)
}

/** 艳度（通道极差 / 最大通道，0..1）——「浓艳」的粗测度 */
function chroma(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const max = Math.max(r, g, b)
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max
}

/** WCAG 对比度 */
function contrast(a: string, b: string): number {
  const la = luma(a)
  const lb = luma(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('faceGround（卡面底色分级）', () => {
  const palNvidia = resolvePalette({ shape: 'fan', palette: 'nvidia' }, 'nvidia')

  it('确定性：同 (palette, tier) 恒同输出，且全部输出为合法 hex', () => {
    for (const tier of TIERS) {
      expect(faceGround(palNvidia, tier)).toEqual(faceGround(palNvidia, tier))
      const spec = faceGround(palNvidia, tier)
      for (const s of spec.stops) {
        expect(s.color).toMatch(HEX_RE)
        expect(s.at).toBeGreaterThanOrEqual(0)
        expect(s.at).toBeLessThanOrEqual(1)
      }
      if (spec.glow) expect(spec.glow.color).toMatch(HEX_RE)
    }
    // 未知派系哈希色板同样成立（数据驱动扩展零改动）
    const odd = resolvePalette({ shape: 'wave', palette: 'mystery-brand' }, 'mystery-brand')
    expect(faceGround(odd, 'legendary')).toEqual(faceGround(odd, 'legendary'))
  })

  it('停靠点结构：0 起步、1 收尾、角部有平台（at 单调不减）', () => {
    const spec = faceGround(palNvidia, 'epic')
    expect(spec.stops[0]?.at).toBe(0)
    expect(spec.stops.at(-1)?.at).toBe(1)
    for (let i = 1; i < spec.stops.length; i += 1) {
      expect(spec.stops[i]!.at).toBeGreaterThanOrEqual(spec.stops[i - 1]!.at)
    }
    expect(spec.stops[0]?.color).toBe(spec.stops[1]?.color) // 角部平台
  })

  it('四档分级：角部派系色亮度与艳度随稀有度单调上调（common 素 → legendary 浓艳）', () => {
    for (const pal of [
      palNvidia,
      resolvePalette({ shape: 'chip', palette: 'intel' }, 'intel'),
      resolvePalette({ shape: 'disc', palette: 'apple' }, 'apple'),
    ]) {
      let lastLuma = -1
      let lastChroma = -1
      for (const tier of TIERS) {
        const corner = faceGround(pal, tier).stops[0]!.color
        expect(luma(corner)).toBeGreaterThan(lastLuma)
        expect(chroma(corner)).toBeGreaterThanOrEqual(lastChroma)
        lastLuma = luma(corner)
        lastChroma = chroma(corner)
      }
    }
    // common 素：无辉光；稀有度越高辉光越亮
    expect(faceGround(palNvidia, 'common').glow).toBeNull()
    expect(faceGround(palNvidia, 'rare').glow!.alpha).toBeLessThan(faceGround(palNvidia, 'epic').glow!.alpha)
    expect(faceGround(palNvidia, 'epic').glow!.alpha).toBeLessThan(faceGround(palNvidia, 'legendary').glow!.alpha)
  })

  it('legendary 金色呼应：底光为金色（与卡面金框同源），rare/epic 用派系点缀色', () => {
    expect(faceGround(palNvidia, 'legendary').glow!.color).toBe(LEGENDARY_GLOW_GOLD)
    expect(faceGround(palNvidia, 'rare').glow!.color).toBe(palNvidia.accent)
    expect(faceGround(palNvidia, 'epic').glow!.color).toBe(palNvidia.accent)
  })

  it('文字带对比度不劣化：名称白字 ≥7:1，flavor 灰字不低于旧版深底基线', () => {
    const WHITE = '#f2f5f7'
    const FLAVOR = '#8b98a5'
    // 旧版（改前）底色末端/中段对 flavor 的对比度基线
    const baseline = Math.min(contrast(FLAVOR, '#101418'), contrast(FLAVOR, '#05070a'))
    const pals = Object.values(FACTION_COLORS).map((c) => resolvePalette({ shape: 'fan', palette: c }, c))
    pals.push(resolvePalette({ shape: 'wave', palette: 'mystery-brand' }, 'mystery-brand'))
    for (const pal of pals) {
      for (const tier of TIERS) {
        const spec = faceGround(pal, tier)
        const mid = spec.stops[spec.stops.length - 2]!.color
        const end = spec.stops.at(-1)!.color
        expect(contrast(WHITE, mid)).toBeGreaterThanOrEqual(7)
        expect(contrast(WHITE, end)).toBeGreaterThanOrEqual(7)
        expect(contrast(FLAVOR, end)).toBeGreaterThanOrEqual(baseline)
      }
    }
  })

  it('色源一致性：角部色 = saturate∘shade(pal.primary) 派生（新派系零改动即可分级）', () => {
    const pal = resolvePalette(undefined, 'qualcomm')
    expect(faceGround(pal, 'common').stops[0]!.color).toBe(shade(pal.primary, 0.45))
    expect(faceGround(pal, 'legendary').stops[0]!.color).toBe(saturate(shade(pal.primary, 0.95), 1.28))
  })
})
