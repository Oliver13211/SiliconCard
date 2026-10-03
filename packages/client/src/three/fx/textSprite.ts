/**
 * 飘字（M1-R3D4：伤害飘字 / 绿色治疗飘字 / 跳闸提示）。
 *
 * 池化 sprite + 程序化 canvas 文本纹理；自管生命周期（update 推进、寿命尽自动回收），
 * finishAll() 供「动画可快进」一步清场。文字全部程序化绘制，无外部图片资产。
 */

import * as THREE from 'three'

export interface FloatTextSpec {
  text: string
  color: string
  /** 字号像素（canvas 内） */
  size?: number
  /** 寿命秒（默认 1.1） */
  life?: number
  /** 上升距离（世界单位，默认 1.2） */
  rise?: number
  /** 粗体描边（伤害数字） */
  stroke?: boolean
}

interface ActiveFloater {
  sprite: THREE.Sprite
  age: number
  life: number
  rise: number
  basePos: THREE.Vector3
  material: THREE.SpriteMaterial
}

const TEXTURE_CACHE = new Map<string, THREE.CanvasTexture>()

function textTexture(spec: Required<Pick<FloatTextSpec, 'text' | 'color' | 'size' | 'stroke'>>): THREE.CanvasTexture {
  const key = `${spec.text}|${spec.color}|${spec.size}|${spec.stroke}`
  const hit = TEXTURE_CACHE.get(key)
  if (hit) return hit
  const pad = 24
  const canvas = document.createElement('canvas')
  const measure = document.createElement('canvas').getContext('2d')
  const font = `${spec.stroke ? '900' : '700'} ${spec.size}px "Segoe UI", "PingFang SC", sans-serif`
  const width = Math.min(1024, Math.ceil((measure?.measureText(spec.text).width ?? spec.text.length * spec.size) + pad * 2))
  canvas.width = Math.max(64, width)
  canvas.height = spec.size + pad * 2
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('textTexture: 2D context 不可用')
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (spec.stroke) {
    ctx.lineWidth = spec.size * 0.16
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'
    ctx.strokeText(spec.text, canvas.width / 2, canvas.height / 2)
  }
  ctx.fillStyle = spec.color
  ctx.fillText(spec.text, canvas.width / 2, canvas.height / 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  TEXTURE_CACHE.set(key, tex)
  return tex
}

export class FloatingTextPool {
  private active: ActiveFloater[] = []

  constructor(private readonly scene: THREE.Scene) {}

  /** 在世界坐标 pos 生成一条上飘渐隐文本 */
  spawn(pos: THREE.Vector3, spec: FloatTextSpec): void {
    const size = spec.size ?? 64
    const life = spec.life ?? 1.1
    const tex = textTexture({ text: spec.text, color: spec.color, size, stroke: spec.stroke ?? true })
    const material = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    })
    const sprite = new THREE.Sprite(material)
    const aspect = tex.image.width / tex.image.height
    const h = 0.5
    sprite.scale.set(h * aspect, h, 1)
    const basePos = pos.clone()
    sprite.position.copy(basePos)
    sprite.renderOrder = 20
    this.scene.add(sprite)
    this.active.push({ sprite, age: 0, life, rise: spec.rise ?? 1.2, basePos, material })
  }

  update(dt: number): void {
    for (const f of this.active) {
      f.age += dt
      const p = Math.min(1, f.age / f.life)
      f.sprite.position.set(f.basePos.x, f.basePos.y + f.rise * p, f.basePos.z)
      // 前段弹入，后 45% 渐隐
      const pop = p < 0.15 ? 0.6 + (p / 0.15) * 0.4 : 1
      const aspect = f.sprite.material.map ? f.sprite.material.map.image.width / f.sprite.material.map.image.height : 2
      const h = 0.5 * pop
      f.sprite.scale.set(h * aspect, h, 1)
      f.material.opacity = p > 0.55 ? 1 - (p - 0.55) / 0.45 : 1
    }
    this.active = this.active.filter((f) => {
      if (f.age < f.life) return true
      this.scene.remove(f.sprite)
      f.material.dispose()
      return false
    })
  }

  get activeCount(): number {
    return this.active.length
  }

  /** 快进：立即结束全部飘字 */
  finishAll(): void {
    for (const f of this.active) {
      this.scene.remove(f.sprite)
      f.material.dispose()
    }
    this.active = []
  }

  dispose(): void {
    this.finishAll()
    for (const tex of TEXTURE_CACHE.values()) tex.dispose()
    TEXTURE_CACHE.clear()
  }
}
