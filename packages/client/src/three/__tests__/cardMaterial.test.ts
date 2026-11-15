/**
 * P2-R3D1 无头测试：卡牌拟真材质（cardMaterial/*）。
 * - normalSpec：layout 几何纯函数派生（禁像素分析）——确定性 / 档位单调 /
 *   与 cardArt/layout 锚点对齐 / JSON 可序列化 / 缓存键扩展；
 * - normalCache：TextureCache 同体系缓存键扩展——同键同实例、无头不占位、
 *   数据贴图线性色域、dispose 无泄漏；
 * - materials：共享 MeshPhysicalMaterial 注册表——同档恒同实例、≤5 档上限、
 *   传说 clearcoat+iridescence、共享标记；
 * - CardEntity 集成：setCoat 换共享引用、quality 门 low/high 切换不重建几何
 *   不泄漏材质、池 dispose 跳过共享实例；
 * - studioEnvLayout：程序化环境贴图光带布局确定性。
 * 材质构造仅依赖 THREE 数学库，不触发 WebGL，可无头运行。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { ART_WINDOW, COST_BADGE, FACE_H, FACE_W, GEM, RARITY_GEM } from '../cardArt/layout'
import type { RarityTier } from '../cardArt/derive'
import { disposeSharedOutlineMaterials } from '../cardOutline'
import { TextureCache } from '../CardFace'
import { CardEntity, CardEntityPool } from '../CardEntity'
import { cardBackNormalSpec, cardNormalCacheKey, cardNormalSpecFor } from '../cardMaterial/normalSpec'
import { normalTextureFor } from '../cardMaterial/normalCache'
import {
  backPhysicalMaterialFor,
  cardMaterialCount,
  cardMaterialLimit,
  coatMaterialFor,
  disposeSharedCardMaterials,
  isSharedCardMaterial,
} from '../cardMaterial/materials'
import { studioEnvLayout } from '../cardMaterial/studioEnv'
import { setEffectQuality } from '../fx/quality'

const TIERS: readonly RarityTier[] = ['common', 'rare', 'epic', 'legendary']

afterEach(() => {
  setEffectQuality('high') // 防串测
})

describe('cardNormalSpecFor（法线规格派生，纯函数禁像素分析）', () => {
  it('确定性：同档恒同输出（禁 Math.random/Date 泄入）', () => {
    for (const tier of TIERS) {
      expect(cardNormalSpecFor(tier)).toEqual(cardNormalSpecFor(tier))
    }
    expect(cardBackNormalSpec()).toEqual(cardBackNormalSpec())
  })

  it('几何对齐：画布尺寸与凹凸锚点来自 cardArt/layout（无第二份硬编码）', () => {
    const spec = cardNormalSpecFor('legendary')
    expect(spec.w).toBe(FACE_W)
    expect(spec.h).toBe(FACE_H)
    expect(spec.windowPit.x).toBe(ART_WINDOW.x)
    expect(spec.windowPit.w).toBe(ART_WINDOW.w)
    expect(spec.windowPit.r).toBe(ART_WINDOW.r)
    expect(spec.costBadge.cx).toBe(COST_BADGE.x)
    expect(spec.costBadge.cy).toBe(COST_BADGE.y)
    // 宝石锚点同源
    expect(cardNormalSpecFor('epic').gem?.cx).toBe(GEM.x)
  })

  it('稀有度条件特征与卡面绘制同源：common 无宝石/无环，epic/legendary 有高光带', () => {
    const common = cardNormalSpecFor('common')
    expect(common.gem).toBeNull()
    expect(common.rarityRing).toBeNull()
    expect(common.topBand).toBeNull()
    // common 无宝石 = RARITY_GEM.common 为 null（同源判定）
    expect(RARITY_GEM.common).toBeNull()

    for (const tier of ['rare', 'epic', 'legendary'] as const) {
      const spec = cardNormalSpecFor(tier)
      if (RARITY_GEM[tier] !== null) expect(spec.gem).not.toBeNull()
      expect(spec.rarityRing).not.toBeNull()
    }
    expect(cardNormalSpecFor('epic').topBand).not.toBeNull()
    expect(cardNormalSpecFor('legendary').topBand).not.toBeNull()
  })

  it('档位单调：浮雕强度随稀有度上调（common 最平 → legendary 最强）', () => {
    let lastFrame = -1
    let lastPit = -1
    let lastBadge = -1
    for (const tier of TIERS) {
      const spec = cardNormalSpecFor(tier)
      expect(spec.frame.sOuter).toBeGreaterThan(lastFrame)
      expect(spec.windowPit.sInner).toBeGreaterThan(lastPit)
      expect(spec.costBadge.sOuter).toBeGreaterThan(lastBadge)
      lastFrame = spec.frame.sOuter
      lastPit = spec.windowPit.sInner
      lastBadge = spec.costBadge.sOuter
    }
  })

  it('数值健全：全部有限、坡宽为正、强度 ≤1；可 JSON 序列化（纯数据契约）', () => {
    for (const tier of TIERS) {
      const spec = cardNormalSpecFor(tier)
      const round = JSON.parse(JSON.stringify(spec)) as typeof spec
      expect(round).toEqual(spec)
      const rects = [spec.frame, spec.windowPit, spec.hairline, spec.rarityRing, spec.topBand].filter(
        (r) => r !== null,
      )
      const circles = [spec.costBadge, spec.gem].filter((c) => c !== null)
      for (const r of rects) {
        for (const v of [r.x, r.y, r.w, r.h, r.r, r.outer, r.inner, r.sOuter, r.sInner]) {
          expect(Number.isFinite(v as number)).toBe(true)
        }
        expect(r.outer).toBeGreaterThan(0)
        expect(Math.abs(r.sOuter)).toBeLessThanOrEqual(1)
        expect(Math.abs(r.sInner)).toBeLessThanOrEqual(1)
      }
      for (const c of circles) {
        for (const v of [c.cx, c.cy, c.r, c.outer, c.sOuter]) {
          expect(Number.isFinite(v as number)).toBe(true)
        }
        expect(c.outer).toBeGreaterThan(0)
        expect(Math.abs(c.sOuter)).toBeLessThanOrEqual(1)
      }
    }
  })

  it('槽（groove）方向约定：hairline 与稀有度环为负强度（坡向翻转朝脊线）', () => {
    const spec = cardNormalSpecFor('legendary')
    expect(spec.hairline.sOuter).toBeLessThan(0)
    expect(spec.hairline.sInner).toBeLessThan(0)
    expect(spec.rarityRing?.sOuter).toBeLessThan(0)
    expect(spec.rarityRing?.sInner).toBeLessThan(0)
    // 插画窗下沉：内坡（坑壁）朝窗内、外唇沿轻微凸起
    expect(spec.windowPit.sInner).toBeGreaterThan(0)
    expect(spec.windowPit.sOuter).toBeGreaterThan(0)
    expect(spec.windowPit.sOuter).toBeLessThan(spec.windowPit.sInner)
  })
})

describe('cardNormalCacheKey（缓存键扩展）', () => {
  it('四档 + 卡背各一稳定键，互不相同', () => {
    const keys = [...TIERS, 'back' as const].map((t) => cardNormalCacheKey(t))
    expect(new Set(keys).size).toBe(5)
    for (const k of keys) expect(k).toMatch(/^normal\|/)
    expect(cardNormalCacheKey('legendary')).toBe(cardNormalCacheKey('legendary'))
  })
})

describe('normalTextureFor（TextureCache 同体系缓存，无泄漏）', () => {
  /** 无头环境用最小画布桩（CanvasTexture 构造不触碰 DOM） */
  const stubCanvas = (): HTMLCanvasElement => ({ width: 8, height: 8 } as unknown as HTMLCanvasElement)

  it('同键恒同实例（不重绘）；不同键不同实例', () => {
    const cache = new TextureCache()
    const painter = vi.fn(stubCanvas)
    const a = normalTextureFor(cache, cardNormalCacheKey('rare'), painter)
    const b = normalTextureFor(cache, cardNormalCacheKey('rare'), painter)
    expect(a).toBe(b)
    expect(painter).toHaveBeenCalledTimes(1) // 缓存命中不重绘
    const c = normalTextureFor(cache, cardNormalCacheKey('epic'), painter)
    expect(c).not.toBe(a)
    expect(painter).toHaveBeenCalledTimes(2)
    cache.dispose()
  })

  it('数据贴图必须线性：入库后纠正为 NoColorSpace（法线不是 albedo）', () => {
    const cache = new TextureCache()
    const tex = normalTextureFor(cache, cardNormalCacheKey('common'), stubCanvas)
    expect(tex?.colorSpace).toBe(THREE.NoColorSpace)
    cache.dispose()
  })

  it('无头环境（paint 返回 null）：返回 null 且不占缓存位（不泄漏空键）', () => {
    const cache = new TextureCache()
    const tex = normalTextureFor(cache, cardNormalCacheKey('common'), () => null)
    expect(tex).toBeNull()
    expect(cache.size).toBe(0)
  })

  it('cache.dispose 清空全部法线纹理（无泄漏）', () => {
    const cache = new TextureCache()
    for (const t of [...TIERS, 'back' as const]) {
      normalTextureFor(cache, cardNormalCacheKey(t), stubCanvas)
    }
    expect(cache.size).toBe(5)
    const tex = cache.get(cardNormalCacheKey('legendary')) as THREE.Texture
    const spy = vi.spyOn(tex, 'dispose')
    cache.dispose()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(cache.size).toBe(0)
  })
})

