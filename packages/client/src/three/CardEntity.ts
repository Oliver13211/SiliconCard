/**
 * 卡牌实体与 mesh 池（M1-R3D3）。
 *
 * 卡牌 = Group（正面 PlaneGeometry + CanvasTexture，背面共用程序化卡背）。
 * 实体内部维护三层位姿分量，每帧合成：
 * - base：布局层给的目标位（手牌扇 / 场上槽 / 铭牌）；
 * - hover：hover 抬起（内部平滑趋近，R3D3 交互态）；
 * - fx：动画层（AnimationDirector 的补间）写入的临时偏移/缩放/旋转。
 *
 * 池化（性能预算，design-report §3.4）：CardEntityPool.acquire/release 复用
 * Group 与材质，避免每张牌进出场都新建 mesh 造成 GC 抖动。
 */

import * as THREE from 'three'
import { CARD_H, CARD_W, HAND_HOVER_LIFT } from './layout'

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

export class CardEntity {
  readonly group: THREE.Group
  /** 命中检测用的隐形碰撞面（含 hover 区域比牌面略大，手感更好） */
  readonly pickMesh: THREE.Mesh

  private frontMat: THREE.MeshBasicMaterial
  private backMat: THREE.MeshBasicMaterial
  private frameMat: THREE.MeshBasicMaterial

  private base: Pose = identityPose()
  private hoverTarget = 0
  private hoverK = 0
  selected = false
  /** 动画层临时偏移（世界系），由 AnimationDirector 的补间驱动 */
  readonly fxOffset = new THREE.Vector3()
  fxScale = 1
  fxRotZ = 0
  /** 透明度（烧卡/飞入淡出用） */
  opacity = 1
  /** 归池标记 */
  faceTexture: THREE.Texture | null = null

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

    this.pickMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.15, CARD_H * 1.12),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    this.pickMesh.position.z = 0.02

    this.group.add(frame, front, back, this.pickMesh)
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

  /** 换卡面纹理（纹理缓存命中即复用，不重复绘制） */
  setFaceTexture(tex: THREE.Texture): void {
    this.faceTexture = tex
    this.frontMat.map = tex
    this.frontMat.needsUpdate = true
  }

  setPickInfo(info: PickInfo): void {
    this.pickMesh.userData.pick = info
    this.group.userData.pick = info
  }

  setInteractive(on: boolean): void {
    this.pickMesh.userData.pick = on ? this.pickMesh.userData.pick : undefined
    this.group.userData.pick = on ? this.group.userData.pick : undefined
  }

  /** 每帧合成位姿；dt 用于 hover 平滑 */
  update(dt: number): void {
    const k = 1 - Math.exp(-dt * 12)
    this.hoverK += (this.hoverTarget - this.hoverK) * k
    const lift = HAND_HOVER_LIFT * this.hoverK
    this.group.position.set(
      this.base.x + this.fxOffset.x,
      this.base.y + lift + this.fxOffset.y,
      this.base.z + this.fxOffset.z,
    )
    this.group.rotation.set(this.base.rotX, this.base.rotY, this.base.rotZ + this.fxRotZ)
    const s = this.base.scale * (1 + 0.07 * this.hoverK) * this.fxScale
    this.group.scale.setScalar(s)
    const o = this.opacity
    this.frontMat.opacity = o
    this.backMat.opacity = o
    this.frameMat.opacity = Math.max(
      this.hoverK * 0.55,
      this.selected ? 0.85 : 0,
    )
    this.frameMat.color.copy(this.selected ? SELECT_COLOR : HOVER_COLOR)
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
    this.opacity = 1
    this.faceTexture = null
    this.frontMat.map = null
    this.frontMat.needsUpdate = true
    this.pickMesh.userData.pick = undefined
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
          for (const m of mats) m.dispose()
        }
      })
    }
    this.free = []
  }
}
