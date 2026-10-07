/**
 * 卡牌实体与 mesh 池（M1-R3D3）。
 *
 * 卡牌 = Group（正面 PlaneGeometry + CanvasTexture，背面共用程序化卡背）。
 * 实体内部维护三层位姿分量，每帧合成：
 * - base：布局层给的目标位（手牌扇 / 场上槽 / 铭牌）；
 * - hover：hover 抬起（内部平滑趋近，R3D3 交互态）+ M4-R3D5 指针跟随 3D tilt；
 * - fx：动画层（AnimationDirector 的补间）写入的临时偏移/缩放/旋转。
 *
 * M4-R3D5 增补：
 * - tilt：手牌悬停时跟随指针的 yaw/pitch 倾斜与视差平移（setTilt 由渲染线每帧喂）；
 * - fxRotX/fxRotY：动画层旋转通道（入场翻面 / 出牌空翻）；
 * - flash(color)：受击/传说描边流光——frame 平面短促染色闪烁，update 内衰减。
 *
 * 演出修正阶段二增补：
 * - outline：inverted hull 立体描边（cardOutline.ts）——背面扩张盒体，描边色
 *   按派系（传说金边），hover/选中切换共享亮态材质；几何每实体一份随池复用，
 *   材质全局共享注册表（≤16 实例），杜绝每张卡独立材质。
 *   描边盒（1.05×1.04）小于拾取面与迟滞外圈，不影响任何射线命中语义。
 *
 * 池化（性能预算，design-report §3.4）：CardEntityPool.acquire/release 复用
 * Group 与材质，避免每张牌进出场都新建 mesh 造成 GC 抖动。
 */

import * as THREE from 'three'
import { CARD_H, CARD_W, HAND_HOVER_LIFT } from './layout'
import { OUTLINE_NEUTRAL, isSharedOutlineMaterial, outlineMaterial } from './cardOutline'

/** 拾取信息（raycasting 命中后由 SceneManager 回传给交互层） */
export type PickInfo =
  | { kind: 'handCard'; uid: string; playerId: 'P1' | 'P2' }
  | { kind: 'unit'; instanceId: string; ownerId: 'P1' | 'P2' }
  | { kind: 'hero'; playerId: 'P1' | 'P2' }
  | { kind: 'pile'; pile: 'deck' | 'graveyard'; playerId: 'P1' | 'P2' }

export interface Pose {
  x: number
  y: number
  z: number
  rotX: number
  rotY: number
  rotZ: number
  scale: number
}

export function identityPose(): Pose {
  return { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, scale: 1 }
}

/** 每个实体独有的发光描边材质色 */
const HOVER_COLOR = new THREE.Color('#35d0ff')
const SELECT_COLOR = new THREE.Color('#ffc53d')

/** tilt 最大 yaw / pitch（rad）与视差平移幅度（M4-R3D5 手牌 3D 倾斜） */
const TILT_YAW = 0.42
const TILT_PITCH = 0.2
const TILT_SHIFT = 0.1
/** 描边流光衰减速率（/秒） */
const FLASH_DECAY = 2.8

export class CardEntity {
  readonly group: THREE.Group
  /** 命中检测用的隐形碰撞面（含 hover 区域比牌面略大，手感更好） */
  readonly pickMesh: THREE.Mesh
  /**
   * hover 迟滞外圈（演出修正阶段一）：比 pickMesh 更大的隐形面，自身带
   * hoverGuard 标记与同一 pick 信息。SceneManager 的迟滞状态机（tilt.ts
   * nextHoverState）据此区分内外圈命中——已 hover 时指针漂到外圈仍维持，
   * tilt 引起的边缘投影漂移不再造成 hover 反复进出。
   */
  readonly hoverGuard: THREE.Mesh
  /**
   * inverted hull 立体描边（演出修正阶段二）：略大于牌面的背面扩张盒体。
   * 材质来自全局共享注册表（outlineMaterial），随 hover/选中在常态/亮态间
   * 整体切换；几何每实体一份，随池复用。
   */
  readonly outlineMesh: THREE.Mesh

