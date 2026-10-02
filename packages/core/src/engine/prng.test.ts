import { describe, expect, it } from 'vitest'
import { createRng, nextUint32 } from './prng'

describe('mulberry32 PRNG（rules.md §11）', () => {
  it('nextUint32 同状态同输出，且状态单调推进', () => {
    const a = nextUint32(12345)
    const b = nextUint32(12345)
    expect(a).toEqual(b)
    expect(a.state).not.toBe(12345)
    expect(Number.isInteger(a.state)).toBe(true)
    expect(a.state).toBeGreaterThanOrEqual(0)
    expect(a.value).toBeGreaterThanOrEqual(0)
    expect(a.value).toBeLessThan(2 ** 32)
  })

  it('输出序列可由序列化状态完整复现', () => {
    const rng = createRng(0xc0ffee)
    const first8: number[] = []
    for (let i = 0; i < 8; i++) first8.push(rng.nextFloat())
    const midState = rng.getState()
    const ninth = rng.nextFloat()
    // 用记录下来的中间状态重建 RNG，应得到完全相同的后续序列
    const restored = createRng(midState)
    expect(restored.nextFloat()).toBe(ninth)
    // 从头重放：前 8 个输出逐一致
    const replay = createRng(0xc0ffee)
    for (const expected of first8) expect(replay.nextFloat()).toBe(expected)
  })

  it('nextInt 边界与无偏性（拒绝采样）', () => {
    const rng = createRng(42)
    for (let i = 0; i < 1000; i++) {
      const v = rng.nextInt(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
      expect(Number.isInteger(v)).toBe(true)
    }
    // 均匀性粗检：10000 次投掷，每桶频率在 1/7 ± 3% 内
    const rng2 = createRng(7)
    const buckets = new Array(7).fill(0)
    for (let i = 0; i < 70000; i++) buckets[rng2.nextInt(7)]! += 1
    for (const count of buckets) {
      expect(count / 70000).toBeGreaterThan(1 / 7 - 0.03)
      expect(count / 70000).toBeLessThan(1 / 7 + 0.03)
    }
  })

  it('nextInt 非法 bound 抛错', () => {
    const rng = createRng(1)
    expect(() => rng.nextInt(0)).toThrow(/bound/)
    expect(() => rng.nextInt(-3)).toThrow(/bound/)
    expect(() => rng.nextInt(1.5)).toThrow(/bound/)
  })

  it('shuffle：同 seed 同置换、异 seed 异置换、置换是双射', () => {
    const base = Array.from({ length: 30 }, (_, i) => i)
    const a = createRng(20261001).shuffle([...base])
    const b = createRng(20261001).shuffle([...base])
    const c = createRng(20261002).shuffle([...base])
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect([...a].sort((x, y) => x - y)).toEqual(base)
    // 空数组与单元素不炸
    expect(createRng(1).shuffle([])).toEqual([])
    expect(createRng(1).shuffle([9])).toEqual([9])
  })
})
