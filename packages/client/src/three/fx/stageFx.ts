/**
 * 舞台特效池集合（M4-R3D5 第二阶段：动效与特效升级）。
 *
 * 性能红线（design-report §3.4 + 本任务要求 6）：
 * - 一切特效**预分配、池化复用**：粒子用单份 THREE.Points（1 次 draw call）+
 *   定长 Float32Array 缓冲，光环/光柱/电弧/光束/进度条为定容 mesh 池；
 * - 渲染循环（update）内**零 new**：帧内只写预分配缓冲、原位压缩存活表；
 * - spawn 时读取全局质量开关（fx/quality），low 档粒子减半、重型特效直接跳过；
 * - 纹理程序化生成（document 守卫，无 DOM 环境可构造池供无头测试）；
 * - finishAll() 供演出快进一步清场，dispose() 释放全部资源。
 *
 * 池清单：
 * - ParticlePool   点粒子（命中火花/治疗上升/灰尘/余烬/金色迸发/拖迹/彩带）
 * - RingPool       地面扩散光环（格挡涟漪/落场冲击/护甲涟漪）
 * - PillarPool     竖直光柱（传说入场/召唤/传送）
 * - BoltPool       折线电弧（跳闸/光追失败）
 * - BeamPool       直射光束（开光追）
 * - ProgressFx     驱动更新进度条（intel 专属，单实例复用）
 * - CameraShaker   镜头微震（trauma² 衰减模型，仅旋转偏移不与机位 rig 打架）
 */

import * as THREE from 'three'
import { fxEnabled, scaleFxCount } from './quality'

// —— 程序化纹理（模块级懒生成，document 守卫保证 node 可构造池） ——

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  return ctx ? { canvas, ctx } : null
}

let dotTexture: THREE.Texture | null = null
/** 粒子点纹理：径向柔边圆（无 DOM 环境返回 null → 素色方点，仍可测试） */
function getDotTexture(): THREE.Texture | null {
  if (dotTexture) return dotTexture
  const made = makeCanvas(64, 64)
  if (!made) return null
  const g = made.ctx.createRadialGradient(32, 32, 2, 32, 32, 30)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.5, 'rgba(255,255,255,0.55)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  made.ctx.fillStyle = g
  made.ctx.fillRect(0, 0, 64, 64)
  dotTexture = new THREE.CanvasTexture(made.canvas)
  return dotTexture
}

let beamGradTexture: THREE.Texture | null = null
/** 光柱纵向渐变：两端透明中段亮（无 DOM 环境返回 null → 纯色柱） */
function getBeamGradient(): THREE.Texture | null {
  if (beamGradTexture) return beamGradTexture
  const made = makeCanvas(8, 128)
  if (!made) return null
  const g = made.ctx.createLinearGradient(0, 0, 0, 128)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)')
  g.addColorStop(0.8, 'rgba(255,255,255,0.5)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  made.ctx.fillStyle = g
  made.ctx.fillRect(0, 0, 8, 128)
  beamGradTexture = new THREE.CanvasTexture(made.canvas)
  return beamGradTexture
}

// —— 粒子 ——

/** 粒子发射参数（PRESETS 消费；一次性构造，颜色转 THREE.Color 复用） */
export interface ParticleEmitSpec {
  count: number
  color: string
  /** 初速标量（向四周球面散布） */
  speed: number
  /** 额外向上初速 */
  up: number
  /** y 加速度（负 = 重力下落） */
  gravity: number
  life: number
  size: number
  /** 出生位置散布半径 */
  spread: number
  /** 速度阻尼系数/秒（默认 0.6） */
  drag?: number
}

