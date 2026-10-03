/**
 * M1-R3D3 无头测试：手牌扇形布局（纯函数）与场上布局常量。
 */

import { describe, expect, it } from 'vitest'
import { handSlotAngle, handSlotTransform, handTransforms } from '../handLayout'
import { BOARD_SLOT_DX, HAND_MAX_SPREAD } from '../layout'

describe('handTransforms（手牌扇形）', () => {
  it('张数与输出一一对应', () => {
    expect(handTransforms(0, 3.7)).toHaveLength(0)
    expect(handTransforms(5, 3.7)).toHaveLength(5)
    expect(handTransforms(10, 3.7)).toHaveLength(10)
  })

  it('单张牌居中（x=0，无倾角）', () => {
    const t = handSlotTransform(0, 1, 3.7)
    expect(t.x).toBe(0)
    expect(t.rotZ).toBe(0)
  })

  it('多张牌关于中心镜像对称（偶数张取中间两列近似对称）', () => {
    for (const count of [3, 5, 7, 9]) {
      const ts = handTransforms(count, 3.7)
      const first = ts[0]
      const last = ts[count - 1]
      expect(first).toBeDefined()
      expect(last).toBeDefined()
      expect(first!.x).toBeCloseTo(-last!.x, 10)
      expect(first!.rotZ).toBeCloseTo(-last!.rotZ, 10)
      expect(first!.y).toBeCloseTo(last!.y, 10)
      // 中间牌恰在中心
      const mid = ts[Math.floor((count - 1) / 2)]
      expect(mid!.x).toBeCloseTo(0, 10)
    }
  })

  it('扇形张角封顶（满手 10 张不超过 HAND_MAX_SPREAD）', () => {
    const ts = handTransforms(10, 3.7)
    const totalAngle = handSlotAngle(9, 10) - handSlotAngle(0, 10)
    expect(totalAngle).toBeLessThanOrEqual(HAND_MAX_SPREAD + 1e-9)
    // 端点牌有外倾
    expect(Math.abs(ts[9]!.rotZ)).toBeGreaterThan(0)
  })

  it('牌数增多时整体宽度受限（间距压缩）', () => {
    const w3 = handTransforms(3, 3.7)
    const w10 = handTransforms(10, 3.7)
    const span3 = w3[2]!.x - w3[0]!.x
    const span10 = w10[9]!.x - w10[0]!.x
    expect(span10).toBeLessThan(span3 * 4.5) // 10 张若不压缩应为 4.5 倍
  })

  it('确定性：同输入恒同输出', () => {
    const a = handSlotTransform(4, 9, 3.7)
    const b = handSlotTransform(4, 9, 3.7)
    expect(a).toEqual(b)
  })
})

describe('场上布局常量', () => {
  it('7 槽宽度不越过桌面半宽（BOARD_LIMIT=7 满场时可见）', () => {
    const span = 6 * BOARD_SLOT_DX
    expect(span).toBeLessThan(11) // 桌面 22 宽的一半
  })
})
