/**
 * Three.js 场景管理器（M1-R3D1）：渲染器 / 牌桌 / 相机（含演出机位）/ 灯光 /
 * canvas 挂载与 resize / 渲染循环 / raycasting 拾取。
 *
 * 架构铁律：Three 场景独立于 React 树——本类只持有 canvas，不感知 React/state；
 * 上层（TableRenderer）经本类的公开 API 驱动。交付验收见 WF-VISUAL（截图评审）。
 *
 * 性能预算（中端核显 60fps）：渲染循环单 RAF；桌面与卡面用 MeshBasicMaterial
 * 免光照计算；阴影关闭；纹理缓存共享；一切可 dispose 的资源在 dispose() 释放。
 */

import * as THREE from 'three'
import { BOARD_SLOT_DX, BOARD_Z, CAMERA_SHOTS, TABLE_D, TABLE_W, type CameraShot } from './layout'
import { FloatingTextPool } from './fx/textSprite'
import { ScreenFlash, ShardsPool, SmokePool } from './fx/effects'
import type { PickInfo } from './CardEntity'

export type ExportedPick = PickInfo

/** 可注册进渲染循环的可更新物（实体 / 特效池 / 补间时间线宿主） */
export interface Updatable {
  update(dt: number): void
}

export interface PickHandlers {
  /** hover 变化（null 表示移出一切可拾取物） */
  onPickHover?(info: ExportedPick | null): void
  /** 左键点击命中 */
  onPickClick?(info: ExportedPick): void
}

/** 桌面电路板纹理（程序化，零外部图片资产） */
function drawTableTexture(): HTMLCanvasElement {
  const w = 1024
  const h = 640
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('drawTableTexture: 2D context 不可用')
  const bg = ctx.createLinearGradient(0, 0, 0, h)
  bg.addColorStop(0, '#0b1a12')
  bg.addColorStop(1, '#06110b')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  // 走线
  ctx.strokeStyle = 'rgba(46,110,80,0.5)'
  ctx.lineWidth = 2
  let seed = 0x9e3779b9
  const rnd = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 1 | seed) + 0x6d2b79f5) | 0
    return ((seed >>> 0) % 1000) / 1000
  }
  for (let i = 0; i < 90; i += 1) {
    const x = rnd() * w
    const y = rnd() * h
    const len = 60 + rnd() * 180
    const vertical = rnd() > 0.5
    ctx.beginPath()
    ctx.moveTo(x, y)
    if (vertical) ctx.lineTo(x, y + len)
    else ctx.lineTo(x + len, y)
    ctx.stroke()
    // 焊盘
    ctx.beginPath()
    ctx.arc(vertical ? x : x + len, vertical ? y + len : y, 4, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(120,190,150,0.35)'
    ctx.fill()
  }
  // 中线（战场地界）
  ctx.strokeStyle = 'rgba(53,208,255,0.22)'
  ctx.lineWidth = 6
  ctx.setLineDash([26, 18])
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()
  ctx.setLineDash([])
  return canvas
}

/** 相机机位装置：命名机位 + 阻尼趋近（演出机位切换 = 一行 moveTo） */
export class CameraRig {
  private targetPos: THREE.Vector3
  private targetLook: THREE.Vector3
  private currentLook: THREE.Vector3

  constructor(private readonly camera: THREE.PerspectiveCamera) {
    const home = CAMERA_SHOTS.table
    this.targetPos = home.pos.clone()
    this.targetLook = home.look.clone()
    this.currentLook = home.look.clone()
    camera.position.copy(home.pos)
    camera.lookAt(home.look)
  }

  get shot(): CameraShot {
    for (const key of Object.keys(CAMERA_SHOTS) as CameraShot[]) {
      if (CAMERA_SHOTS[key].pos.equals(this.targetPos)) return key
    }
    return 'table'
  }

  moveTo(shot: CameraShot): void {
    this.targetPos.copy(CAMERA_SHOTS[shot].pos)
    this.targetLook.copy(CAMERA_SHOTS[shot].look)
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 3.2)
    this.camera.position.lerp(this.targetPos, k)
    this.currentLook.lerp(this.targetLook, k)
    this.camera.lookAt(this.currentLook)
  }

  /** 快进：直接贴到目标机位 */
  snap(): void {
    this.camera.position.copy(this.targetPos)
    this.currentLook.copy(this.targetLook)
    this.camera.lookAt(this.currentLook)
  }
}

export class SceneManager {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly cameraRig: CameraRig
  readonly floaters: FloatingTextPool
  readonly smoke: SmokePool
  readonly shards: ShardsPool
  readonly flash: ScreenFlash