/** 事件演出粒子配方（key 即 ParticlePresetName；颜色在此定格为 Color 实例避免逐次解析） */
export const PARTICLE_PRESETS = {
  hitSpark: { count: 14, color: '#ff6a4d', speed: 2.6, up: 1.2, gravity: -6.5, life: 0.5, size: 0.09, spread: 0.18 },
  healMote: { count: 10, color: '#4ade80', speed: 0.35, up: 1.5, gravity: 0.4, life: 0.9, size: 0.08, spread: 0.5 },
  dust: { count: 8, color: '#9a8f7d', speed: 1.1, up: 0.5, gravity: -3.2, life: 0.6, size: 0.08, spread: 0.4 },
  ember: { count: 12, color: '#ffb14d', speed: 1.4, up: 2.0, gravity: -2.2, life: 0.8, size: 0.07, spread: 0.35 },
  goldBurst: { count: 16, color: '#ffc53d', speed: 2.2, up: 2.2, gravity: -2.0, life: 0.7, size: 0.09, spread: 0.25 },
  legendSpark: { count: 22, color: '#ff9d2e', speed: 2.8, up: 2.6, gravity: -3.5, life: 0.9, size: 0.1, spread: 0.5 },
  drawStreak: { count: 3, color: '#35d0ff', speed: 0.4, up: 0.2, gravity: 0, life: 0.35, size: 0.07, spread: 0.08 },
  armorUp: { count: 10, color: '#c8d4dd', speed: 0.5, up: 1.3, gravity: 0.2, life: 0.8, size: 0.08, spread: 0.45 },
  confetti: { count: 30, color: '#ffd23d', speed: 3.4, up: 3.2, gravity: -5.5, life: 1.2, size: 0.09, spread: 0.6 },
  dustClean: { count: 12, color: '#b9b2a4', speed: 1.6, up: 0.9, gravity: -4.0, life: 0.55, size: 0.07, spread: 0.3 },
  topsBurst: { count: 18, color: '#6f8bff', speed: 2.6, up: 2.2, gravity: -4.2, life: 0.7, size: 0.09, spread: 0.3 },
  teleport: { count: 16, color: '#7fd8ff', speed: 0.7, up: 2.4, gravity: 1.2, life: 0.8, size: 0.08, spread: 0.4 },
} as const satisfies Record<string, ParticleEmitSpec>

export type ParticlePresetName = keyof typeof PARTICLE_PRESETS

/** 预解析的配方颜色（按色值串建键，模块构造一次，spawn 只 copy 不 parse） */
const PRESET_COLOR_BY_HEX = new Map<string, THREE.Color>(
  Object.values(PARTICLE_PRESETS).map((v) => [v.color, new THREE.Color(v.color)]),
)
const FALLBACK_COLOR = new THREE.Color('#ffffff')

interface ParticlePoolOptions {
  capacity?: number
  /** 注入纹理（测试用）；缺省用程序化点纹理 */
  texture?: THREE.Texture | null
}

/**
 * 点粒子池：单份 THREE.Points 承载全部粒子（1 draw call）。
 * 位置/颜色进定长 BufferAttribute，速度/寿命进旁路 Float32Array；
 * 加色混合下「颜色乘衰减系数→黑」即视觉淡出（无需逐粒子材质）。
 */
export class ParticlePool {
  readonly points: THREE.Points
  private readonly cap: number
  private readonly posAttr: THREE.BufferAttribute
  private readonly colAttr: THREE.BufferAttribute
  private readonly positions: Float32Array
  private readonly colors: Float32Array
  private readonly baseCol: Float32Array
  private readonly vel: Float32Array
  private readonly age: Float32Array
  private readonly life: Float32Array
  private readonly size: Float32Array
  private readonly grav: Float32Array
  private readonly drag: Float32Array
  private readonly free: Int32Array
  private freeTop = 0
  /** 存活粒子索引表（原位压缩，swap-remove） */
  private readonly liveIdx: Int32Array
  private liveCount = 0

