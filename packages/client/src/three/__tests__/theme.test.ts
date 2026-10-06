/**
 * M4-R3D5 无头测试：牌桌派系主题纯函数（需求 5：灯光/环境色响应双方派系）。
 */

import { describe, expect, it } from 'vitest'
import { mixHex, tableThemeFor } from '../fx/theme'

describe('mixHex', () => {
  it('端点与中点（纯函数契约）', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000')
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff')
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('同输入恒同输出（确定性）', () => {
    expect(mixHex('#04070a', '#76b900', 0.06)).toBe(mixHex('#04070a', '#76b900', 0.06))
  })
})

describe('tableThemeFor', () => {
  it('近/远侧灯光色 = 双方派系主色（与卡面 resolvePalette 同源）', () => {
    const theme = tableThemeFor('nvidia', 'amd')
    expect(theme.nearLight).toBe('#76b900')
    expect(theme.farLight).toBe('#ed1c24')
  })

  it('背景向双方各染 6%（不再是基线暗色，但仍偏暗）', () => {
    const theme = tableThemeFor('nvidia', 'intel')
    expect(theme.background).not.toBe('#04070a')
    // 每通道都被抬高（染上了派系色）
    const n = parseInt(theme.background.slice(1), 16)
    expect((n >> 16) & 0xff).toBeGreaterThan(0x04)
    expect((n >> 8) & 0xff).toBeGreaterThan(0x07)
    expect(n & 0xff).toBeGreaterThan(0x0a)
  })

  it('槽位染色 = 槽位基线向派系色靠拢，两侧互不相同', () => {
    const theme = tableThemeFor('apple', 'qualcomm')
    expect(theme.slotNear).not.toBe(theme.slotFar)
    expect(theme.slotNear).not.toBe('#1d5a44')
    expect(theme.slotFar).not.toBe('#1d5a44')
  })

  it('同派系对局：两侧色一致；未知派系名确定性兜底不炸', () => {
    const mirror = tableThemeFor('neutral', 'neutral')
    expect(mirror.nearLight).toBe(mirror.farLight)
    const mod = tableThemeFor('modded_faction_x', 'nvidia')
    expect(mod.nearLight).toMatch(/^#[0-9a-f]{6}$/)
    expect(tableThemeFor('modded_faction_x', 'nvidia')).toEqual(mod)
  })
})
