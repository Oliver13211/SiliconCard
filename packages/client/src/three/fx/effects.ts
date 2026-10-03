/**
 * 粒子与瞬时特效（M1-R3D4）：烧卡冒烟 / 死亡碎裂 / 跳闸闪屏。
 * 全部程序化纹理（径向渐变烟雾、卡面 UV 切片碎片），零外部图片资产；
 * 自管生命周期 + finishAll() 快进清场（design-report §3.4「动画可快进」）。
 */

import * as THREE from 'three'

// —— 烧卡冒烟 ——

let smokeTexture: THREE.CanvasTexture | null = null

function getSmokeTexture(): THREE.CanvasTexture {
  if (smokeTexture) return smokeTexture
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('getSmokeTexture: 2D context 不可用')
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 62)
  g.addColorStop(0, 'rgba(190,190,200,0.9)')
  g.addColorStop(0.55, 'rgba(120,120,132,0.45)')
  g.addColorStop(1, 'rgba(80,80,90,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  smokeTexture = new THREE.CanvasTexture(canvas)
  return smokeTexture
}

interface Puff {
  sprite: THREE.Sprite
  material: THREE.SpriteMaterial
  age: number
  life: number
  vel: THREE.Vector3
  grow: number
  baseScale: number
}

export class SmokePool {
  private active: Puff[] = []

  constructor(private readonly scene: THREE.Scene) {}

  /** 在 pos 冒一撮烟（烧牌：cardId 燃毁；count 控制烟量） */
  spawn(pos: THREE.Vector3, count = 7): void {
    const tex = getSmokeTexture()
    for (let i = 0; i < count; i += 1) {
      const material = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      })
      const sprite = new THREE.Sprite(material)
      const baseScale = 0.35 + Math.random() * 0.3
      sprite.scale.setScalar(baseScale)
      sprite.position.set(pos.x + (Math.random() - 0.5) * 0.5, pos.y, pos.z + (Math.random() - 0.5) * 0.3)
      sprite.renderOrder = 15
      this.scene.add(sprite)
      this.active.push({
        sprite,
        material,
        age: 0,
        life: 0.9 + Math.random() * 0.6,
        vel: new THREE.Vector3((Math.random() - 0.5) * 0.35, 1.1 + Math.random() * 0.7, (Math.random() - 0.5) * 0.25),
        grow: 0.9 + Math.random() * 0.8,
        baseScale,
      })
    }
  }

  update(dt: number): void {
    for (const p of this.active) {
      p.age += dt
      const t = Math.min(1, p.age / p.life)
      p.sprite.position.addScaledVector(p.vel, dt)
      p.vel.y *= 1 - 0.4 * dt // 上升减速
      const s = p.baseScale * (1 + p.grow * t)
      p.sprite.scale.setScalar(s)
      p.material.opacity = 0.85 * (1 - t)
    }
    this.active = this.active.filter((p) => {
      if (p.age < p.life) return true
      this.scene.remove(p.sprite)
      p.material.dispose()
      return false
    })
  }

  get activeCount(): number {
    return this.active.length
  }

  finishAll(): void {
    for (const p of this.active) {
      this.scene.remove(p.sprite)
      p.material.dispose()
    }
    this.active = []
  }

  dispose(): void {
    this.finishAll()
    smokeTexture?.dispose()
    smokeTexture = null
  }
}

// —— 死亡碎裂 ——

const SHARD_GRID = 3 // 3×3 = 9 片

interface Shard {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  age: number
  life: number
  vel: THREE.Vector3
  spin: THREE.Vector3
}

export class ShardsPool {
  private active: Shard[] = []

  constructor(private readonly scene: THREE.Scene) {}