  constructor(scene: THREE.Scene, opts: ParticlePoolOptions = {}) {
    this.cap = opts.capacity ?? 256
    const n = this.cap
    this.positions = new Float32Array(n * 3)
    this.colors = new Float32Array(n * 3)
    this.baseCol = new Float32Array(n * 3)
    this.vel = new Float32Array(n * 3)
    this.age = new Float32Array(n)
    this.life = new Float32Array(n)
    this.size = new Float32Array(n)
    this.grav = new Float32Array(n)
    this.drag = new Float32Array(n)
    this.free = new Int32Array(n)
    this.liveIdx = new Int32Array(n)
    for (let i = 0; i < n; i += 1) this.free[i] = n - 1 - i // 栈：push 顺序无关紧要
    this.freeTop = n

    const geo = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(this.positions, 3)
    this.colAttr = new THREE.BufferAttribute(this.colors, 3)
    geo.setAttribute('position', this.posAttr)
    geo.setAttribute('color', this.colAttr)
    // drawRange 常开全容量：存活与否由颜色决定（死亡槽位清零 → 加色混合下黑 = 不可见）。
    // 不能 setDrawRange(0, liveCount)——liveIdx 是 swap-remove 的任意槽位集合，
    // 与「前缀槽位」不对应，会漏画高槽位存活粒子、画出死槽残影。
    geo.setDrawRange(0, this.cap)
    const tex = opts.texture !== undefined ? opts.texture : getDotTexture()
    const mat = new THREE.PointsMaterial({
      size: 0.1,
      map: tex,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 18
    scene.add(this.points)
  }

  get alive(): number {
    return this.liveCount
  }

  get capacity(): number {
    return this.cap
  }

  /** 按配方在 pos 发射一组粒子（low 质量自动减半；池满时回收进度最深的粒子补位——保新弃旧） */
  emitPreset(pos: THREE.Vector3, name: ParticlePresetName, scale = 1): void {
    const spec = PARTICLE_PRESETS[name]
    if (!spec) return
    const count = scaleFxCount(Math.round(spec.count * scale))
    for (let i = 0; i < count; i += 1) this.spawnOne(pos, spec)
  }

  private spawnOne(pos: THREE.Vector3, spec: ParticleEmitSpec): void {
    let slot: number
    if (this.freeTop > 0) {
      // 不变量：freeTop ∈ (0, cap]，栈内元素均为合法槽位
      slot = this.free[--this.freeTop] as number
    } else {
      // 池满：回收存活表中进度最深（age/life 最大）的粒子——保新弃旧，零分配。
      // killAt 会把该槽归还 free 栈，随即从栈顶取回同一槽；不得越过 free 栈
      // 直接复用 slot，否则栈里留下幽灵空闲条目，下一次 spawn 会弹出台账中的活槽。
      let worst = 0
      let worstT = -1
      for (let i = 0; i < this.liveCount; i += 1) {
        const s = this.liveIdx[i] as number
        const t = (this.age[s] as number) / (this.life[s] as number)
        if (t > worstT) {
          worstT = t
          worst = i
        }
      }
      this.killAt(worst)
      slot = this.free[--this.freeTop] as number
    }
    const i3 = slot * 3
    const a = Math.random() * Math.PI * 2
    const b = (Math.random() - 0.5) * Math.PI
    const sp = spec.speed * (0.5 + Math.random() * 0.7)
    this.positions[i3] = pos.x + (Math.random() - 0.5) * spec.spread
    this.positions[i3 + 1] = pos.y + (Math.random() - 0.5) * spec.spread
    this.positions[i3 + 2] = pos.z + (Math.random() - 0.5) * spec.spread
    this.vel[i3] = Math.cos(a) * Math.cos(b) * sp
    this.vel[i3 + 1] = Math.sin(b) * sp + spec.up
    this.vel[i3 + 2] = Math.sin(a) * Math.cos(b) * sp
    // 配方色已预解析，spawn 只拷贝不 parse
    const c = PRESET_COLOR_BY_HEX.get(spec.color) ?? FALLBACK_COLOR
    this.baseCol[i3] = c.r
    this.baseCol[i3 + 1] = c.g
    this.baseCol[i3 + 2] = c.b
    this.age[slot] = 0
    this.life[slot] = spec.life * (0.75 + Math.random() * 0.5)
    this.size[slot] = spec.size
    this.grav[slot] = spec.gravity
    this.drag[slot] = spec.drag ?? 0.6
    this.liveIdx[this.liveCount] = slot
    this.liveCount += 1
  }

  /** 从存活表移除下标 k 的粒子并归还 free 栈（swap-remove，零分配）；死亡槽位颜色立即清零隐身 */
  private killAt(k: number): void {
    const slot = this.liveIdx[k] as number
    const i3 = slot * 3
    this.colors[i3] = 0
    this.colors[i3 + 1] = 0
    this.colors[i3 + 2] = 0
    this.liveIdx[k] = this.liveIdx[this.liveCount - 1] as number
    this.liveCount -= 1
    this.free[this.freeTop] = slot
    this.freeTop += 1
  }

  update(dt: number): void {
    for (let k = 0; k < this.liveCount; ) {
      // 不变量：liveIdx[0..liveCount) 均为 [0, cap) 的合法槽位（构造/killAt 维护）
      const slot = this.liveIdx[k] as number
      const i3 = slot * 3
      this.age[slot] = (this.age[slot] as number) + dt
      if ((this.age[slot] as number) >= (this.life[slot] as number)) {
        this.killAt(k) // killAt 换入了新下标，原地重查
        continue
      }
      const damp = 1 - Math.min(1, (this.drag[slot] as number) * dt)
      this.vel[i3] = (this.vel[i3] as number) * damp
      this.vel[i3 + 1] = (this.vel[i3 + 1] as number) * damp + (this.grav[slot] as number) * dt
      this.vel[i3 + 2] = (this.vel[i3 + 2] as number) * damp
      this.positions[i3] = (this.positions[i3] as number) + (this.vel[i3] as number) * dt
      this.positions[i3 + 1] = (this.positions[i3 + 1] as number) + (this.vel[i3 + 1] as number) * dt
      this.positions[i3 + 2] = (this.positions[i3 + 2] as number) + (this.vel[i3 + 2] as number) * dt
      const t = (this.age[slot] as number) / (this.life[slot] as number)
      const fade = t < 0.12 ? t / 0.12 : 1 - (t - 0.12) / 0.88
      this.colors[i3] = (this.baseCol[i3] as number) * fade
      this.colors[i3 + 1] = (this.baseCol[i3 + 1] as number) * fade
      this.colors[i3 + 2] = (this.baseCol[i3 + 2] as number) * fade
      k += 1
    }
    this.posAttr.needsUpdate = true
    this.colAttr.needsUpdate = true
  }

  get activeCount(): number {
    return this.liveCount
  }

  /** 测试观测口：颜色缓冲与 drawRange（生产逻辑不读） */
  get debugState(): { colors: Float32Array; drawStart: number; drawCount: number } {
    const range = this.points.geometry.drawRange
    return { colors: this.colors, drawStart: range.start, drawCount: range.count }
  }

  /** 快进：全部粒子立即消亡（颜色清零随帧上传，不留残影） */
  finishAll(): void {
    for (let k = 0; k < this.liveCount; k += 1) {
      const slot = this.liveIdx[k] as number
      const i3 = slot * 3
      this.colors[i3] = 0
      this.colors[i3 + 1] = 0
      this.colors[i3 + 2] = 0
      this.free[this.freeTop] = slot
      this.freeTop += 1
    }
    this.liveCount = 0
    this.colAttr.needsUpdate = true
  }

  dispose(): void {
    this.finishAll()
    this.points.geometry.dispose()
    const mat = this.points.material as THREE.PointsMaterial
    mat.dispose()
    this.points.removeFromParent()
  }
}

// —— 池槽位获取（游标轮转：优先空闲槽，满载时强占最旧槽；容量 ≥1 保证有返回） ——

interface PoolSlot {
  active: boolean
}

function takeSlot<T extends PoolSlot>(slots: T[], cursor: { i: number }): T {
  const n = slots.length
  for (let k = 0; k < n; k += 1) {
    const s = slots[(cursor.i + k) % n]
    if (s && !s.active) {
      cursor.i = (cursor.i + k + 1) % n
      return s
    }
  }
  const fallback = slots[cursor.i % n] as T
  cursor.i = (cursor.i + 1) % n
  return fallback
}

// —— 地面扩散光环 ——

interface RingSlot {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  age: number
  duration: number
  maxRadius: number
  active: boolean
}

/** 环池：格挡涟漪 / 落场冲击 / 护甲涟漪 / 传说流光圈 */
export class RingPool {
  private readonly slots: RingSlot[] = []
  private readonly cursor = { i: 0 }

  constructor(scene: THREE.Scene, capacity = 10) {
    const geo = new THREE.RingGeometry(0.86, 1.0, 48)
    for (let i = 0; i < capacity; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geo, material)
      mesh.rotation.x = -Math.PI / 2
      mesh.visible = false
      mesh.renderOrder = 16
      scene.add(mesh)
      this.slots.push({ mesh, material, age: 0, duration: 0.5, maxRadius: 1.6, active: false })
    }
  }

  /** 在 pos（世界坐标）铺一圈向外扩散的地面光环 */
  spawn(pos: THREE.Vector3, color: string, maxRadius = 1.6, duration = 0.5): void {
    if (!fxEnabled('particles')) return // 光环归入粒子类降级粒度
    const slot = takeSlot(this.slots, this.cursor)
    slot.active = true
    slot.age = 0
    slot.duration = Math.max(0.05, duration)
    slot.maxRadius = maxRadius
    slot.material.color.set(color)
    slot.material.opacity = 0.9
    slot.mesh.position.set(pos.x, Math.max(0.02, pos.y - 0.45), pos.z)
    slot.mesh.scale.setScalar(0.2)
    slot.mesh.visible = true
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue
      s.age += dt
      const p = s.age / s.duration
      if (p >= 1) {
        s.active = false
        s.mesh.visible = false
        continue
      }
      s.mesh.scale.setScalar(0.2 + (s.maxRadius - 0.2) * (1 - (1 - p) ** 2))
      s.material.opacity = 0.9 * (1 - p)
    }
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.active).length
  }

  finishAll(): void {
    for (const s of this.slots) {
      s.active = false
      s.mesh.visible = false
    }
  }

  dispose(): void {
    this.finishAll()
    const geo: THREE.BufferGeometry | null = this.slots[0]?.mesh.geometry ?? null
    for (const s of this.slots) s.material.dispose()
    geo?.dispose()
    for (const s of this.slots) s.mesh.removeFromParent()
  }
}

