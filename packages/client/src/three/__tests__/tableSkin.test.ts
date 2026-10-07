/**
 * tableSkin 无头单测：纯函数层（纹理参数派生 / 世界→画布映射 / 槽位·牌堆标记 /
 * 派系染色融合）+ AmbientDust 尘埃池（确定性 / 质量档联动 / 资源释放）。
 * textures.ts 为 DOM 绘制层，不在无头环境测（document 守卫返回 null）。
 */

import { describe, expect, it, afterEach, vi } from 'vitest'
import * as THREE from 'three'
import {
  BACKDROP_GEOMETRY,
  LED_PALETTE,
  NEUTRAL_FLOOR_TINT,
  NEUTRAL_WALL_TINT,
  SKIN_SEED,
  SKIN_TEXTURE_SIZE,
  backdropLayoutFor,
  floorTintFor,
  pileMarksFor,
  playAreaFor,
  slotMarksFor,
  traceLayoutFor,
  wallTintFor,
  worldSizeToCanvas,
  worldToCanvas,
} from '../tableSkin/params'
import { AmbientDust } from '../tableSkin/dust'
import { setEffectQuality } from '../fx/quality'
import { tableThemeFor } from '../fx/theme'
import { BOARD_SLOT_DX, BOARD_Z, PILE, TABLE_D, TABLE_W } from '../layout'

const TW = SKIN_TEXTURE_SIZE.tableTopW
const TH = SKIN_TEXTURE_SIZE.tableTopH

describe('tableSkin/params 纹理尺寸与坐标映射', () => {
  it('台面纹理纵横比与桌面一致（槽位标记不变形）', () => {
    expect(TW).toBe(1024)
    expect(TH).toBe(Math.round((TW * TABLE_D) / TABLE_W))
  })

  it('worldToCanvas：中心居中，远端在画布顶部，近端在画布底部', () => {
    const c = worldToCanvas(0, 0, TW, TH)
    expect(c.x).toBeCloseTo(TW / 2)
    expect(c.y).toBeCloseTo(TH / 2)
    // 远端（z = -TABLE_D/2）→ 画布顶部 y=0；近端 → 底部 y=h
    expect(worldToCanvas(0, -TABLE_D / 2, TW, TH).y).toBeCloseTo(0)
    expect(worldToCanvas(0, TABLE_D / 2, TW, TH).y).toBeCloseTo(TH)
    // 左边缘 x=0
    expect(worldToCanvas(-TABLE_W / 2, 0, TW, TH).x).toBeCloseTo(0)
    expect(worldToCanvas(TABLE_W / 2, 0, TW, TH).x).toBeCloseTo(TW)
  })

  it('worldSizeToCanvas：等比缩放', () => {
    const s = worldSizeToCanvas(2, 2, TW, TH)
    expect(s.w).toBeCloseTo((2 / TABLE_W) * TW)
    expect(s.h).toBeCloseTo((2 / TABLE_D) * TH)
  })
})