describe('共享 MeshPhysicalMaterial 注册表（≤5 档，禁 per-card 克隆）', () => {
  beforeEach(() => {
    disposeSharedCardMaterials()
  })

  it('同档恒同实例；四档 + 卡背 = 恰好 ≤5 个共享实例', () => {
    const coats = TIERS.map((t) => coatMaterialFor(t, null))
    expect(coatMaterialFor('rare', null)).toBe(coats[1]) // 同档二次调用不新建
    expect(cardMaterialCount()).toBe(4)
    const back = backPhysicalMaterialFor(new THREE.Texture())
    expect(backPhysicalMaterialFor(new THREE.Texture())).toBe(back) // 卡背唯一
    expect(cardMaterialCount()).toBe(5)
    expect(cardMaterialCount()).toBeLessThanOrEqual(cardMaterialLimit())
    expect(new Set(coats).size).toBe(4)
  })

  it('传说档 clearcoat + iridescence 全息闪层；其余档不开启；纸面粗糙度 0.7', () => {
    for (const tier of TIERS) {
      const mat = coatMaterialFor(tier, null)
      expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial)
      expect(mat.roughness).toBe(0.7) // 任务书：纸面 0.7（金属框感由法线强度体现）
      expect(mat.blending).toBe(THREE.AdditiveBlending) // 加色箔层
      expect(mat.depthWrite).toBe(false)
      if (tier === 'legendary') {
        expect(mat.clearcoat).toBeGreaterThan(0)
        expect(mat.iridescence).toBeGreaterThan(0)
        expect(mat.iridescenceThicknessRange.length).toBe(2)
      } else {
        expect(mat.clearcoat).toBe(0)
        expect(mat.iridescence).toBe(0)
      }
    }
  })

  it('法线贴图注入首建材质；共享标记供 dispose 遍历跳过', () => {
    const normal = new THREE.Texture()
    const mat = coatMaterialFor('epic', normal)
    expect(mat.normalMap).toBe(normal)
    expect(isSharedCardMaterial(mat)).toBe(true)
    expect(isSharedCardMaterial(backPhysicalMaterialFor(new THREE.Texture()))).toBe(true)
  })

  it('disposeSharedCardMaterials：实例全部释放且计数归零（仅测试隔离用）', () => {
    for (const t of TIERS) coatMaterialFor(t, null)
    const back = backPhysicalMaterialFor(new THREE.Texture())
    const spy = vi.spyOn(back, 'dispose')
    expect(cardMaterialCount()).toBe(5)
    disposeSharedCardMaterials()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(cardMaterialCount()).toBe(0)
    // 释放后可重建（幂等）
    expect(coatMaterialFor('common', null)).toBeDefined()
    expect(cardMaterialCount()).toBe(1)
  })
})