// —— 竖直光柱 ——

interface PillarSlot {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  age: number
  duration: number
  active: boolean
}

/** 光柱池：传说入场 / 召唤光柱 / 传送（arm）/ 能效护盾（apple 弱柱） */
export class PillarPool {
  private readonly slots: PillarSlot[] = []
  private readonly cursor = { i: 0 }

  constructor(scene: THREE.Scene, capacity = 4) {
    const geo = new THREE.CylinderGeometry(0.42, 0.58, 1, 14, 1, true)
    for (let i = 0; i < capacity; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: '#ffffff',
        map: getBeamGradient(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geo, material)
      mesh.visible = false
      mesh.renderOrder = 17
      scene.add(mesh)
      this.slots.push({ mesh, material, age: 0, duration: 0.9, active: false })
    }
  }

  /** 在 pos 立起一根高约 3.2 的光柱（高度 1 × scaleY 3.2） */
  spawn(pos: THREE.Vector3, color: string, duration = 0.9): void {
    if (!fxEnabled('pillars')) return
    const slot = takeSlot(this.slots, this.cursor)
    slot.active = true
    slot.age = 0
    slot.duration = Math.max(0.05, duration)
    slot.material.color.set(color)
    slot.material.opacity = 0.9
    slot.mesh.position.set(pos.x, pos.y + 1.6, pos.z)
    slot.mesh.scale.set(1, 3.2, 1)
    slot.mesh.visible = true
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue
      s.age += dt
      const p = s.age / s.duration
      if (p >= 1) {
        s.active = false
        s.mesh.visible = false
        continue
      }
      // 前段快速立起（含少许过冲），后段渐熄
      const grow = p < 0.18 ? p / 0.18 : 1
      s.mesh.scale.set(0.7 + 0.3 * grow, 3.2 * (0.12 + 0.88 * grow), 0.7 + 0.3 * grow)
      s.material.opacity = p < 0.5 ? 0.9 : 0.9 * (1 - (p - 0.5) / 0.5)
    }
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.active).length
  }

  finishAll(): void {
    for (const s of this.slots) {
      s.active = false
      s.mesh.visible = false
    }
  }

  dispose(): void {
    this.finishAll()
    for (const s of this.slots) s.material.dispose()
    this.slots[0]?.mesh.geometry.dispose()
    for (const s of this.slots) s.mesh.removeFromParent()
  }
}

