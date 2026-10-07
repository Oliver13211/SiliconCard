/**
 * 演出修正阶段二·需求 2 无头测试：3D 卡牌立体描边（cardOutline + CardEntity）。
 * - 描边色派生：传说金边、其余按派系（确定性纯函数）；
 * - 材质共享注册表：同键恒同实例、有界数量（≤8 色 × 2 态）、亮暗两态可辨；
 * - CardEntity 集成：描边盒小于拾取面（不改射线语义）、hover/选中切亮态、
 *   reset 归位中性常态、淡出时关闭描边。
 * CardEntity/材质构造不触发 WebGL，可无头运行。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  OUTLINE_LEGENDARY_GOLD,
  OUTLINE_NEUTRAL,
  disposeSharedOutlineMaterials,
  isSharedOutlineMaterial,
  outlineColorFor,
  outlineMaterial,
  outlineMaterialCount,
} from '../cardOutline'
import { CardEntity } from '../CardEntity'
import { CARD_H, CARD_W } from '../layout'
import { FACTION_COLORS } from '../cardArt/color'

describe('outlineColorFor（描边色派生，纯函数）', () => {
  it('传说卡金边（与卡面稀有度宝石/金框同源），派系无关', () => {
    expect(outlineColorFor('nvidia', 'legendary')).toBe(OUTLINE_LEGENDARY_GOLD)
    expect(outlineColorFor('amd', 'legendary')).toBe(OUTLINE_LEGENDARY_GOLD)
  })

  it('非传说按派系主色；starter/未定义稀有度同样按派系', () => {
    expect(outlineColorFor('nvidia', 'rare')).toBe(FACTION_COLORS.nvidia)
    expect(outlineColorFor('intel', 'epic')).toBe(FACTION_COLORS.intel)
    expect(outlineColorFor('arm', undefined)).toBe(FACTION_COLORS.arm)
    expect(outlineColorFor('neutral', 'starter')).toBe(FACTION_COLORS.neutral)
  })

  it('未知派系（占位卡/内容包缺卡）落中性描边；同输入恒同输出', () => {
    expect(outlineColorFor('no-such-faction', 'rare')).toBe(OUTLINE_NEUTRAL)
    expect(outlineColorFor('no-such-faction', undefined)).toBe(OUTLINE_NEUTRAL)
    expect(outlineColorFor('via', 'common')).toBe(outlineColorFor('via', 'common'))
  })
})

describe('outlineMaterial（共享材质注册表，性能红线）', () => {
  beforeEach(() => {
    disposeSharedOutlineMaterials()
  })

  it('同键恒同实例（零 per-card 克隆）', () => {
    const a = outlineMaterial('#76b900', false)
    const b = outlineMaterial('#76b900', false)
    expect(a).toBe(b)
    expect(outlineMaterial('#76b900', true)).not.toBe(a)
    expect(outlineMaterial('#ed1c24', false)).not.toBe(a)
  })

  it('亮暗两态：亮态更亮且不透明度拉满，几何参数 BackSide + 不写深度', () => {
    const normal = outlineMaterial('#0068b5', false)
    const bright = outlineMaterial('#0068b5', true)
    expect(normal.side).toBe(THREE.BackSide)
    expect(normal.depthWrite).toBe(false)
    expect(normal.transparent).toBe(true)
    expect(normal.opacity).toBeLessThan(bright.opacity)
    expect(bright.opacity).toBe(1)
    // 提亮：亮态各通道 ≥ 常态（shade >1 只会提亮）
    const n = normal.color.getHex()
    const b = bright.color.getHex()
    expect(((b >> 16) & 0xff)).toBeGreaterThanOrEqual(((n >> 16) & 0xff))
    expect(((b >> 8) & 0xff)).toBeGreaterThanOrEqual(((n >> 8) & 0xff))
    expect((b & 0xff)).toBeGreaterThanOrEqual((n & 0xff))
  })

  it('共享上限有界：7 派系 + 传说金 + 中性 × 2 态 ≤ 16 实例', () => {
    const colors = new Set([...Object.values(FACTION_COLORS), OUTLINE_LEGENDARY_GOLD, OUTLINE_NEUTRAL])
    for (const c of colors) {
      outlineMaterial(c, false)
      outlineMaterial(c, true)
    }
    expect(outlineMaterialCount()).toBeLessThanOrEqual(16)
    expect(outlineMaterialCount()).toBe(colors.size * 2)
  })

  it('共享标记：dispose 遍历据此跳过（userData.shared）', () => {
    expect(isSharedOutlineMaterial(outlineMaterial('#76b900', false))).toBe(true)
  })
})

describe('CardEntity 描边集成', () => {
  beforeEach(() => {
    disposeSharedOutlineMaterials()
  })

  function makeEntity(): CardEntity {
    return new CardEntity(new THREE.Texture())
  }

  it('默认中性常态；setOutline 后切派系常态（共享实例引用）', () => {
    const e = makeEntity()
    e.update(0.016)
    expect(e.outlineMesh.material).toBe(outlineMaterial(OUTLINE_NEUTRAL, false))
    e.setOutline('#76b900')
    e.update(0.016)
    expect(e.outlineMesh.material).toBe(outlineMaterial('#76b900', false))
  })

  it('hover / 选中 → 切共享亮态；退去后回常态', () => {
    const e = makeEntity()
    e.setOutline('#76b900')
    e.setHovered(true)
    e.update(1) // hoverK 平滑趋近 1，越过 0.45 阈值
    expect(e.outlineMesh.material).toBe(outlineMaterial('#76b900', true))
    e.setHovered(false)
    e.update(2)
    expect(e.outlineMesh.material).toBe(outlineMaterial('#76b900', false))
    e.selected = true
    e.update(0.016)
    expect(e.outlineMesh.material).toBe(outlineMaterial('#76b900', true))
  })

  it('两个实体同色共享同一材质实例（材质数不随卡数增长）', () => {
    const before = outlineMaterialCount()
    const a = makeEntity()
    const b = makeEntity()
    a.update(0.016)
    b.update(0.016)
    // 构造即中性常态：两实体共享同一实例
    expect(a.outlineMesh.material).toBe(b.outlineMesh.material)
    expect(outlineMaterialCount()).toBe(before + 1)
    // 同派系色同样共享，注册表只 +1
    a.setOutline('#ed1c24')
    b.setOutline('#ed1c24')
    a.update(0.016)
    b.update(0.016)
    expect(a.outlineMesh.material).toBe(b.outlineMesh.material)
    expect(outlineMaterialCount()).toBe(before + 2)
  })

  it('reset 归位中性常态（池复用不串色）', () => {
    const e = makeEntity()
    e.setOutline('#ffb400')
    e.selected = true
    e.update(0.016)
    e.reset()
    e.update(0.016)
    expect(e.outlineMesh.material).toBe(outlineMaterial(OUTLINE_NEUTRAL, false))
  })

  it('淡出时关闭描边（烧卡/飞入演出不留悬浮轮廓）', () => {
    const e = makeEntity()
    e.update(0.016)
    expect(e.outlineMesh.visible).toBe(true)
    e.opacity = 0.2
    e.update(0.016)
    expect(e.outlineMesh.visible).toBe(false)
  })

  it('描边盒小于拾取面与迟滞外圈（不改任何射线命中语义）', () => {
    const e = makeEntity()
    const outlineGeo = e.outlineMesh.geometry as THREE.BoxGeometry
    const pickGeo = e.pickMesh.geometry as THREE.PlaneGeometry
    const guardGeo = e.hoverGuard.geometry as THREE.PlaneGeometry
    expect(outlineGeo.parameters.width).toBeCloseTo(CARD_W * 1.05)
    expect(outlineGeo.parameters.height).toBeCloseTo(CARD_H * 1.04)
    expect(outlineGeo.parameters.width).toBeLessThan(pickGeo.parameters.width)
    expect(outlineGeo.parameters.height).toBeLessThan(guardGeo.parameters.height)
    // BackSide：朝向外壁的面被剔除，raycast 不会抢先命中描边
    expect((e.outlineMesh.material as THREE.MeshBasicMaterial).side).toBe(THREE.BackSide)
  })
})
