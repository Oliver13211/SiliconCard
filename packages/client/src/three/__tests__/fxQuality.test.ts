/**
 * M4-R3D5 无头测试：全局特效质量开关（性能红线「特效可全局降级」）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { fxEnabled, getEffectQuality, scaleFxCount, setEffectQuality, type FxFeature } from '../fx/quality'

const ALL_FEATURES: readonly FxFeature[] = [
  'particles',
  'shards',
  'pillars',
  'bolts',
  'beams',
  'shake',
  'theme',
  'trails',
  'audioExtras',
]

afterEach(() => {
  setEffectQuality('high') // 恢复全局档位，防串测
})

describe('EffectQuality', () => {
  it('默认 high，setter/getter 生效', () => {
    expect(getEffectQuality()).toBe('high')
    setEffectQuality('low')
    expect(getEffectQuality()).toBe('low')
  })

  it('high 档：一切特效全开，粒子量恒等', () => {
    for (const f of ALL_FEATURES) expect(fxEnabled(f), f).toBe(true)
    expect(scaleFxCount(7)).toBe(7)
    expect(scaleFxCount(0)).toBe(0)
  })

  it('low 档：重型特效关闭，粒子保留但减半（至少 1）', () => {
    setEffectQuality('low')
    expect(fxEnabled('particles')).toBe(true)
    for (const f of ALL_FEATURES.filter((x) => x !== 'particles')) {
      expect(fxEnabled(f), f).toBe(false)
    }
    // M4-SND1：audioExtras 关闭 = 次要音层/BGM 节拍降级，关键事件音不受此门控制
    expect(fxEnabled('audioExtras')).toBe(false)
    expect(scaleFxCount(7)).toBe(4)
    expect(scaleFxCount(2)).toBe(1)
    expect(scaleFxCount(1)).toBe(1)
    expect(scaleFxCount(0)).toBe(0)
  })

  it('运行时切回 high 立即恢复（池 spawn 时读 gate，无需重建）', () => {
    setEffectQuality('low')
    expect(fxEnabled('shards')).toBe(false)
    setEffectQuality('high')
    expect(fxEnabled('shards')).toBe(true)
  })
})