// —— 折线电弧 ——

const BOLT_POINTS = 12

interface BoltSlot {
  line: THREE.Line
  material: THREE.LineBasicMaterial
  age: number
  life: number
  active: boolean
  from: THREE.Vector3
  to: THREE.Vector3
}

/** 电弧池：BURN_OUT 跳闸 / 光追失败（折线路径 + 频闪淡出） */
export class BoltPool {
  private readonly slots: BoltSlot[] = []
  private readonly cursor = { i: 0 }

  constructor(scene: THREE.Scene, capacity = 6) {
    for (let i = 0; i < capacity; i += 1) {
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BOLT_POINTS * 3), 3))
      const material = new THREE.LineBasicMaterial({
        color: '#ffd23d',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const line = new THREE.Line(geo, material)
      line.visible = false
      line.renderOrder = 19
      line.frustumCulled = false
      scene.add(line)
      this.slots.push({ line, material, age: 0, life: 0.3, active: false, from: new THREE.Vector3(), to: new THREE.Vector3() })
    }
  }

  /** 在 from→to 间生成一道折线电弧（中点垂向抖动，频闪衰减） */
  spawn(from: THREE.Vector3, to: THREE.Vector3, color: string): void {
    if (!fxEnabled('bolts')) return
    const slot = takeSlot(this.slots, this.cursor)
    slot.active = true
    slot.age = 0
    slot.life = 0.3
    slot.from.copy(from)
    slot.to.copy(to)
    slot.material.color.set(color)
    slot.material.opacity = 1
    this.rejag(slot, 0)
    slot.line.visible = true
  }

  /** 重写折线顶点（写预分配缓冲，零分配；seed 抖动相位） */
  private rejag(slot: BoltSlot, seed: number): void {
    const attr = slot.line.geometry.getAttribute('position') as THREE.BufferAttribute
    const arr = attr.array as Float32Array
    for (let i = 0; i < BOLT_POINTS; i += 1) {
      const t = i / (BOLT_POINTS - 1)
      const jitter = i === 0 || i === BOLT_POINTS - 1 ? 0 : Math.sin(seed * 12.9898 + i * 78.233) * 0.5
      arr[i * 3] = slot.from.x + (slot.to.x - slot.from.x) * t + jitter * 0.14
      arr[i * 3 + 1] = slot.from.y + (slot.to.y - slot.from.y) * t + Math.abs(jitter) * 0.22
      arr[i * 3 + 2] = slot.from.z + (slot.to.z - slot.from.z) * t + jitter * 0.14
    }
    attr.needsUpdate = true
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue
      s.age += dt
      const p = s.age / s.life
      if (p >= 1) {
        s.active = false
        s.line.visible = false
        continue
      }
      // 每 60ms 重抖一次路径 + 频闪
      if (Math.floor(s.age / 0.06) !== Math.floor((s.age - dt) / 0.06)) this.rejag(s, s.age * 60)
      const flicker = 0.55 + 0.45 * Math.sin(s.age * 90)
      s.material.opacity = (1 - p) * flicker
    }
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.active).length
  }

  finishAll(): void {
    for (const s of this.slots) {
      s.active = false
      s.line.visible = false
    }
  }

  dispose(): void {
    this.finishAll()
    for (const s of this.slots) {
      s.line.geometry.dispose()
      s.material.dispose()
      s.line.removeFromParent()
    }
  }
}

