/**
 * M4-R3D5 无头测试：舞台特效池（性能红线：池化复用、快进清场、降级联动）。
 * 全部池可在无 DOM 的 node 环境构造（纹理注入或程序化纹理带 document 守卫）。
 */

import * as THREE from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import { setEffectQuality } from '../fx/quality'
import {
  BeamPool,
  BoltPool,
  CameraShaker,
  PillarPool,
  ProgressFx,
  RingPool,
  ParticlePool,
} from '../fx/stageFx'
import { ShardsPool } from '../fx/effects'

afterEach(() => {
  setEffectQuality('high')
})

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)

describe('ParticlePool（单 Points 承载，定长缓冲）', () => {
  it('发射 → 推进 → 寿命尽归零，槽位可复用（无泄漏）', () => {
    const pool = new ParticlePool(new THREE.Scene(), { capacity: 16, texture: new THREE.Texture() })
    pool.emitPreset(v3(), 'hitSpark')
    expect(pool.alive).toBeGreaterThan(0)
    for (let i = 0; i < 60; i += 1) pool.update(0.05) // 3s > 最长寿命
    expect(pool.alive).toBe(0)
    pool.emitPreset(v3(), 'healMote')
    expect(pool.alive).toBeGreaterThan(0) // 复用同一批槽位
    pool.finishAll()
    expect(pool.alive).toBe(0)
  })

  it('容量封顶：池满时保新弃旧，alive ≤ capacity', () => {
    const pool = new ParticlePool(new THREE.Scene(), { capacity: 4, texture: new THREE.Texture() })
    pool.emitPreset(v3(), 'confetti') // 配方 30 粒
    expect(pool.alive).toBe(4)
    pool.emitPreset(v3(), 'confetti') // 再发一轮：回收进度最深的粒子补位，新粒子全部上池
    expect(pool.alive).toBe(4)
    pool.update(0.016) // 推进一帧不炸、不新增
    expect(pool.alive).toBe(4)
  })

  it('中段死亡不变量：亮色槽位数恒等于存活数，drawRange 常开全容量', () => {
    const pool = new ParticlePool(new THREE.Scene(), { capacity: 4, texture: new THREE.Texture() })
    pool.emitPreset(v3(), 'hitSpark') // 4 粒，寿命带随机差 → 必有先后死亡
    let guard = 0
    while (pool.alive === 4 && guard < 1000) {
      pool.update(0.02)
      guard += 1
    }
    expect(pool.alive).toBeGreaterThan(0) // 中段：已有死亡、仍有存活
    expect(pool.alive).toBeLessThan(4)
    const { colors, drawCount } = pool.debugState
    expect(drawCount).toBe(4) // 常开全容量，不按 liveCount 截断（swap-remove 槽位非前缀）
    let lit = 0
    for (let s = 0; s < 4; s += 1) {
      if ((colors[s * 3] as number) > 0 || (colors[s * 3 + 1] as number) > 0 || (colors[s * 3 + 2] as number) > 0) {
        lit += 1
      }
    }
    expect(lit).toBe(pool.alive) // 不漏画高槽位存活粒子、死槽无残影
  })

  it('low 档：发射量自动减半', () => {
    const pool = new ParticlePool(new THREE.Scene(), { capacity: 256, texture: new THREE.Texture() })
    setEffectQuality('high')
    pool.emitPreset(v3(), 'goldBurst') // 16 粒
    const high = pool.alive
    pool.finishAll()
    setEffectQuality('low')
    pool.emitPreset(v3(), 'goldBurst')
    expect(pool.alive).toBeLessThanOrEqual(Math.ceil(high / 2))
    expect(pool.alive).toBeGreaterThan(0)
  })
})