  private canvas: HTMLCanvasElement
  private clock = new THREE.Clock()
  private rafHandle: number | null = null
  private resizeObserver: ResizeObserver | null = null
  private updatables: Updatable[] = []
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private lastHover: ExportedPick | null = null
  private handlers: PickHandlers = {}
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor('#04070a')

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog('#04070a', 16, 30)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100)
    this.scene.add(this.camera)
    this.cameraRig = new CameraRig(this.camera)

    // 灯光（桌面用 Standard 材质吃光；卡面 Basic 不受影响）
    this.scene.add(new THREE.HemisphereLight('#cfe6ff', '#0a0f14', 1.1))
    const dir = new THREE.DirectionalLight('#ffffff', 1.4)
    dir.position.set(6, 12, 7)
    this.scene.add(dir)
    const rim = new THREE.PointLight('#35d0ff', 14, 22)
    rim.position.set(0, 4.5, -6)
    this.scene.add(rim)

    this.buildTable()

    this.floaters = new FloatingTextPool(this.scene)
    this.smoke = new SmokePool(this.scene)
    this.shards = new ShardsPool(this.scene)
    this.flash = new ScreenFlash(this.camera)
    this.registerUpdatable(this.floaters)
    this.registerUpdatable(this.smoke)
    this.registerUpdatable(this.shards)
    this.registerUpdatable(this.flash)

    this.bindEvents()
    this.resize()
  }

  private buildTable(): void {
    const tex = new THREE.CanvasTexture(drawTableTexture())
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_W, TABLE_D),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0.05 }),
    )
    table.rotation.x = -Math.PI / 2
    table.position.y = -0.06
    this.scene.add(table)

    // 场上槽位标记（双方各 7 槽，静置提示落点）
    const slotGeo = new THREE.PlaneGeometry(1.06, 1.46)
    const slotMat = new THREE.MeshBasicMaterial({
      color: '#1d5a44',
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    for (const side of ['P1', 'P2'] as const) {
      for (let i = 0; i < 7; i += 1) {
        const slot = new THREE.Mesh(slotGeo, slotMat)
        slot.rotation.x = -Math.PI / 2
        slot.position.set((i - 3) * BOARD_SLOT_DX, -0.04, BOARD_Z[side])
        this.scene.add(slot)
      }
    }
  }

  // —— 挂载与循环 ——

  registerUpdatable(u: Updatable): void {
    this.updatables.push(u)
  }

  unregisterUpdatable(u: Updatable): void {
    this.updatables = this.updatables.filter((x) => x !== u)
  }

  start(): void {
    if (this.rafHandle !== null || this.disposed) return
    const loop = () => {
      this.rafHandle = requestAnimationFrame(loop)
      const dt = Math.min(this.clock.getDelta(), 0.1)
      this.tick(dt)
    }
    this.rafHandle = requestAnimationFrame(loop)
  }

  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
  }

  /** 单帧推进（RAF 与测试都可调） */
  tick(dt: number): void {
    for (const u of this.updatables) u.update(dt)
    this.cameraRig.update(dt)
    this.renderer.render(this.scene, this.camera)
  }

  /** 演出快进：补间、飘字、烟雾、碎片、闪屏、相机全部一步到位 */
  fastForward(): void {
    for (const u of this.updatables) {
      if ('fastForward' in u && typeof u.fastForward === 'function') (u as { fastForward: () => void }).fastForward()
      else if ('finishAll' in u && typeof u.finishAll === 'function') (u as { finishAll: () => void }).finishAll()
    }
    this.cameraRig.snap()
  }

  // —— resize ——

  private bindEvents(): void {
    this.canvas.addEventListener('pointermove', this.onPointerMove)
    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('pointerleave', this.onPointerLeave)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    if (this.canvas.parentElement) this.resizeObserver.observe(this.canvas.parentElement)
    window.addEventListener('resize', this.resize)
  }

  resize = (): void => {
    const w = this.canvas.clientWidth || this.canvas.width
    const h = this.canvas.clientHeight || this.canvas.height
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // —— raycasting 拾取（R3D3 验收项） ——

  private setPointer(ev: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
  }

  /** 命中最近一个带 pick 信息的对象 */
  private pickAt(ev: PointerEvent): ExportedPick | null {
    this.setPointer(ev)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.scene.children, true)
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object
      while (obj) {
        const info = obj.userData.pick as ExportedPick | undefined
        if (info) return info
        obj = obj.parent
      }
    }
    return null
  }

  private onPointerMove = (ev: PointerEvent): void => {
    const info = this.pickAt(ev)
    const changed = (info?.kind ?? null) !== (this.lastHover?.kind ?? null)
      || (info?.kind === 'handCard' && this.lastHover?.kind === 'handCard' && info.uid !== this.lastHover.uid)
      || (info?.kind === 'unit' && this.lastHover?.kind === 'unit' && info.instanceId !== this.lastHover.instanceId)
    if (changed) {
      this.lastHover = info
      this.handlers.onPickHover?.(info)
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    const info = this.pickAt(ev)
    if (info) this.handlers.onPickClick?.(info)
  }

  private onPointerLeave = (): void => {
    if (this.lastHover) {
      this.lastHover = null
      this.handlers.onPickHover?.(null)
    }
  }

  setPickHandlers(h: PickHandlers): void {
    this.handlers = h
  }

  // —— 清理（无内存泄漏验收） ——

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.canvas.removeEventListener('pointermove', this.onPointerMove)
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('pointerleave', this.onPointerLeave)
    window.removeEventListener('resize', this.resize)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.updatables = []
    this.floaters.dispose()
    this.smoke.dispose()
    this.shards.dispose()
    this.flash.dispose()
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of mats) {
          const map = (m as THREE.MeshBasicMaterial).map
          if (map) map.dispose()
          m.dispose()
        }
      }
    })
    this.renderer.dispose()
  }
}