// —— 直射光束 ——

const BEAM_UP = new THREE.Vector3(0, 1, 0)

interface BeamSlot {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  age: number
  life: number
  active: boolean
  mid: THREE.Vector3
  dir: THREE.Vector3
}

/** 光束池：amd 开光追（英雄位 → 目标的一道高亮射束） */
export class BeamPool {
  private readonly slots: BeamSlot[] = []
  private readonly cursor = { i: 0 }

  constructor(scene: THREE.Scene, capacity = 4) {
    const geo = new THREE.CylinderGeometry(0.06, 0.09, 1, 8, 1, true)
    for (let i = 0; i < capacity; i += 1) {
      const material = new THREE.MeshBasicMaterial({
        color: '#ff2a2a',
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(geo, material)
      mesh.visible = false
      mesh.renderOrder = 19
      mesh.frustumCulled = false
      scene.add(mesh)
      this.slots.push({ mesh, material, age: 0, life: 0.5, active: false, mid: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0) })
    }
  }

  /** 从 from 到 to 打一道光束（寿命内先增亮后衰减） */
  spawn(from: THREE.Vector3, to: THREE.Vector3, color: string): void {
    if (!fxEnabled('beams')) return
    const slot = takeSlot(this.slots, this.cursor)
    slot.active = true
    slot.age = 0
    slot.life = 0.5
    slot.mid.copy(from).add(to).multiplyScalar(0.5)
    slot.dir.copy(to).sub(from)
    const len = Math.max(0.001, slot.dir.length())
    slot.dir.divideScalar(len)
    slot.material.color.set(color)
    slot.mesh.position.copy(slot.mid)
    slot.mesh.scale.set(1, len, 1)
    slot.mesh.quaternion.setFromUnitVectors(BEAM_UP, slot.dir)
    slot.mesh.visible = true
  }

  update(dt: number): void {
    for (const s of this.slots) {
      if (!s.active) continue
      s.age += dt
      const p = s.age / s.life
      if (p >= 1) {
        s.active = false
        s.mesh.visible = false
        continue
      }
      // 先涨后衰的束流呼吸 + 微抖
      s.material.opacity = 0.95 * (p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8)
      const w = 1 + Math.sin(s.age * 70) * 0.15
      s.mesh.scale.x = w
      s.mesh.scale.z = w
    }
  }

  get activeCount(): number {
    return this.slots.filter((s) => s.active).length
  }

  finishAll(): void {
    for (const s of this.slots) {
      s.active = false
      s.mesh.visible = false
    }
  }

  dispose(): void {
    this.finishAll()
    for (const s of this.slots) s.material.dispose()
    this.slots[0]?.mesh.geometry.dispose()
    for (const s of this.slots) s.mesh.removeFromParent()
  }
}

// —— 驱动更新进度条（intel 专属；单实例复用） ——

let progressLabelTexture: THREE.Texture | null = null
function getProgressLabel(): THREE.Texture | null {
  if (progressLabelTexture) return progressLabelTexture
  const made = makeCanvas(256, 64)
  if (!made) return null
  made.ctx.fillStyle = '#7fe3ff'
  made.ctx.font = '700 34px "Segoe UI", "PingFang SC", sans-serif'
  made.ctx.textAlign = 'center'
  made.ctx.textBaseline = 'middle'
  made.ctx.fillText('驱动更新中…', 128, 34)
  progressLabelTexture = new THREE.CanvasTexture(made.canvas)
  return progressLabelTexture
}

const PROGRESS_STEPS = [0.22, 0.67, 0.99, 1] // 驱动更新的经典分段：22% → 67% → 99% → 完成

/**
 * 驱动更新进度条：intel 技能演出。底板 + 分段跳跃的填充条 + 标签；
 * 单实例复用（重复 spawn 即重启），更新全在预分配对象上进行。
 */
export class ProgressFx {
  readonly group = new THREE.Group()
  private readonly fill: THREE.Mesh
  private readonly fillMat: THREE.MeshBasicMaterial
  private active = false
  private age = 0
  private duration = 0.9
  private readonly fillW = 1.5

