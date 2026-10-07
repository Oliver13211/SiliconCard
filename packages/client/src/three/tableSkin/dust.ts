/**
 * 环境尘埃微粒池（tableSkin 氛围层）——机房产内缓慢漂浮的微粒，空气感点睛。
 *
 * 与 fx/stageFx 同一套性能红线（本任务要求「复用既有粒子池体系，量要小」）：
 * - 单份 THREE.Points + 定长 Float32Array（1 draw call），update 循环零 new；
 * - 粒子不做发射/消亡（常驻氛围层），只做三轴正弦漂移——无需速度/寿命旁路缓冲；
 * - 质量档联动 fx/quality：low 档 drawRange 减半（scaleFxCount），'particles' 闸门
 *   关闭时整体隐藏（对应粒子类降级粒度）；
 * - 初始分布由固定种子 mulberry32 派生（确定性，禁 Math.random/Date）。
 *
 * 注：刻意不挂在 ParticlePool 上——事件粒子池（384 容量）是战斗演出的预算，
 * 常驻尘埃若与之共池会互相挤占「保新弃旧」回收名额，故独立微池、同套纪律。
 */

import * as THREE from 'three'
import { mulberry32 } from '../cardArt/color'
import { fxEnabled, scaleFxCount } from '../fx/quality'
import { SKIN_SEED } from './params'

/** 默认粒子数（low 档经 scaleFxCount 自动减半） */
export const DUST_BASE_COUNT = 40

// 程序化点纹理：径向柔边圆（模块级懒生成；无 DOM → null → 素色小方点仍可测试）
let dotTexture: THREE.Texture | null = null
function getDustTexture(): THREE.Texture | null {
  if (dotTexture) return dotTexture
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 32
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const g = ctx.createRadialGradient(16, 16, 1, 16, 16, 15)
  g.addColorStop(0, 'rgba(255,255,255,0.9)')
  g.addColorStop(0.55, 'rgba(255,255,255,0.4)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 32, 32)
  dotTexture = new THREE.CanvasTexture(canvas)
  return dotTexture
}

/**
 * 常驻尘埃池。update(dt) 只写预分配 position 缓冲（三轴异频正弦漂移），
 * drawRange 随质量档实时收放；结构满足 SceneManager.Updatable（不 import，避免环）。
 */
export class AmbientDust {
  readonly points: THREE.Points
  private readonly baseCount: number
  private readonly base: Float32Array
  private readonly phase: Float32Array
  private readonly amp: Float32Array
  private readonly freq: Float32Array
  private readonly posAttr: THREE.BufferAttribute
  private t = 0

  constructor(scene: THREE.Scene, seed: number = SKIN_SEED.dust, count: number = DUST_BASE_COUNT) {
    this.baseCount = count
    const rnd = mulberry32(seed)
    this.base = new Float32Array(count * 3)
    this.phase = new Float32Array(count * 3)
    this.amp = new Float32Array(count * 3)
    this.freq = new Float32Array(count * 3)
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3
      // 散布范围罩住牌桌与近景空气段（x ±8.5 / y 0.3..4.2 / z ±6）
      this.base[i3] = (rnd() - 0.5) * 17
      this.base[i3 + 1] = 0.3 + rnd() * 3.9
      this.base[i3 + 2] = (rnd() - 0.5) * 12
      for (let a = 0; a < 3; a += 1) {
        this.phase[i3 + a] = rnd() * Math.PI * 2
        this.amp[i3 + a] = 0.16 + rnd() * 0.5
        // 低频慢漂（rad/s）：y 轴最慢，像悬浮而非抖动
        this.freq[i3 + a] = a === 1 ? 0.07 + rnd() * 0.12 : 0.12 + rnd() * 0.28
      }
      this.amp[i3 + 1] = 0.1 + rnd() * 0.22
      positions[i3] = this.base[i3] as number
      positions[i3 + 1] = this.base[i3 + 1] as number
      positions[i3 + 2] = this.base[i3 + 2] as number
    }
    const geo = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(positions, 3)
    geo.setAttribute('position', this.posAttr)
    geo.setDrawRange(0, count)
    const mat = new THREE.PointsMaterial({
      size: 0.075,
      map: getDustTexture(),
      color: '#9fc4e2',
      transparent: true,
      opacity: 0.42,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 3
    this.points.name = 'ambient-dust'
    scene.add(this.points)
  }

  /** 当前参与渲染的粒子数（随全局质量档收放；纯整数运算，零分配） */
  get activeCount(): number {
    return scaleFxCount(this.baseCount)
  }

  update(dt: number): void {
    this.t += dt
    const n = this.activeCount
    this.points.geometry.setDrawRange(0, n)
    const vis = fxEnabled('particles')
    this.points.visible = vis
    if (!vis) return
    const pos = this.posAttr.array as Float32Array
    for (let i = 0; i < n; i += 1) {
      const i3 = i * 3
      pos[i3] = (this.base[i3] as number) + Math.sin(this.t * (this.freq[i3] as number) + (this.phase[i3] as number)) * (this.amp[i3] as number)
      pos[i3 + 1] = (this.base[i3 + 1] as number) + Math.sin(this.t * (this.freq[i3 + 1] as number) + (this.phase[i3 + 1] as number)) * (this.amp[i3 + 1] as number)
      pos[i3 + 2] = (this.base[i3 + 2] as number) + Math.sin(this.t * (this.freq[i3 + 2] as number) + (this.phase[i3 + 2] as number)) * (this.amp[i3 + 2] as number)
    }
    this.posAttr.needsUpdate = true
  }

  /** 氛围层不属于事件演出，快进不清场（保持常驻空气感） */
  dispose(): void {
    this.points.geometry.dispose()
    const mat = this.points.material as THREE.PointsMaterial
    mat.dispose()
    this.points.removeFromParent()
  }
}
