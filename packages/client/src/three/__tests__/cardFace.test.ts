/**
 * M1-R3D2 无头测试：卡面绘制器的纯逻辑部分（色板解析 / 形体选择 / 缓存键）。
 * 注意：不 import 触发 DOM canvas 的执行路径，drawCardFace 本身留给 WF-VISUAL 截图验收。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '@siliconcard/core'
import {
  cardFaceCacheKey,
  fnv1a,
  hslToHex,
  pickShapeKind,
  resolvePalette,
  shade,
} from '../CardFace'

const baseDef: CardDefinition = {
  id: 'rtx-5090',
  name: 'RTX 5090',
  faction: 'nvidia',
  type: 'gpu',
  cost: 1000,
  attack: 9,
  health: 9,
  rarity: 'legendary',
  keywords: ['taunt'],
  art: { shape: 'fan', palette: 'nvidia' },
}

describe('resolvePalette（派系色板解析）', () => {
  it('内置派系命中色表（与 App.tsx 派系色同源）', () => {
    const pal = resolvePalette(baseDef.art, baseDef.faction)
    expect(pal.primary).toBe('#76b900')
  })

  it('art.palette 为十六进制时直接采用（内容包可覆盖派系色）', () => {
    const pal = resolvePalette({ shape: 'fan', palette: '#ff8800' }, 'nvidia')
    expect(pal.primary).toBe('#ff8800')
  })

  it('未知名按哈希确定性生成（数据驱动扩展零改动）', () => {
    const a = resolvePalette({ shape: 'wave', palette: 'mystery-brand' }, 'mystery-brand')
    const b = resolvePalette({ shape: 'wave', palette: 'mystery-brand' }, 'mystery-brand')
    expect(a).toEqual(b)
    expect(a.primary).toMatch(/^#[0-9a-f]{6}$/)
    expect(a.secondary).toMatch(/^#[0-9a-f]{6}$/)
    expect(a.accent).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('七系派系全部命中色表且互不相同', () => {
    const factions = ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'neutral']
    const primaries = factions.map((f) => resolvePalette(undefined, f).primary)
    expect(new Set(primaries).size).toBe(7)
  })
})

describe('pickShapeKind（几何形体选择）', () => {
  it('已知名直取', () => {
    expect(pickShapeKind('fan')).toBe('fan')
    expect(pickShapeKind('chip')).toBe('chip')
    expect(pickShapeKind('mineral')).toBe('mineral')
  })

  it('未知名确定性映射到合法形体', () => {
    const a = pickShapeKind('nonexistent-gpu-shape')
    const b = pickShapeKind('nonexistent-gpu-shape')
    expect(a).toBe(b)
    expect(['fan', 'chip', 'wave', 'die', 'connector', 'mineral']).toContain(a)
  })
})

describe('cardFaceCacheKey（纹理缓存键）', () => {
  it('同参数同键（缓存命中）', () => {
    expect(cardFaceCacheKey({ def: baseDef })).toBe(cardFaceCacheKey({ def: baseDef }))
  })

  it('生效功耗 / 当前血量不同 → 键不同（数值变化即重绘）', () => {
    const base = cardFaceCacheKey({ def: baseDef })
    expect(cardFaceCacheKey({ def: baseDef, cost: 800 })).not.toBe(base)
    expect(cardFaceCacheKey({ def: baseDef, health: 2 })).not.toBe(base)
    expect(cardFaceCacheKey({ def: baseDef, attack: 10 })).not.toBe(base)
  })

  it('art 参数变化 → 键不同', () => {
    const base = cardFaceCacheKey({ def: baseDef })
    expect(cardFaceCacheKey({ def: { ...baseDef, art: { shape: 'chip', palette: 'nvidia' } } })).not.toBe(base)
  })
})

describe('颜色工具', () => {
  it('fnv1a 稳定且 32 位无符号', () => {
    expect(fnv1a('nvidia')).toBe(fnv1a('nvidia'))
    expect(fnv1a('nvidia')).toBeGreaterThanOrEqual(0)
    expect(fnv1a('nvidia')).toBeLessThan(2 ** 32)
  })

  it('hslToHex 往返端点正确', () => {
    expect(hslToHex(0, 1, 0.5)).toBe('#ff0000')
    expect(hslToHex(120, 1, 0.5)).toBe('#00ff00')
    expect(hslToHex(240, 1, 0.5)).toBe('#0000ff')
  })

  it('shade 压暗/提亮端点不越界', () => {
    expect(shade('#ffffff', 0)).toBe('#000000')
    expect(shade('#000000', 2)).toBe('#ffffff')
    expect(shade('#808080', 0.5)).toBe('#404040')
  })
})