  /**
   * 把一张卡面碎成 3×3 碎片（MINION_DIED 碎裂演出）。
   * cardTexture 为该实体当前正面纹理（缓存共享，不复制图片数据）；
   * null（如卡背/无面实体）时生成无贴图的暗色碎片。
   */
  burst(pos: THREE.Vector3, cardTexture: THREE.Texture | null, rotationY: number, scale = 1): void {
    const w = 1.0 * scale
    const h = 1.4 * scale
    const pieceW = w / SHARD_GRID
    const pieceH = h / SHARD_GRID
    for (let ix = 0; ix < SHARD_GRID; ix += 1) {
      for (let iy = 0; iy < SHARD_GRID; iy += 1) {
        let tex: THREE.Texture | null = null
        if (cardTexture) {
          tex = cardTexture.clone()
          tex.needsUpdate = true
          tex.repeat.set(1 / SHARD_GRID, 1 / SHARD_GRID)
          tex.offset.set(ix / SHARD_GRID, 1 - (iy + 1) / SHARD_GRID)
        }
        const geo = new THREE.PlaneGeometry(pieceW, pieceH)
        const material = new THREE.MeshBasicMaterial({
          map: tex,
          color: tex ? 0xffffff : 0x1a222b,
          transparent: true,
          side: THREE.DoubleSide,
        })
        const mesh = new THREE.Mesh(geo, material)
        mesh.position.set(
          pos.x - w / 2 + (ix + 0.5) * pieceW,
          pos.y - h / 2 + (iy + 0.5) * pieceH,
          pos.z,
        )
        mesh.rotation.y = rotationY
        this.scene.add(mesh)
        this.active.push({
          mesh,
          material,
          age: 0,
          life: 0.85 + Math.random() * 0.25,
          vel: new THREE.Vector3((ix - 1) * 1.6 + Math.random(), 2.2 + Math.random() * 1.2, (Math.random() - 0.3) * 1.4),
          spin: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 6 - 3, Math.random() * 8 - 4),
        })
      }
    }
  }

  update(dt: number): void {
    for (const s of this.active) {
      s.age += dt
      const t = Math.min(1, s.age / s.life)
      s.vel.y -= 7.5 * dt // 重力
      s.mesh.position.addScaledVector(s.vel, dt)
      s.mesh.rotation.x += s.spin.x * dt
      s.mesh.rotation.y += s.spin.y * dt
      s.mesh.rotation.z += s.spin.z * dt
      s.material.opacity = 1 - t * t
    }
    this.active = this.active.filter((s) => {
      if (s.age < s.life) return true
      this.scene.remove(s.mesh)
      s.mesh.geometry.dispose()
      s.material.map?.dispose()
      s.material.dispose()
      return false
    })
  }

  get activeCount(): number {
    return this.active.length
  }

  finishAll(): void {
    for (const s of this.active) {
      this.scene.remove(s.mesh)
      s.mesh.geometry.dispose()
      s.material.map?.dispose()
      s.material.dispose()
    }
    this.active = []
  }

  dispose(): void {
    this.finishAll()
  }
}

// —— 跳闸闪屏 ——

/**
 * 全屏闪烁层：挂在相机前方的加色平面（BURN_OUT「跳闸」闪屏，
 * 也可用于 GAME_END 收尾染色）。update 里指数衰减。
 */
export class ScreenFlash {
  private mesh: THREE.Mesh
  private material: THREE.MeshBasicMaterial
  private peak = 0

  constructor(camera: THREE.Camera) {
    this.material = new THREE.MeshBasicMaterial({
      color: '#ffd23d',
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthTest: false,
      depthWrite: false,
    })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 3.4), this.material)
    this.mesh.position.set(0, 0, -1.2)
    this.mesh.renderOrder = 40
    camera.add(this.mesh)
  }

  flash(color: string, peakOpacity = 0.8, decayPerSec = 2.4): void {
    this.material.color.set(color)
    this.peak = peakOpacity
    this.material.opacity = peakOpacity
    this.decay = decayPerSec
  }

  private decay = 2.4

  update(dt: number): void {
    if (this.material.opacity <= 0) return
    this.material.opacity = Math.max(0, this.material.opacity - this.decay * dt)
    // 闪两下：衰减到一半时再顶回峰值一次（跳闸的「滋滋」感）
    if (this.peak > 0 && this.material.opacity < this.peak * 0.45 && this.material.opacity > this.peak * 0.3) {
      this.material.opacity = Math.min(this.peak * 0.75, this.material.opacity + 0.5)
      this.peak = 0 // 只回顶一次
    }
  }

  get active(): boolean {
    return this.material.opacity > 0
  }

  /** 快进：立即熄灭 */
  finishAll(): void {
    this.material.opacity = 0
    this.peak = 0
  }

  dispose(): void {
    this.finishAll()
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.mesh.removeFromParent()
  }
}
