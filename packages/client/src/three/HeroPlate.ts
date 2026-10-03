/**
 * 英雄铭牌（M1-R3D3/R3D4）：双方 CPU 本体的 3D 表现。
 * 名字 / 体质 / 护甲全部程序化 canvas 绘制，数值变化即重绘纹理；
 * 拾取信息 userData.pick = { kind:'hero', playerId }。
 */

import * as THREE from 'three'
import type { PlayerId } from '@siliconcard/core'
import type { PickInfo } from './CardEntity'

const PLATE_W = 2.6
const PLATE_H = 1.15
const TEX_W = 512
const TEX_H = 224

export interface HeroPlateInfo {
  heroName: string
  faction: string
  health: number
  maxHealth: number
  armor: number
  /** 派系主色（CardFace.resolvePalette 的结果，由上层传入保持同源） */
  primary: string
  active: boolean
}

export class HeroPlate {
  readonly group: THREE.Group
  private readonly mesh: THREE.Mesh
  private readonly material: THREE.MeshBasicMaterial
  private readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly texture: THREE.CanvasTexture
  private info: HeroPlateInfo | null = null

  constructor(readonly playerId: PlayerId) {
    this.group = new THREE.Group()
    this.canvas = document.createElement('canvas')
    this.canvas.width = TEX_W
    this.canvas.height = TEX_H
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('HeroPlate: 2D context 不可用')
    this.ctx = ctx
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true })
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_W, PLATE_H), this.material)
    const pick = new THREE.Mesh(
      new THREE.PlaneGeometry(PLATE_W * 1.1, PLATE_H * 1.15),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pick.position.z = 0.01
    const pickInfo: PickInfo = { kind: 'hero', playerId }
    this.mesh.userData.pick = pickInfo
    pick.userData.pick = pickInfo
    this.group.add(this.mesh, pick)
  }

  setInfo(info: HeroPlateInfo): void {
    this.info = info
    this.redraw()
  }

  private redraw(): void {
    const info = this.info
    if (!info) return
    const { ctx } = this
    ctx.clearRect(0, 0, TEX_W, TEX_H)
    // 底板
    ctx.fillStyle = 'rgba(8,12,16,0.92)'
    ctx.strokeStyle = info.primary
    ctx.lineWidth = 8
    const r = 26
    ctx.beginPath()
    ctx.moveTo(r, 4)
    ctx.arcTo(TEX_W - 4, 4, TEX_W - 4, TEX_H - 4, r)
    ctx.arcTo(TEX_W - 4, TEX_H - 4, 4, TEX_H - 4, r)
    ctx.arcTo(4, TEX_H - 4, 4, 4, r)
    ctx.arcTo(4, 4, TEX_W - 4, 4, r)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    // 回合激活光带
    if (info.active) {
      ctx.fillStyle = info.primary
      ctx.globalAlpha = 0.22
      ctx.fillRect(8, 8, TEX_W - 16, TEX_H - 16)
      ctx.globalAlpha = 1
    }
    // 名字 + 派系
    ctx.fillStyle = '#f2f5f7'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.font = '800 52px "Segoe UI", "PingFang SC", sans-serif'
    ctx.fillText(info.heroName, 30, 74)
    ctx.font = '600 26px "Segoe UI", "PingFang SC", sans-serif'
    ctx.fillStyle = info.primary
    ctx.fillText(`${info.faction.toUpperCase()} · CPU`, 30, 136)
    // 体质（右下大数字）+ 护甲
    ctx.textAlign = 'right'
    ctx.font = '900 76px "Segoe UI", "PingFang SC", sans-serif'
    ctx.fillStyle = info.health <= info.maxHealth * 0.3 ? '#ff5d4d' : '#f2f5f7'
    ctx.fillText(`${Math.max(0, info.health)}`, TEX_W - (info.armor > 0 ? 96 : 28), TEX_H - 64)
    ctx.font = '700 30px "Segoe UI", "PingFang SC", sans-serif'
    ctx.fillStyle = '#8b98a5'
    ctx.fillText(`体质 / ${info.maxHealth}`, TEX_W - (info.armor > 0 ? 96 : 28), TEX_H - 18)
    if (info.armor > 0) {
      ctx.textAlign = 'right'
      ctx.font = '900 54px "Segoe UI", "PingFang SC", sans-serif'
      ctx.fillStyle = '#9fb8c8'
      ctx.fillText(`🛡${info.armor}`, TEX_W - 24, TEX_H - 58)
    }
    this.texture.needsUpdate = true
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.group.getWorldPosition(out)
  }

  dispose(): void {
    this.texture.dispose()
    this.material.dispose()
    this.mesh.geometry.dispose()
  }
}