  constructor(scene: THREE.Scene) {
    const bgMat = new THREE.MeshBasicMaterial({ color: '#0a1016', transparent: true, opacity: 0.9, depthWrite: false })
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(1.66, 0.34), bgMat)
    bg.position.z = 0.001
    this.fillMat = new THREE.MeshBasicMaterial({ color: '#38b6ff', transparent: true, opacity: 0.95, depthWrite: false })
    this.fill = new THREE.Mesh(new THREE.PlaneGeometry(this.fillW, 0.22), this.fillMat)
    const labelTex = getProgressLabel()
    let label: THREE.Mesh | null = null
    if (labelTex) {
      label = new THREE.Mesh(
        new THREE.PlaneGeometry(0.9, 0.225),
        new THREE.MeshBasicMaterial({ map: labelTex, transparent: true, depthWrite: false }),
      )
      label.position.y = 0.34
    }
    this.group.add(bg, this.fill)
    if (label) this.group.add(label)
    this.group.visible = false
    this.group.renderOrder = 21
    scene.add(this.group)
  }

  /** 在 pos 上方播放一次分段进度（duration 秒后自动隐藏） */
  spawn(pos: THREE.Vector3, duration = 0.9): void {
    if (!fxEnabled('beams')) return // 归入光束类降级粒度（intel 进度条属「重型装饰」）
    this.active = true
    this.age = 0
    this.duration = Math.max(0.05, duration)
    this.group.position.set(pos.x, pos.y + 0.85, pos.z + 0.05)
    this.group.rotation.x = -0.42
    this.setStep(0)
    this.group.visible = true
  }