  private frontMat: THREE.MeshBasicMaterial
  private backMat: THREE.MeshBasicMaterial
  private frameMat: THREE.MeshBasicMaterial
  /** 描边色（hex，由渲染线按卡牌派系/稀有度设置；共享材质注册表的键源） */
  private outlineHex: string = OUTLINE_NEUTRAL
  /** 已套用的 (hex, bright) 材质状态；update 仅在翻转时查询共享注册表（渲染循环零分配） */
  private outlineState: { hex: string; bright: boolean } | null = null

  private base: Pose = identityPose()
  private hoverTarget = 0
  private hoverK = 0
  selected = false
  /** 动画层临时偏移（世界系），由 AnimationDirector 的补间驱动 */
  readonly fxOffset = new THREE.Vector3()
  fxScale = 1
  fxRotZ = 0
  /** 动画层旋转通道 X/Y（入场翻面 / 出牌空翻；rad） */
  fxRotX = 0
  fxRotY = 0
  /** 透明度（烧卡/飞入淡出用） */
  opacity = 1
  /** 归池标记 */
  faceTexture: THREE.Texture | null = null

  // —— 指针跟随 tilt（M4-R3D5 手牌 3D 倾斜） ——
  /** tilt 目标值（-1..1 归一化指针坐标，渲染线每帧喂） */
  private tiltTX = 0
  private tiltTY = 0
  /** tilt 平滑值（帧内趋近目标） */
  private tiltSX = 0
  private tiltSY = 0

  // —— 受击 / 流光描边 ——
  private readonly flashColor = new THREE.Color('#ff5d4d')
  private flashK = 0

  constructor(cardBackTexture: THREE.Texture) {
    this.group = new THREE.Group()

    const geo = new THREE.PlaneGeometry(CARD_W, CARD_H)
    this.frontMat = new THREE.MeshBasicMaterial({ transparent: true, side: THREE.FrontSide })
    this.backMat = new THREE.MeshBasicMaterial({
      map: cardBackTexture,
      transparent: true,
      side: THREE.FrontSide,
    })
    const front = new THREE.Mesh(geo, this.frontMat)
    front.position.z = 0.012
    const back = new THREE.Mesh(geo, this.backMat)
    back.rotation.y = Math.PI
    back.position.z = -0.012

    // 选中/悬停描边框：略大于牌面的加色平面
    const frameGeo = new THREE.PlaneGeometry(CARD_W * 1.12, CARD_H * 1.09)
    this.frameMat = new THREE.MeshBasicMaterial({
      color: HOVER_COLOR,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const frame = new THREE.Mesh(frameGeo, this.frameMat)
    frame.position.z = 0.006

    // 立体描边（inverted hull 背面扩张）：BackSide 盒体略大于牌面，牌面遮挡
    // 中心后四周露出色环；renderOrder 置后（牌面先写深度，中心被深度剔除，
    // 只剩轮廓），淡出时随 opacity 关闭避免悬浮描边。
    const outlineGeo = new THREE.BoxGeometry(CARD_W * 1.05, CARD_H * 1.04, 0.055)
    this.outlineMesh = new THREE.Mesh(outlineGeo, outlineMaterial(this.outlineHex, false))
    this.outlineMesh.renderOrder = 2

    this.pickMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.15, CARD_H * 1.12),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    this.pickMesh.position.z = 0.02

    // 迟滞外圈：进出迟滞带需越过 1.38×1.32（外圈行程 > 满 tilt 的边缘投影漂移上限）
    this.hoverGuard = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.38, CARD_H * 1.32),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    this.hoverGuard.position.z = 0.01
    this.hoverGuard.userData.hoverGuard = true

    this.group.add(this.outlineMesh, frame, front, back, this.pickMesh, this.hoverGuard)
  }

