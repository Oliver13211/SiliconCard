/**
 * M1-R3D4 无头测试：手写补间引擎（纯逻辑，零 DOM/Three 值依赖）。
 */

import { describe, expect, it } from 'vitest'
import {
  Timeline,
  easeInCubic,
  easeInOutQuad,
  easeLinear,
  easeOutBack,
  easeOutCubic,
  easeOutElastic,
  type EaseFn,
} from '../anim/tween'

const EASES: readonly [string, EaseFn][] = [
  ['linear', easeLinear],
  ['outCubic', easeOutCubic],
  ['inCubic', easeInCubic],
  ['inOutQuad', easeInOutQuad],
  ['outBack', easeOutBack],
  ['outElastic', easeOutElastic],
]

describe('缓动函数契约', () => {
  it.each(EASES)('%s：f(0)=0、f(1)=1', (_name, f) => {
    expect(f(0)).toBe(0)
    expect(f(1)).toBe(1)
  })

  it.each(EASES.filter(([n]) => n !== 'outBack' && n !== 'outElastic'))(
    '%s：单调不减（普通缓动不许回退）',
    (_name, f) => {
      let prev = -Infinity
      for (let i = 0; i <= 20; i += 1) {
        const v = f(i / 20)
        expect(v).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = v
      }
    },
  )

  it('outBack / outElastic 允许中途越过 1（弹跳演出）但不回退到负起点附近', () => {
    expect(easeOutBack(0.5)).toBeGreaterThan(1)
  })
})

describe('Timeline', () => {
  it('update 按时间推进 onUpdate（线性插值）', () => {
    const t = new Timeline()
    const seen: number[] = []
    t.add({ duration: 1, onUpdate: (p) => seen.push(p) })
    t.update(0.25)
    t.update(0.25)
    expect(seen.length).toBe(2)
    expect(seen[0]).toBeCloseTo(0.25)
    expect(seen[1]).toBeCloseTo(0.5)
  })

  it('播完恰好触发一次 onDone，并从活动队列移除', () => {
    const t = new Timeline()
    let done = 0
    t.add({ duration: 0.5, onUpdate: () => {}, onDone: () => (done += 1) })
    t.update(0.2)
    expect(done).toBe(0)
    expect(t.active).toBe(true)
    t.update(0.2)
    t.update(0.2)
    expect(done).toBe(1)
    expect(t.active).toBe(false)
    t.update(0.5) // 空转不再触发
    expect(done).toBe(1)
  })

  it('delay 生效：延迟期间不推进进度', () => {
    const t = new Timeline()
    const seen: number[] = []
    t.add({ duration: 1, delay: 0.5, onUpdate: (p) => seen.push(p) })
    t.update(0.3)
    expect(seen.length).toBe(0)
    t.update(0.3)
    expect(seen.length).toBe(1)
    expect(seen[0]).toBeCloseTo(0.1, 5)
  })

  it('sequence：按顺序接力，不并行', () => {
    const t = new Timeline()
    const order: string[] = []
    t.sequence([
      { duration: 0.3, onUpdate: () => {}, onDone: () => order.push('a') },
      { duration: 0.3, onUpdate: () => {}, onDone: () => order.push('b') },
    ])
    t.update(0.35)
    expect(order).toEqual(['a'])
    t.update(0.35)
    expect(order).toEqual(['a', 'b'])
  })

  it('fastForward：同步推到终点，onUpdate(1) 与 onDone 各恰好一次，队列清空', () => {
    const t = new Timeline()
    const last: number[] = []
    let done = 0
    t.sequence([
      { duration: 1, onUpdate: (p) => last.push(p), onDone: () => (done += 1) },
      { duration: 2, onUpdate: (p) => last.push(p), onDone: () => (done += 1) },
    ])
    t.update(0.4) // 第一步播到 0.4；第二步还在延迟中，从未启动
    t.fastForward()
    expect(done).toBe(2)
    // 第一步：中间帧 0.4 + 终点 1；第二步（延迟未启动）：只有终点 1
    expect(last).toEqual([0.4, 1, 1])
    expect(t.active).toBe(false)
    // 再快进是幂等空操作
    t.fastForward()
    expect(done).toBe(2)
  })

  it('cancelAll：直接丢弃，不触发 onUpdate/onDone', () => {
    const t = new Timeline()
    let done = 0
    t.add({ duration: 1, onUpdate: () => {}, onDone: () => (done += 1) })
    t.cancelAll()
    t.fastForward()
    expect(done).toBe(0)
    expect(t.active).toBe(false)
  })
})