describe('tableSkin/params 台面功能标记', () => {
  it('slotMarksFor：14 槽，尺寸与槽位 PlaneGeometry 一致，近排中心落在 BOARD_Z.P1', () => {
    const marks = slotMarksFor(TW, TH)
    expect(marks).toHaveLength(14)
    const size = worldSizeToCanvas(1.06, 1.46, TW, TH)
    for (const m of marks) {
      expect(m.w).toBeCloseTo(size.w)
      expect(m.h).toBeCloseTo(size.h)
    }
    const nearCenterY = worldToCanvas(0, BOARD_Z.P1, TW, TH).y
    const farCenterY = worldToCanvas(0, BOARD_Z.P2, TW, TH).y
    for (let i = 0; i < 7; i += 1) {
      const near = marks[i] as { x: number; y: number; w: number; h: number }
      const far = marks[i + 7] as { x: number; y: number; w: number; h: number }
      expect(near.y + near.h / 2).toBeCloseTo(nearCenterY)
      expect(far.y + far.h / 2).toBeCloseTo(farCenterY)
      // 槽距与 BOARD_SLOT_DX 同步（无第二份硬编码）
      const expectedX = worldToCanvas((i - 3) * BOARD_SLOT_DX, 0, TW, TH).x
      expect(near.x + near.w / 2).toBeCloseTo(expectedX)
    }
  })

  it('slotMarksFor：左右对称（格线随布局常量镜像）', () => {
    const marks = slotMarksFor(TW, TH)
    for (let i = 0; i < 7; i += 1) {
      const a = marks[i] as { x: number; w: number }
      const b = marks[6 - i] as { x: number; w: number }
      expect(a.x + a.w / 2 + (b.x + b.w / 2)).toBeCloseTo(TW)
    }
  })

  it('pileMarksFor：四角对称，中心落在 PILE 世界坐标', () => {
    const marks = pileMarksFor(TW, TH)
    expect(marks).toHaveLength(4)
    const centers = marks.map((m) => ({ x: m.x + m.w / 2, y: m.y + m.h / 2 })).sort((a, b) => a.x - b.x || a.y - b.y)
    const expected = [1, -1]
      .flatMap((sx) => [1, -1].map((sz) => worldToCanvas(PILE.deck.x * sx, PILE.deck.z * sz, TW, TH)))
      .sort((a, b) => a.x - b.x || a.y - b.y)
    for (let i = 0; i < 4; i += 1) {
      expect(centers[i]?.x).toBeCloseTo((expected[i] as { x: number }).x)
      expect(centers[i]?.y).toBeCloseTo((expected[i] as { y: number }).y)
    }
  })

  it('playAreaFor：战术区在台面画布范围内且不贴边', () => {
    const p = playAreaFor(TW, TH)
    expect(p.x).toBeGreaterThan(0)
    expect(p.y).toBeGreaterThan(0)
    expect(p.x + p.w).toBeLessThan(TW)
    expect(p.y + p.h).toBeLessThan(TH)
  })
})

describe('tableSkin/params 确定性布局派生', () => {
  it('backdropLayoutFor：同种子恒同输出；不同种子不同输出', () => {
    const a = backdropLayoutFor(SKIN_SEED.backdrop, 1024, 512)
    const b = backdropLayoutFor(SKIN_SEED.backdrop, 1024, 512)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    const c = backdropLayoutFor(SKIN_SEED.backdrop + 1, 1024, 512)
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a))
  })

  it('backdropLayoutFor：8 台机架 + LED 在画布内且色板合法 + 3 道柔光', () => {
    const { racks, leds, shafts } = backdropLayoutFor(SKIN_SEED.backdrop, 1024, 512)
    expect(racks).toHaveLength(8)
    for (const r of racks) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(1024)
      expect(r.y + r.h).toBeLessThanOrEqual(512)
      expect(r.units).toBeGreaterThanOrEqual(4)
    }
    expect(leds.length).toBeGreaterThanOrEqual(racks.length)
    for (const led of leds) {
      expect(led.x).toBeGreaterThanOrEqual(0)
      expect(led.x).toBeLessThanOrEqual(1024)
      expect(led.y).toBeGreaterThanOrEqual(0)
      expect(led.y).toBeLessThanOrEqual(512)
      expect(LED_PALETTE).toContain(led.color as (typeof LED_PALETTE)[number])
      expect(led.glow).toBeGreaterThanOrEqual(0.5)
      expect(led.glow).toBeLessThanOrEqual(1)
    }
    expect(shafts).toHaveLength(3)
    for (const s of shafts) {
      expect(s.alpha).toBeGreaterThan(0)
      expect(s.alpha).toBeLessThan(0.12)
    }
  })

  it('traceLayoutFor：数量精确、轴对齐、边界钳制、确定性', () => {
    const t1 = traceLayoutFor(SKIN_SEED.tableTop, 1024, 652, 50, 6)
    expect(t1).toHaveLength(50)
    for (const t of t1) {
      expect(t.x1 === t.x2 || t.y1 === t.y2).toBe(true)
      for (const v of [t.x1, t.x2]) {
        expect(v).toBeGreaterThanOrEqual(6)
        expect(v).toBeLessThanOrEqual(1024 - 6)
      }
      for (const v of [t.y1, t.y2]) {
        expect(v).toBeGreaterThanOrEqual(6)
        expect(v).toBeLessThanOrEqual(652 - 6)
      }
    }
    expect(JSON.stringify(t1)).toBe(JSON.stringify(traceLayoutFor(SKIN_SEED.tableTop, 1024, 652, 50, 6)))
  })
})