describe('RingPool / PillarPool / BoltPool / BeamPool / ProgressFx', () => {
  it('RingPool：spawn → 扩散推进 → 熄灭 → 可复用', () => {
    const rings = new RingPool(new THREE.Scene(), 2)
    rings.spawn(v3(1, 0.5, 1), '#ffc53d', 1.6, 0.5)
    expect(rings.activeCount).toBe(1)
    rings.update(0.6)
    expect(rings.activeCount).toBe(0)
    rings.spawn(v3(), '#ff0000', 1, 0.4)
    expect(rings.activeCount).toBe(1)
  })

  it('Pillars：high 档可见、low 档 spawn 直接跳过（降级联动）', () => {
    const pillars = new PillarPool(new THREE.Scene(), 2)
    pillars.spawn(v3(), '#ff9d2e', 0.9)
    expect(pillars.activeCount).toBe(1)
    pillars.finishAll()
    setEffectQuality('low')
    pillars.spawn(v3(), '#ff9d2e', 0.9)
    expect(pillars.activeCount).toBe(0)
  })

  it('BoltPool：电弧存活→寿命尽熄灭', () => {
    const bolts = new BoltPool(new THREE.Scene(), 2)
    bolts.spawn(v3(0, 2, 0), v3(1, 0, 0), '#ffd23d')
    expect(bolts.activeCount).toBe(1)
    bolts.update(0.4)
    expect(bolts.activeCount).toBe(0)
  })

  it('BeamPool：光束打点→衰减→熄灭', () => {
    const beams = new BeamPool(new THREE.Scene(), 1)
    beams.spawn(v3(0, 1, 0), v3(3, 0.5, -2), '#ff2a2a')
    expect(beams.activeCount).toBe(1)
    beams.update(0.6)
    expect(beams.activeCount).toBe(0)
  })

  it('ProgressFx：分段进度播放完自动隐藏；finishAll 立即清场', () => {
    const fx = new ProgressFx(new THREE.Scene())
    fx.spawn(v3(0, 0.6, 2.9), 0.9)
    expect(fx.activeCount).toBe(1)
    expect(fx.group.visible).toBe(true)
    fx.update(0.3)
    expect(fx.group.visible).toBe(true) // 22%→67% 分段中
    fx.update(0.8)
    expect(fx.activeCount).toBe(0) // 播完隐藏
    fx.spawn(v3(), 0.9)
    fx.finishAll()
    expect(fx.group.visible).toBe(false)
  })
})

describe('CameraShaker（trauma² 衰减，仅旋转偏移）', () => {
  it('注入 → 衰减到 0；快进立即清零', () => {
    const shaker = new CameraShaker()
    shaker.addTrauma(0.5)
    expect(shaker.traumaLevel).toBeCloseTo(0.5)
    const camera = new THREE.PerspectiveCamera()
    shaker.apply(camera, 0.016)
    expect(shaker.traumaLevel).toBeLessThan(0.5)
    for (let i = 0; i < 120; i += 1) shaker.apply(camera, 0.05) // 6s ≫ 衰减期
    expect(shaker.traumaLevel).toBe(0)
    shaker.addTrauma(0.9)
    shaker.finishAll()
    expect(shaker.traumaLevel).toBe(0)
  })

  it('叠加封顶 1；low 档注入无效', () => {
    const shaker = new CameraShaker()
    shaker.addTrauma(0.7)
    shaker.addTrauma(0.7)
    expect(shaker.traumaLevel).toBe(1)
    setEffectQuality('low')
    shaker.finishAll()
    shaker.addTrauma(0.5)
    expect(shaker.traumaLevel).toBe(0)
  })
})

describe('ShardsPool × 质量档（死亡碎裂的降级开关）', () => {
  it('high 档爆 3×3 碎片；low 档 burst 直接跳过', () => {
    const scene = new THREE.Scene()
    const shards = new ShardsPool(scene)
    shards.burst(v3(), null, 0)
    expect(shards.activeCount).toBe(9)
    shards.finishAll()
    setEffectQuality('low')
    shards.burst(v3(), null, 0)
    expect(shards.activeCount).toBe(0)
  })
})