  private setStep(v: number): void {
    this.fill.scale.x = Math.max(0.001, v)
    this.fill.position.x = -(this.fillW / 2) * (1 - v)
  }

  update(dt: number): void {
    if (!this.active) return
    this.age += dt
    const p = Math.min(1, this.age / this.duration)
    // 分段跳跃：p 均分四段，段内缓入缓出，段间定格（22%→67%→99%→100% 梗）
    const seg = Math.min(PROGRESS_STEPS.length - 1, Math.floor(p * PROGRESS_STEPS.length))
    const segStart = seg === 0 ? 0 : (PROGRESS_STEPS[seg - 1] ?? 0)
    const segEnd = PROGRESS_STEPS[seg] ?? 1
    const local = Math.min(1, p * PROGRESS_STEPS.length - seg)
    const eased = local * local * (3 - 2 * local)
    this.setStep(segStart + (segEnd - segStart) * eased)
    if (p >= 1) {
      this.active = false
      this.group.visible = false
    }
  }

  get activeCount(): number {
    return this.active ? 1 : 0
  }

  finishAll(): void {
    this.active = false
    this.group.visible = false
  }

  dispose(): void {
    this.finishAll()
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose()
        const m = o.material as THREE.MeshBasicMaterial
        m.map?.dispose()
        m.dispose()
      }
    })
    this.group.removeFromParent()
  }
}

// —— 镜头微震 ——

/**
 * trauma² 镜头微震：addTrauma 注入震动量，指数衰减；
 * 偏移只作用于相机旋转（ SceneManager.tick 在 cameraRig.lookAt 之后施加，
 * 每帧被 rig 重置，不累积、不与演出机位打架）。
 */
export class CameraShaker {
  private trauma = 0
  private age = 0
  private readonly maxRoll = 0.05
  private readonly maxPitch = 0.035
  private readonly decayPerSec = 1.7

  /** 注入震动量（0..1，多次叠加封顶 1；0.2=轻撞，0.45=传说降临，0.6=跳闸） */
  addTrauma(amount: number): void {
    if (!fxEnabled('shake')) return
    this.trauma = Math.min(1, this.trauma + amount)
  }

  get traumaLevel(): number {
    return this.trauma
  }

  /** 在相机上施加本帧偏移（rig.update 之后调用） */
  apply(camera: THREE.PerspectiveCamera, dt: number): void {
    this.age += dt
    if (this.trauma <= 0) return
    this.trauma = Math.max(0, this.trauma - this.decayPerSec * dt)
    const shake = this.trauma * this.trauma
    const t = this.age * 34
    camera.rotation.z += Math.sin(t * 1.1) * shake * this.maxRoll
    camera.rotation.x += Math.sin(t * 1.7 + 1.3) * shake * this.maxPitch
  }

  get activeCount(): number {
    return this.trauma > 0 ? 1 : 0
  }

  /** 快进：立即停止震动 */
  finishAll(): void {
    this.trauma = 0
  }

  dispose(): void {
    this.finishAll()
  }
}