  get uuidOf(): string {
    return this.group.uuid
  }

  /** 布局层目标位（世界坐标） */
  setBase(pose: Partial<Pose>): void {
    this.base = { ...this.base, ...pose }
  }

  getBase(): Readonly<Pose> {
    return this.base
  }

  setHovered(on: boolean): void {
    this.hoverTarget = on ? 1 : 0
  }

  /**
   * 指针跟随 tilt 目标（M4-R3D5）：nx/ny 为画布归一化指针坐标（-1..1）。
   * 渲染线每帧对 hover 中的手牌喂当前指针、对其余手牌喂 (0,0)；
   * 平滑趋近在 update 内完成，仅 hover 抬起（hoverK>0）时生效。
   */
  setTilt(nx: number, ny: number): void {
    this.tiltTX = nx
    this.tiltTY = ny
  }

  /** 描边流光：短促染色闪烁（受击红 / 传说金 / 质保金），update 内按 FLASH_DECAY 衰减 */
  flash(color: string): void {
    this.flashColor.set(color)
    this.flashK = 1
  }

  /** 是否有描边流光在播（测试观察口） */
  get flashing(): boolean {
    return this.flashK > 0
  }

  /** 换卡面纹理（纹理缓存命中即复用，不重复绘制） */
  setFaceTexture(tex: THREE.Texture): void {
    this.faceTexture = tex
    this.frontMat.map = tex
    this.frontMat.needsUpdate = true
  }

  /** 设置描边色（演出修正阶段二）：渲染线按卡牌派系/稀有度派生后喂入 */
  setOutline(hex: string): void {
    this.outlineHex = hex
  }

  setPickInfo(info: PickInfo): void {
    this.pickMesh.userData.pick = info
    this.hoverGuard.userData.pick = info
    this.group.userData.pick = info
  }

  setInteractive(on: boolean): void {
    this.pickMesh.userData.pick = on ? this.pickMesh.userData.pick : undefined
    this.hoverGuard.userData.pick = on ? this.hoverGuard.userData.pick : undefined
    this.group.userData.pick = on ? this.group.userData.pick : undefined
  }

