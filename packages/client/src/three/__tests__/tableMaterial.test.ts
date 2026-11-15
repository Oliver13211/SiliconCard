/**
 * P2-R3D2 无头测试：牌桌真实材质纯函数层（tableSkin/params 的凹凸与粗糙度规格）。
 * textures.ts 为 DOM 绘制层，不在无头环境测（与 tableSkin.test.ts 同约定）；
 * 本文件覆盖台面绒布凹凸/粗糙度规格的派生契约与几何同源性。
 */

import { describe, expect, it } from 'vitest'
import {
  EMBLEM_HEX_R,
  feltEmbossSpecFor,
  feltRoughnessSpecFor,
  pileMarksFor,
  screwPointsFor,
  slotMarksFor,
  worldToCanvas,
} from '../tableSkin/params'
import { SKIN_TEXTURE_SIZE } from '../tableSkin/params'

const TW = SKIN_TEXTURE_SIZE.tableTopW
const TH = SKIN_TEXTURE_SIZE.tableTopH

describe('feltEmbossSpecFor（台面凹凸规格派生）', () => {
  it('确定性：同输入恒同输出（禁 Math.random/Date 泄入）', () => {
    expect(feltEmbossSpecFor(TW, TH)).toEqual(feltEmbossSpecFor(TW, TH))
  })

  it('几何同源：槽位/牌堆标记复用 slotMarksFor/pileMarksFor（无第二份硬编码）', () => {
    const spec = feltEmbossSpecFor(TW, TH)
    expect(spec.slots).toEqual(slotMarksFor(TW, TH))
    expect(spec.piles).toEqual(pileMarksFor(TW, TH))
    expect(spec.screws).toEqual(screwPointsFor(TW, TH))
    expect(spec.slots).toHaveLength(14)
    expect(spec.piles).toHaveLength(4)
    expect(spec.screws).toHaveLength(4)
  })

  it('中央螺母徽记居中，半径与 EMBLEM_HEX_R 同源（albedo 与凹凸共用几何）', () => {
    const spec = feltEmbossSpecFor(TW, TH)
    const c = worldToCanvas(0, 0, TW, TH)
    expect(spec.emblem.cx).toBeCloseTo(c.x)
    expect(spec.emblem.cy).toBeCloseTo(c.y)
    expect(spec.emblem.rOuter).toBe(EMBLEM_HEX_R.outer)
    expect(spec.emblem.rInner).toBe(EMBLEM_HEX_R.inner)
    expect(spec.emblem.rOuter).toBeGreaterThan(spec.emblem.rInner)
  })

  it('织纹间距为正且可用（脊线步进）', () => {
    const spec = feltEmbossSpecFor(TW, TH)
    expect(spec.weaveStep).toBeGreaterThan(1)
    expect(spec.weaveStep).toBeLessThan(32)
  })
})

describe('feltRoughnessSpecFor（台面粗糙度规格派生）', () => {
  it('确定性：同输入恒同输出', () => {
    expect(feltRoughnessSpecFor(TW, TH)).toEqual(feltRoughnessSpecFor(TW, TH))
  })

  it('数值域 0..1；光池更光滑（pool < felt），槽内居中', () => {
    const spec = feltRoughnessSpecFor(TW, TH)
    for (const v of [spec.pool, spec.felt, spec.slot]) {
      expect(v).toBeGreaterThan(0)
      expect(v).toBeLessThanOrEqual(1)
    }
    expect(spec.pool).toBeLessThan(spec.slot)
    expect(spec.slot).toBeLessThan(spec.felt)
  })

  it('光池几何与台面 albedo 顶灯同源：中心居中、半径按比例', () => {
    const spec = feltRoughnessSpecFor(TW, TH)
    expect(spec.cx).toBeCloseTo(TW / 2)
    expect(spec.cy).toBeCloseTo(TH / 2)
    expect(spec.r0).toBeCloseTo(TH * 0.1)
    expect(spec.r1).toBeCloseTo(TH * 0.62)
    expect(spec.r0).toBeLessThan(spec.r1)
  })
})

describe('screwPointsFor（PCB 边框螺丝点位，albedo/凹凸共用）', () => {
  it('四角对称且坐标有限', () => {
    const pts = screwPointsFor(TW, TH)
    expect(pts).toHaveLength(4)
    for (const p of pts) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
    // 左右镜像
    const xs = pts.map((p) => p.x).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(TW - (xs[3] as number))
    expect(xs[1]).toBeCloseTo(TW - (xs[2] as number))
  })
})