describe('CardEntity 拟真材质集成', () => {
  beforeEach(() => {
    disposeSharedCardMaterials()
    disposeSharedOutlineMaterials()
  })

  function makeEntity(): CardEntity {
    return new CardEntity(new THREE.Texture())
  }

  it('setCoat 换共享引用（同档恒同实例，零克隆）；未设置时箔层隐藏', () => {
    const e = makeEntity()
    e.update(0.016)
    expect(e.coatMesh.visible).toBe(false) // 未 setCoat（ghost/对手手牌形态）
    const normal = new THREE.Texture()
    e.setCoat('legendary', normal)
    expect(e.coatMesh.material).toBe(coatMaterialFor('legendary', normal))
    e.update(0.016)
    expect(e.coatMesh.visible).toBe(true)
    // 同档二次设置命中同一共享实例
    e.setCoat('legendary', normal)
    expect(e.coatMesh.material).toBe(coatMaterialFor('legendary', normal))
  })

  it('low/high 切换：箔层显隐 + 卡背 Basic↔Physical 换引用；几何不重建、材质零泄漏', () => {
    const e = makeEntity()
    const normal = new THREE.Texture()
    e.setCoat('epic', normal)
    e.update(0.016)
    const physical = coatMaterialFor('epic', normal)
    expect(e.coatMesh.visible).toBe(true)
    expect(e.coatMesh.material).toBe(physical)
    const backPhys = backPhysicalMaterialFor(new THREE.Texture())
    expect(e.backMesh.material).toBe(backPhys)
    const backGeo = e.backMesh.geometry
    const coatGeo = e.coatMesh.geometry

    const countBefore = cardMaterialCount()
    setEffectQuality('low')
    e.update(0.016)
    expect(e.coatMesh.visible).toBe(false)
    expect(e.coatMesh.material).toBe(physical) // 引用保留，仅隐藏
    expect(e.backMesh.material).not.toBe(backPhys) // 直通旧扁平材质
    expect(e.backMesh.material).toBeInstanceOf(THREE.MeshBasicMaterial)
    setEffectQuality('high')
    e.update(0.016)
    expect(e.coatMesh.visible).toBe(true)
    expect(e.backMesh.material).toBe(backPhys)
    // 切换不重建几何、不新建材质
    expect(e.backMesh.geometry).toBe(backGeo)
    expect(e.coatMesh.geometry).toBe(coatGeo)
    expect(cardMaterialCount()).toBe(countBefore)
  })

  it('淡出时隐藏箔层（烧卡/飞入演出不留浮层）；箔层不带拾取信息（射线语义不变）', () => {
    const e = makeEntity()
    e.setCoat('rare', null)
    e.update(0.016)
    expect(e.coatMesh.visible).toBe(true)
    e.opacity = 0.2
    e.update(0.016)
    expect(e.coatMesh.visible).toBe(false)
    expect(e.coatMesh.userData.pick).toBeUndefined()
  })

  it('reset 归位：档位清除、箔层隐藏；几何/共享材质不销毁', () => {
    const e = makeEntity()
    e.setCoat('legendary', null)
    e.update(0.016)
    e.reset()
    e.update(0.016)
    expect(e.coatMesh.visible).toBe(false)
    expect(e.coatMesh.material).not.toBe(coatMaterialFor('legendary', null))
  })

  it('池 dispose 跳过共享拟真材质（场景销毁不弄坏后续场景）', () => {
    const scene = new THREE.Scene()
    const pool = new CardEntityPool(scene, () => new THREE.Texture())
    const e = pool.acquire()
    const normal = new THREE.Texture()
    e.setCoat('common', normal)
    const sharedCoat = coatMaterialFor('common', normal)
    const sharedBack = backPhysicalMaterialFor(new THREE.Texture())
    const coatSpy = vi.spyOn(sharedCoat, 'dispose')
    const backSpy = vi.spyOn(sharedBack, 'dispose')
    pool.release(e)
    pool.dispose()
    expect(coatSpy).not.toHaveBeenCalled()
    expect(backSpy).not.toHaveBeenCalled()
  })
})

describe('studioEnvLayout（程序化环境贴图光带布局，纯函数）', () => {
  it('确定性：同输入恒同输出', () => {
    expect(JSON.stringify(studioEnvLayout())).toBe(JSON.stringify(studioEnvLayout()))
  })

  it('布光结构：多块光带面光源（暖顶主光 + 冷补光 + 轮廓光），亮度增益 HDR', () => {
    const strips = studioEnvLayout()
    expect(strips.length).toBeGreaterThanOrEqual(4)
    for (const s of strips) {
      for (const v of [s.x, s.y, s.z, s.w, s.h, s.rotX, s.rotY, s.boost]) {
        expect(Number.isFinite(v)).toBe(true)
      }
      expect(s.w).toBeGreaterThan(0)
      expect(s.h).toBeGreaterThan(0)
      expect(s.boost).toBeGreaterThan(0)
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/)
    }
    // 顶主光带在最上方（y 最大）且为暖色（R > B）
    const top = [...strips].sort((a, b) => b.y - a.y)[0] as { y: number; color: string }
    expect(top.y).toBeGreaterThanOrEqual(3)
    const warm = parseInt(top.color.slice(1), 16)
    expect((warm >> 16) & 0xff).toBeGreaterThan(warm & 0xff)
  })
})