  /** 每帧合成位姿；dt 用于 hover 平滑与 tilt/流光衰减 */
  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 12)
    this.hoverK += (this.hoverTarget - this.hoverK) * k
    // tilt 平滑趋近（hover 抬起时才允许展开；松开随 hoverK 自然收回）。
    // 阻尼 10 → 6.5（时间常数 ~154ms）：叠加迟滞与目标角钳制，边缘残留的
    // 微小目标波动被进一步滤平（演出修正阶段一）。
    const tk = 1 - Math.exp(-dt * 6.5)
    this.tiltSX += (this.tiltTX * this.hoverK - this.tiltSX) * tk
    this.tiltSY += (this.tiltTY * this.hoverK - this.tiltSY) * tk
    if (this.flashK > 0) this.flashK = Math.max(0, this.flashK - dt * FLASH_DECAY)
    const lift = HAND_HOVER_LIFT * this.hoverK
    this.group.position.set(
      this.base.x + this.fxOffset.x + this.tiltSX * TILT_SHIFT,
      this.base.y + lift + this.fxOffset.y + this.tiltSY * TILT_SHIFT * 0.4,
      this.base.z + this.fxOffset.z,
    )
    this.group.rotation.set(
      this.base.rotX + this.fxRotX - this.tiltSY * TILT_PITCH,
      this.base.rotY + this.fxRotY + this.tiltSX * TILT_YAW,
      this.base.rotZ + this.fxRotZ,
    )
    const s = this.base.scale * (1 + 0.07 * this.hoverK) * this.fxScale
    this.group.scale.setScalar(s)
    const o = this.opacity
    this.frontMat.opacity = o
    this.backMat.opacity = o
    // 立体描边：常态派系色 → hover/选中切共享亮态（同色系提亮）；淡出时关闭，
    // 避免烧卡/飞入演出中留下悬浮轮廓。共享材质整体切换，零 per-card 克隆。
    this.outlineMesh.visible = o > 0.55
    const bright = this.selected || this.hoverK > 0.45
    if (
      this.outlineState === null ||
      this.outlineState.hex !== this.outlineHex ||
      this.outlineState.bright !== bright
    ) {
      const wantMat = outlineMaterial(this.outlineHex, bright)
      if (this.outlineMesh.material !== wantMat) this.outlineMesh.material = wantMat
      this.outlineState = { hex: this.outlineHex, bright }
    }
    // 描边：hover 常态 → 流光染色短暂接管（M4-R3D5 受击闪色 / 传说流光）
    const baseOp = Math.max(this.hoverK * 0.55, this.selected ? 0.85 : 0)
    this.frameMat.opacity = Math.max(baseOp, this.flashK * 0.95)
    if (this.flashK > 0) this.frameMat.color.copy(this.flashColor)
    else this.frameMat.color.copy(this.selected ? SELECT_COLOR : HOVER_COLOR)
  }

  /** 归池前清位（池复用时也调用） */
  reset(): void {
    this.base = identityPose()
    this.hoverTarget = 0
    this.hoverK = 0
    this.selected = false
    this.fxOffset.set(0, 0, 0)
    this.fxScale = 1
    this.fxRotZ = 0
    this.fxRotX = 0
    this.fxRotY = 0
    this.tiltTX = 0
    this.tiltTY = 0
    this.tiltSX = 0
    this.tiltSY = 0
    this.flashK = 0
    this.opacity = 1
    this.faceTexture = null
    this.frontMat.map = null
    this.frontMat.needsUpdate = true
    // 描边归位中性常态（材质为共享实例，此处只换引用不销毁）
    this.outlineHex = OUTLINE_NEUTRAL
    this.outlineMesh.material = outlineMaterial(this.outlineHex, false)
    this.outlineState = { hex: this.outlineHex, bright: false }
    this.outlineMesh.visible = true
    this.pickMesh.userData.pick = undefined
    this.hoverGuard.userData.pick = undefined
    this.group.userData.pick = undefined
    this.group.visible = false
  }

  show(): void {
    this.group.visible = true
  }

  hide(): void {
    this.group.visible = false
  }

  getWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    return this.group.getWorldPosition(out)
  }
}

/**
 * mesh 池：acquire 复用空闲实体（reset 清态），release 归还并脱离场景挂载由
 * 调用方控制（本池只管生命周期，不改 parent，避免与场景管理器打架）。
 */
export class CardEntityPool {
  private free: CardEntity[] = []
  private readonly live = new Set<CardEntity>()

  constructor(
    private readonly scene: THREE.Scene,
    private readonly makeCardBack: () => THREE.Texture,
  ) {}

  acquire(): CardEntity {
    const e = this.free.pop() ?? new CardEntity(this.makeCardBack())
    e.reset()
    e.show()
    if (!e.group.parent) this.scene.add(e.group)
    this.live.add(e)
    return e
  }

  release(e: CardEntity): void {
    if (!this.live.delete(e)) return
    e.reset()
    this.free.push(e)
  }

  get liveCount(): number {
    return this.live.size
  }

  /** 释放全部在用实体（syncView 硬重置时用） */
  releaseAll(): void {
    for (const e of [...this.live]) this.release(e)
  }

  dispose(): void {
    this.releaseAll()
    for (const e of this.free) {
      e.group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose()
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          for (const m of mats) {
            // 描边材质为跨实体共享（cardOutline 注册表），只换引用不销毁
            if (isSharedOutlineMaterial(m)) continue
            m.dispose()
          }
        }
      })
    }
    this.free = []
  }
}
