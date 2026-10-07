/**
 * Three.js 场景管理器（M1-R3D1；M4-R3D5 增补舞台特效池与派系主题；
 * 演出修正阶段三增补程序化牌桌皮肤 tableSkin/）：
 * 渲染器 / 牌桌 / 相机（含演出机位）/ 灯光 / canvas 挂载与 resize / 渲染循环 /
 * raycasting 拾取 / 粒子·光环·光柱·电弧·光束·进度条·镜头微震特效池 /
 * 双方派系色灯光与环境染色（平滑过渡）/
 * 「暗色机房」氛围：绒布台面纹理、机架墙背景、机房地板、槽位柔光、环境尘埃。
 *
 * 架构铁律：Three 场景独立于 React 树——本类只持有 canvas，不感知 React/state；
 * 上层（TableRenderer）经本类的公开 API 驱动。交付验收见 WF-VISUAL（截图评审）。
 *
 * 性能预算（中端核显 60fps）：渲染循环单 RAF；桌面与卡面用 MeshBasicMaterial
 * 免光照计算；阴影关闭；纹理缓存共享（tableSkin 纹理一次性生成 + 模块级缓存）；
 * 特效全池化（update 零分配）；一切可 dispose 的资源在 dispose() 释放。
 */

import * as THREE from 'three'
import { BOARD_SLOT_DX, BOARD_Z, CAMERA_SHOTS, TABLE_D, TABLE_W, type CameraShot } from './layout'
import type { HoverHit, HoverZone } from './tilt'
import { nextHoverState, resolveHoverHit, sameHoverPick } from './tilt'
import { FloatingTextPool } from './fx/textSprite'
import { ScreenFlash, ShardsPool, SmokePool } from './fx/effects'
import { ScreenImpactFx } from './fx/screenImpact'
import { isSharedOutlineMaterial } from './cardOutline'
import {
  BeamPool,
  BoltPool,
  CameraShaker,
  PillarPool,
  ProgressFx,
  RingPool,
  ParticlePool,
} from './fx/stageFx'
import type { TableThemeColors } from './fx/theme'
import { floorTintFor, wallTintFor, BACKDROP_GEOMETRY } from './tableSkin/params'
import { getBackdropCanvas, getFloorCanvas, getSlotGlowCanvas, getTableTopCanvas } from './tableSkin/textures'
import { AmbientDust } from './tableSkin/dust'
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
  // —— M4-R3D5 舞台特效池（全池化，spawn 时按全局质量档自动降级） ——
  readonly particles: ParticlePool
  readonly rings: RingPool
  readonly pillars: PillarPool
  readonly bolts: BoltPool
  readonly beams: BeamPool
  readonly progressFx: ProgressFx
  readonly shaker: CameraShaker
  /** 全屏演出层（演出修正阶段一：强力时刻的冲击波/色偏/暗角脉冲，单实例池化） */
  readonly impact: ScreenImpactFx

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

  // —— 派系主题（M4-R3D5 需求 5：灯光/环境色响应双方派系，平滑过渡） ——
  private readonly lightNear: THREE.PointLight
  private readonly lightFar: THREE.PointLight
  private readonly slotMatNear = new THREE.MeshBasicMaterial({
    color: '#1d5a44',
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  private readonly slotMatFar = new THREE.MeshBasicMaterial({
    color: '#1d5a44',
    transparent: true,
    opacity: 0.35,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  private readonly bgTarget = new THREE.Color('#04070a')
  private readonly bgCurrent = new THREE.Color('#04070a')
  private readonly nearTarget = new THREE.Color('#1a2430')
  private readonly farTarget = new THREE.Color('#1a2430')
  private readonly slotNearTarget = new THREE.Color('#1d5a44')
  private readonly slotFarTarget = new THREE.Color('#1d5a44')
  // —— tableSkin「暗色机房」氛围层（程序化纹理 × 材质染色，随派系主题平滑过渡） ——
  private readonly wallMat = new THREE.MeshBasicMaterial({ color: wallTintFor(null) })
  private readonly floorMat = new THREE.MeshBasicMaterial({ color: floorTintFor(null) })
  private readonly wallTarget = new THREE.Color(wallTintFor(null))
  private readonly wallCurrent = new THREE.Color(wallTintFor(null))
  private readonly floorTarget = new THREE.Color(floorTintFor(null))
  private readonly floorCurrent = new THREE.Color(floorTintFor(null))
  private readonly dust: AmbientDust

  /** 最近一次拾取的归一化指针坐标（手牌 tilt 视差的驱动源，只读） */
  get pointerNDC(): THREE.Vector2 {
    return this.pointer
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setClearColor('#04070a')

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.Fog('#04070a', 16, 30)
    this.scene.background = new THREE.Color('#04070a')

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
    // 双方派系染色灯（近/远各一盏；颜色随 setFactionTheme 平滑过渡）
    this.lightNear = new THREE.PointLight('#1a2430', 9, 18)
    this.lightNear.position.set(0, 4.2, 6.2)
    this.lightFar = new THREE.PointLight('#1a2430', 9, 18)
    this.lightFar.position.set(0, 4.2, -6.2)
    this.scene.add(this.lightNear, this.lightFar)

    this.buildTable()
    this.buildBackdrop()

    this.dust = new AmbientDust(this.scene)
    this.registerUpdatable(this.dust)

    this.floaters = new FloatingTextPool(this.scene)
    this.smoke = new SmokePool(this.scene)
    this.shards = new ShardsPool(this.scene)
    this.flash = new ScreenFlash(this.camera)
    this.particles = new ParticlePool(this.scene)
    this.rings = new RingPool(this.scene)
    this.pillars = new PillarPool(this.scene)
    this.bolts = new BoltPool(this.scene)
    this.beams = new BeamPool(this.scene)
    this.progressFx = new ProgressFx(this.scene)
    this.shaker = new CameraShaker()
    this.impact = new ScreenImpactFx(this.camera)
    this.registerUpdatable(this.floaters)
    this.registerUpdatable(this.smoke)
    this.registerUpdatable(this.shards)
    this.registerUpdatable(this.flash)
    this.registerUpdatable(this.particles)
    this.registerUpdatable(this.rings)
    this.registerUpdatable(this.pillars)
    this.registerUpdatable(this.bolts)
    this.registerUpdatable(this.beams)
    this.registerUpdatable(this.progressFx)
    this.registerUpdatable(this.impact)

    this.bindEvents()
    this.resize()
  }

  /**
   * 应用双方派系主题色（M4-R3D5）：本帧只设目标色，tick 内向目标平滑过渡。
   * colors 为 null 时回落中性暗色（低配档 / 未接入内容包）。
   * tableSkin 氛围层（机架墙/地板）的材质染色目标一并派生（tableSkin/params 纯函数）。
   */
  setFactionTheme(colors: TableThemeColors | null): void {
    if (!colors) {
      this.bgTarget.set('#04070a')
      this.nearTarget.set('#1a2430')
      this.farTarget.set('#1a2430')
      this.slotNearTarget.set('#1d5a44')
      this.slotFarTarget.set('#1d5a44')
      this.wallTarget.set(wallTintFor(null))
      this.floorTarget.set(floorTintFor(null))
      return
    }
    this.nearTarget.set(colors.nearLight)
    this.farTarget.set(colors.farLight)
    this.bgTarget.set(colors.background)
    this.slotNearTarget.set(colors.slotNear)
    this.slotFarTarget.set(colors.slotFar)
    this.wallTarget.set(wallTintFor(colors))
    this.floorTarget.set(floorTintFor(colors))
  }

  /** tableSkin 画布 → CanvasTexture（一次性生成已在模块内缓存；无头环境 null 回落） */
  private makeSkinTexture(get: () => HTMLCanvasElement | null): THREE.CanvasTexture | null {
    const canvas = get()
    if (!canvas) return null
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.anisotropy = 4
    return tex
  }

  private buildTable(): void {
    const tex = this.makeSkinTexture(getTableTopCanvas)
    const table = new THREE.Mesh(
      new THREE.PlaneGeometry(TABLE_W, TABLE_D),
      new THREE.MeshStandardMaterial({
        map: tex ?? undefined,
        color: tex ? '#ffffff' : '#0d1319',
        roughness: 0.94,
        metalness: 0.04,
      }),
    )
    table.rotation.x = -Math.PI / 2
    table.position.y = -0.06
    this.scene.add(table)

    // 场上槽位标记（双方各 7 槽；两行独立材质供派系主题分别染色；
    // 柔光贴图让槽位从「硬矩形色块」变成软边呼吸灯垫，光色仍由材质 color 派系染色）
    const glowTex = this.makeSkinTexture(getSlotGlowCanvas)
    if (glowTex) {
      this.slotMatNear.map = glowTex
      this.slotMatFar.map = glowTex
      this.slotMatNear.needsUpdate = true
      this.slotMatFar.needsUpdate = true
    }
    const slotGeo = new THREE.PlaneGeometry(1.06, 1.46)
    for (const side of ['P1', 'P2'] as const) {
      for (let i = 0; i < 7; i += 1) {
        const slot = new THREE.Mesh(slotGeo, side === 'P1' ? this.slotMatNear : this.slotMatFar)
        slot.rotation.x = -Math.PI / 2
        slot.position.set((i - 3) * BOARD_SLOT_DX, -0.04, BOARD_Z[side])
        this.scene.add(slot)
      }
    }
  }

  /**
   * 「暗色机房」背景装配（tableSkin）：机架墙 + 机房地板。
   * 材质均 MeshBasicMaterial（免光照，帧内只做 color lerp 零分配）；
   * 开 fog：远端自动被雾吞掉，雾色即派系背景色 → 染色过渡免费获得。
   */
  private buildBackdrop(): void {
    const floorTex = this.makeSkinTexture(getFloorCanvas)
    if (floorTex) this.floorMat.map = floorTex
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(BACKDROP_GEOMETRY.floorW, BACKDROP_GEOMETRY.floorD), this.floorMat)
    floor.rotation.x = -Math.PI / 2
    floor.position.y = BACKDROP_GEOMETRY.floorY
    this.scene.add(floor)

    const wallTex = this.makeSkinTexture(getBackdropCanvas)
    if (wallTex) this.wallMat.map = wallTex
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(BACKDROP_GEOMETRY.wallW, BACKDROP_GEOMETRY.wallH),
      this.wallMat,
    )
    wall.position.set(0, BACKDROP_GEOMETRY.wallY, BACKDROP_GEOMETRY.wallZ)
    this.scene.add(wall)
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
    // 镜头微震在机位 rig 之后施加（只改旋转，每帧被 rig 重置，不累积）
    this.shaker.apply(this.camera, dt)
    // 派系主题平滑过渡：灯光/槽位/背景/氛围层（墙·地板）向目标色指数趋近
    const k = 1 - Math.exp(-dt * 2.5)
    this.lightNear.color.lerp(this.nearTarget, k)
    this.lightFar.color.lerp(this.farTarget, k)
    this.slotMatNear.color.lerp(this.slotNearTarget, k)
    this.slotMatFar.color.lerp(this.slotFarTarget, k)
    this.bgCurrent.lerp(this.bgTarget, k)
    this.wallCurrent.lerp(this.wallTarget, k)
    this.floorCurrent.lerp(this.floorTarget, k)
    ;(this.scene.background as THREE.Color).copy(this.bgCurrent)
    if (this.scene.fog) (this.scene.fog as THREE.Fog).color.copy(this.bgCurrent)
    this.wallMat.color.copy(this.wallCurrent)
    this.floorMat.color.copy(this.floorCurrent)
    this.renderer.render(this.scene, this.camera)
  }

  /** 演出快进：补间、飘字、烟雾、碎片、闪屏、相机全部一步到位 */
  fastForward(): void {
    for (const u of this.updatables) {
      if ('fastForward' in u && typeof u.fastForward === 'function') (u as { fastForward: () => void }).fastForward()
      else if ('finishAll' in u && typeof u.finishAll === 'function') (u as { finishAll: () => void }).finishAll()
    }
    this.shaker.finishAll() // shaker 不在 updatables（tick 内手动 apply），快进需单独清零 trauma
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

  // —— raycasting 拾取（R3D3 验收项；hover 迟滞见 tilt.ts） ——

  private setPointer(ev: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect()
    this.pointer.set(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1,
    )
  }

  /**
   * 命中最近一个带 pick 信息的对象，并标注命中区域（inner=核心拾取面 / outer=迟滞外圈）。
   * 命中筛选规则在 tilt.ts resolveHoverHit（纯函数）：迟滞外圈只服务既有 hover，
   * 非同目标的 guard 命中被跳过——否则满手牌时扇心侧邻卡的外圈会侵入当前卡
   * 拾取面并抢走首命中，卡牌边缘出现 hover 死区（独立审查修复）。
   */
  private pickAt(ev: PointerEvent): { info: ExportedPick | null; zone: HoverZone } {
    this.setPointer(ev)
    this.raycaster.setFromCamera(this.pointer, this.camera)
    const hits = this.raycaster.intersectObjects(this.scene.children, true)
    // 解析为命中序列（事件级分配；raycaster.intersectObjects 本身即逐事件分配，
    // 非帧循环热路径）：每条命中取对象链上首个 pick 信息 + 外圈标记
    const parsed: HoverHit[] = []
    for (const hit of hits) {
      const guard = hit.object.userData.hoverGuard === true
      let obj: THREE.Object3D | null = hit.object
      while (obj) {
        const info = obj.userData.pick as ExportedPick | undefined
        if (info) {
          parsed.push({ info, guard })
          break
        }
        obj = obj.parent
      }
    }
    const resolved = resolveHoverHit(parsed, this.lastHover)
    if (resolved) return { info: resolved.info as ExportedPick, zone: resolved.zone }
    return { info: null, zone: 'none' }
  }

  private onPointerMove = (ev: PointerEvent): void => {
    const { info, zone } = this.pickAt(ev)
    // hover 迟滞（tilt.ts 纯函数）：内圈命中才进入；已 hover 时外圈命中仍维持，
    // 离开外圈才交出 —— tilt 在卡牌边缘引起的投影漂移落在迟滞带内，不再抽动。
    const prev = this.lastHover
    const sameTarget = sameHoverPick(info, prev)
    const hovered = nextHoverState(prev !== null, zone, sameTarget)
    const effective = hovered ? info : null
    if (!sameHoverPick(effective, prev)) {
      this.lastHover = effective
      this.handlers.onPickHover?.(effective)
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    const { info, zone } = this.pickAt(ev)
    if (!info) return
    // 点击与 hover 同一套迟滞语义：外圈命中仅在已 hover 同一目标时算点击
    const innerClick = zone === 'inner'
    const fringeClick = zone === 'outer' && sameHoverPick(info, this.lastHover)
    if (innerClick || fringeClick) this.handlers.onPickClick?.(info)
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
    this.dust.dispose()
    this.floaters.dispose()
    this.smoke.dispose()
    this.shards.dispose()
    this.flash.dispose()
    this.particles.dispose()
    this.rings.dispose()
    this.pillars.dispose()
    this.bolts.dispose()
    this.beams.dispose()
    this.progressFx.dispose()
    this.impact.dispose()
    this.shaker.dispose()
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose()
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of mats) {
          // 描边材质为跨实体共享（cardOutline 注册表，userData.shared 标记），
          // 场景销毁只解挂不销毁，否则后续新建场景的描边会全部失效
          if (isSharedOutlineMaterial(m)) continue
          const map = (m as THREE.MeshBasicMaterial).map
          if (map) map.dispose()
          m.dispose()
        }
      }
    })
    this.renderer.dispose()
  }
}