describe('tableSkin 派系染色融合（与 fx/theme 共存）', () => {
  it('theme=null 回落中性基线', () => {
    expect(wallTintFor(null)).toBe(NEUTRAL_WALL_TINT)
    expect(floorTintFor(null)).toBe(NEUTRAL_FLOOR_TINT)
  })

  it('主题染色输出 hex、偏离中性、确定性', () => {
    const theme = tableThemeFor('nvidia', 'amd')
    const w = wallTintFor(theme)
    expect(w).toMatch(/^#[0-9a-f]{6}$/)
    expect(w).not.toBe(NEUTRAL_WALL_TINT)
    expect(wallTintFor(theme)).toBe(w)
    const f = floorTintFor(theme)
    expect(f).toMatch(/^#[0-9a-f]{6}$/)
    expect(f).not.toBe(NEUTRAL_FLOOR_TINT)
  })

  it('墙面/地板横跨全场：双方镜像对局染色一致（对称融合）', () => {
    expect(wallTintFor(tableThemeFor('nvidia', 'amd'))).toBe(wallTintFor(tableThemeFor('amd', 'nvidia')))
    expect(floorTintFor(tableThemeFor('nvidia', 'amd'))).toBe(floorTintFor(tableThemeFor('amd', 'nvidia')))
  })

  it('不同派系组合染出不同色调', () => {
    expect(wallTintFor(tableThemeFor('nvidia', 'intel'))).not.toBe(wallTintFor(tableThemeFor('nvidia', 'amd')))
  })
})

describe('tableSkin 背景几何常量', () => {
  it('机架墙在三个演出机位下覆盖视野上缘（墙底入地、墙顶高于最抬头视线）', () => {
    // intro 机位自 (0,2.6,13.5) 上仰，视线在墙平面处的最高交点约 y≈8.9
    const top = BACKDROP_GEOMETRY.wallY + BACKDROP_GEOMETRY.wallH / 2
    const bottom = BACKDROP_GEOMETRY.wallY - BACKDROP_GEOMETRY.wallH / 2
    expect(top).toBeGreaterThanOrEqual(9.4)
    expect(bottom).toBeLessThanOrEqual(0)
    expect(BACKDROP_GEOMETRY.wallZ).toBeLessThan(-7) // 台面远端之外
  })
})

describe('AmbientDust 尘埃池', () => {
  afterEach(() => {
    setEffectQuality('high')
  })

  it('构造：挂入场景，容量与默认种子确定', () => {
    const scene = new THREE.Scene()
    const dust = new AmbientDust(scene)
    expect(scene.children).toContain(dust.points)
    expect(dust.activeCount).toBe(40)
  })

  it('update：位置推进且全部有限（定长缓冲内写，无 NaN）', () => {
    const scene = new THREE.Scene()
    const dust = new AmbientDust(scene)
    const pos = (dust.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const before = Array.from(pos)
    dust.update(0.016)
    let changed = 0
    for (let i = 0; i < pos.length; i += 1) {
      expect(Number.isFinite(pos[i])).toBe(true)
      if (pos[i] !== before[i]) changed += 1
    }
    expect(changed).toBeGreaterThan(0)
  })

  it('确定性：同种子实例在相同 dt 序列下位置完全一致', () => {
    const a = new AmbientDust(new THREE.Scene(), SKIN_SEED.dust, 40)
    const b = new AmbientDust(new THREE.Scene(), SKIN_SEED.dust, 40)
    for (let f = 0; f < 10; f += 1) {
      a.update(0.016)
      b.update(0.016)
    }
    const pa = (a.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    const pb = (b.points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array
    expect(Array.from(pa)).toEqual(Array.from(pb))
  })

  it('质量档联动：high 全量，low 减半（drawRange 收放）', () => {
    const dust = new AmbientDust(new THREE.Scene(), SKIN_SEED.dust, 40)
    dust.update(0.016)
    expect(dust.points.geometry.drawRange.count).toBe(40)
    setEffectQuality('low')
    dust.update(0.016)
    expect(dust.activeCount).toBe(20)
    expect(dust.points.geometry.drawRange.count).toBe(20)
  })

  it('dispose：脱离场景并释放几何/材质（dispose 被调用）', () => {
    const scene = new THREE.Scene()
    const dust = new AmbientDust(scene)
    const geo = dust.points.geometry
    const mat = dust.points.material as THREE.Material
    const geoSpy = vi.spyOn(geo, 'dispose')
    const matSpy = vi.spyOn(mat, 'dispose')
    dust.dispose()
    expect(scene.children).not.toContain(dust.points)
    expect(dust.points.parent).toBeNull()
    expect(geoSpy).toHaveBeenCalledTimes(1)
    expect(matSpy).toHaveBeenCalledTimes(1)
  })
})
