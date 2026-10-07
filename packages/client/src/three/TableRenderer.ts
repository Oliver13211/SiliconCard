/**
 * TableRenderer —— 渲染线对外的场景挂载 API（M1-R3D1..4 收口）。
 *
 * ★★★ 集成接线说明（供 App.tsx / UI 线使用；Three 场景不进 React 树，架构铁律） ★★★
 *
 * ```tsx
 * import { createTableRenderer } from './three'
 *
 * function BattleScreen({ store }: { store: GameStore }) {
 *   const canvasRef = useRef<HTMLCanvasElement>(null)
 *   useEffect(() => {
 *     const handle = createTableRenderer(canvasRef.current!, {
 *       viewer: 'P1',
 *       // 内容包卡面数据接入点：cardId → CardDefinition（未命中画通用占位面）
 *       getCardDef: (id) => cardRegistry.get(id),
 *     })
 *     // 开局：先整帧同步（摆放英雄/手牌/牌库），再发 GAME_START 演出
 *     handle.syncView(viewFor(store.state, 'P1'))
 *     handle.enqueueEvents([{ type: 'GAME_START', seed, firstPlayer: 'P1' }])
 *
 *     // 每次引擎 applyAction 返回后：
 *     //   handle.syncView(viewFor(newState, 'P1'))
 *     //   handle.enqueueEvents(events)          // 事件驱动动画（R3D4 契约）
 *     //   handle.fastForward()                  // 可选：跳过演出（快进）
 *
 *     // 拾取回调（raycasting，M1-UI2 出牌/目标选择流经此接入）：
 *     handle.setPickCallbacks({
 *       onHandCardClick: (uid) => store.tryPlay(uid),
 *       onHandCardHover: () => {},               // hover 抬起已内置，可用于提示条
 *       onUnitClick: (instanceId) => store.tryTarget(instanceId),
 *       onHeroClick: (playerId) => store.tryTargetHero(playerId),
 *     })
 *
 *     return () => handle.dispose()              // 卸载必调（无泄漏验收）
 *   }, [])
 *   return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
 * }
 * ```
 *
 * 帧循环、resize、纹理缓存、mesh 池、事件演出全部在 handle 内部闭环；
 * React 侧只持有 canvas ref 与事件回调（经 UI store 通信，预设硬约束）。
 */

import * as THREE from 'three'
import type { BoardUnit, CardDefinition, GameEvent, PlayerId, PlayerView } from '@siliconcard/core'
import { CARD_W, BOARD_SLOT_DX, BOARD_Z, HAND_Z, HERO_X, HERO_Z, PILE, sideOf } from './layout'
import { handTransforms, handSlotTransform } from './handLayout'
import { SceneManager, type Updatable } from './SceneManager'
import { CardEntityPool, CardEntity, type PickInfo } from './CardEntity'
import { HeroPlate } from './HeroPlate'
import { composeCardFaceArt, drawCardBack, drawCardFace, resolvePalette, TextureCache, type CardFaceParams } from './CardFace'
import { AnimationDirector, type DirectorBridge } from './anim/AnimationDirector'
import { computeTiltTarget } from './tilt'
import { fxEnabled, setEffectQuality, type EffectQuality } from './fx/quality'
import { tableThemeFor } from './fx/theme'
import { outlineColorFor } from './cardOutline'

export interface TableRendererOptions {
  /** 视角方（决定手牌归属与演出文案），默认 'P1' */
  viewer?: PlayerId
  /** 内容包接入点：cardId → 卡面数据（CardDefinition.art 等） */
  getCardDef?(cardId: string): CardDefinition | undefined
  /** 特效质量档（M4-R3D5 性能红线：全局降级开关），默认 'high'；运行时可经 handle.setFxQuality 切换 */
  fxQuality?: EffectQuality
}

export interface PickCallbacks {
  onHandCardClick?(uid: string): void
  onHandCardHover?(uid: string | null): void
  onUnitClick?(instanceId: string): void
  onHeroClick?(playerId: PlayerId): void
  onPileClick?(pile: 'deck' | 'graveyard', playerId: PlayerId): void
}

export interface TableRendererHandle {
  /** 整帧对账：以 viewFor 裁剪视图重建/更新 全部实体摆位与数值 */
  syncView(view: PlayerView): void
  /** 播放一批引擎事件（驱动动画；先 syncView 后调用） */
  enqueueEvents(events: readonly GameEvent[]): void
  /** 演出快进（跳过本批全部动画） */
  fastForward(): void
  setPickCallbacks(cb: PickCallbacks): void
  /** 运行时切换全局特效质量档（M4-R3D5：设置界面可接） */
  setFxQuality(q: EffectQuality): void
  /** 是否有演出在播（UI 可据此显示「跳过」按钮） */
  readonly isPlaying: boolean
  dispose(): void
}

/** 牌库/墓地堆指示器：薄牌堆 + 计数角标（程序化，随 syncView 刷新） */
class PileLabel {
  readonly group = new THREE.Group()
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private texture: THREE.CanvasTexture
  private label: THREE.Mesh

  constructor(
    readonly pile: 'deck' | 'graveyard',
    readonly playerId: PlayerId,
    pick: PickInfo,
  ) {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 128
    this.canvas.height = 64
    this.ctx = this.canvas.getContext('2d') as CanvasRenderingContext2D
    this.texture = new THREE.CanvasTexture(this.canvas)
    this.texture.colorSpace = THREE.SRGBColorSpace
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(CARD_W * 0.98, 0.09, 1.36),
      new THREE.MeshStandardMaterial({ color: '#101820', roughness: 0.8 }),
    )
    slab.position.y = 0.05
    this.label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.64, 0.32),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false }),
    )
    this.label.position.set(0, 0.42, 0)
    this.label.renderOrder = 10
    const pickMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(CARD_W * 1.2, 1.6),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    pickMesh.rotation.x = -Math.PI / 2
    pickMesh.position.y = 0.08
    pickMesh.userData.pick = pick
    this.group.add(slab, this.label, pickMesh)
  }

  setCount(n: number): void {
    const { ctx } = this
    ctx.clearRect(0, 0, 128, 64)
    ctx.fillStyle = 'rgba(6,10,14,0.85)'
    ctx.fillRect(0, 0, 128, 64)
    ctx.strokeStyle = '#35d0ff'
    ctx.lineWidth = 4
    ctx.strokeRect(2, 2, 124, 60)
    ctx.fillStyle = '#e8f2f8'
    ctx.font = '900 40px "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(String(n), 64, 34)
    this.texture.needsUpdate = true
  }

  dispose(): void {
    this.texture.dispose()
    this.label.geometry.dispose()
    ;(this.label.material as THREE.MeshBasicMaterial).dispose()
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o !== this.label) {
        o.geometry.dispose()
        const m = o.material as THREE.Material
        m.dispose()
      }
    })
  }
}

class EntityUpdater implements Updatable {
  constructor(private readonly getEntities: () => Iterable<CardEntity>) {}

  update(dt: number): void {
    for (const e of this.getEntities()) e.update(dt)
  }
}

export function createTableRenderer(
  canvas: HTMLCanvasElement,
  opts: TableRendererOptions = {},
): TableRendererHandle {
  const viewer: PlayerId = opts.viewer ?? 'P1'
  setEffectQuality(opts.fxQuality ?? 'high')
  const scene = new SceneManager(canvas)
  const pool = new CardEntityPool(scene.scene, makeCardBackTexture)
  const ghostPool = new CardEntityPool(scene.scene, makeCardBackTexture)
  const faceCache = new TextureCache()
  let cardBackTexture: THREE.Texture | null = null

  const hand = new Map<string, CardEntity>()
  const units = new Map<string, CardEntity>()
  const enemyHand: CardEntity[] = []
  const heroes = new Map<PlayerId, HeroPlate>()
  const piles = new Map<string, PileLabel>()
  /** 已从视图消失、等本批演出结束再回收的实体（死亡/出牌演出需要旧实体） */
  const pendingRelease = new Set<CardEntity>()
  const liveEntities = new Set<CardEntity>()
  let hoverUid: string | null = null
  let disposed = false

  function makeCardBackTexture(): THREE.Texture {
    if (!cardBackTexture) {
      const tex = new THREE.CanvasTexture(drawCardBack())
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = 4
      cardBackTexture = tex
    }
    return cardBackTexture
  }

  /** 内容包未含该卡（卡池 JSON 未就绪 / mod 缺失）时的占位定义，保证任意 cardId 可渲染 */
  function placeholderDef(cardId: string, cost: number, attack?: number, health?: number): CardDefinition {
    return { id: cardId, name: cardId, faction: 'neutral', type: attack !== undefined ? 'gpu' : 'driver', cost, attack, health }
  }

  function getFace(def: CardDefinition, cost?: number, attack?: number, health?: number): THREE.Texture | null {
    if (typeof document === 'undefined') return null
    try {
      const key = cardFaceKey(def.id, cost, attack, health)
      const hit = faceCache.get(key)
      if (hit) return hit
      const params: CardFaceParams = { def, cost, attack, health }
      // 同步底：背景层 + 底版文本 + 角标立即可渲染（不卡主线程）
      const canvas = drawCardFace(params)
      const tex = faceCache.put(key, canvas)
      // 懒生成：SVG 图形层（形制骨架×派系母题×框饰×角标）异步解码补绘，
      // 完成后原地刷新纹理；失败不致命（同步底版仍完整可渲染）。
      void composeCardFaceArt(canvas, params)
        .then(() => {
          tex.needsUpdate = true
        })
        .catch(() => {})
      return tex
    } catch {
      return null
    }
  }
  function cardFaceKey(id: string, cost?: number, attack?: number, health?: number): string {
    return `${id}|${cost ?? ''}|${attack ?? ''}|${health ?? ''}`
  }

  // —— 实体登记 ——
  function track(e: CardEntity): void {
    liveEntities.add(e)
  }
  function untrack(e: CardEntity): void {
    liveEntities.delete(e)
    pendingRelease.delete(e)
  }

  // —— 桥接（导演需要的一切经此回调，不直接持有对账表） ——
  const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)
  /** tilt 目标角计算的复用向量（每帧投影卡面中心用，帧内零分配） */
  const tiltCenterScratch = new THREE.Vector3()
  /**
   * 事件里的玩家 id → 近/远侧系数：视角方永远坐近侧（+z），
   * 对手坐远侧；场上单位排仍按绝对 ownerId 布局（双方可见）。
   */
  const sideOfRole = (playerId: PlayerId): 1 | -1 => sideOf(playerId === viewer ? 'P1' : 'P2')
  const bridge: DirectorBridge = {
    viewerId: viewer,
    getHandCard: (uid) => hand.get(uid) ?? null,
    getUnit: (instanceId) => units.get(instanceId) ?? null,
    getHero: (playerId) => heroes.get(playerId) ?? null,
    deckAnchor: (playerId) => {
      const p = PILE.deck
      const s = sideOfRole(playerId)
      return v3(p.x * s, 0.12, p.z * s)
    },
    handAnchor: (playerId) => {
      const s = sideOfRole(playerId)
      return v3(4.3 * s, 0.15, HAND_Z * s)
    },
    boardCenter: (playerId) => v3(0, 0.2, BOARD_Z[playerId]),
    flushReleased: () => {
      for (const e of pendingRelease) {
        pool.release(e)
        untrack(e)
      }
      pendingRelease.clear()
    },
    spawnGhost: (tex, rotY = 0) => {
      const ghost = ghostPool.acquire()
      track(ghost)
      ghost.setBase({ rotY })
      if (tex) ghost.setFaceTexture(tex)
      ghost.opacity = 1
      return ghost
    },
    releaseGhost: (ghost) => {
      ghostPool.release(ghost)
      untrack(ghost)
    },
    // 传说入场演出判定源：内容包卡定义的稀有度（未接入内容包 → 普通卡演出）
    getCardRarity: (cardId) => opts.getCardDef?.(cardId)?.rarity,
  }

  const director = new AnimationDirector(scene, bridge)
  scene.registerUpdatable(director)
  scene.registerUpdatable(new EntityUpdater(() => liveEntities))

  // —— 手牌指针跟随 tilt（M4-R3D5 需求 1；演出修正阶段一重写目标角计算）：
  //    目标角 = 指针相对卡面中心的偏移（投影到 NDC）按轴归一化并饱和钳制（tilt.ts），
  //    边缘处目标角有界、梯度归零；其余手牌喂 (0,0) 平滑收回。
  //    零分配：投影复用闭包级 scratch 向量，帧内不 new ——
  scene.registerUpdatable({
    update: () => {
      if (hand.size === 0) return
      const p = scene.pointerNDC
      for (const [uid, e] of hand) {
        if (uid === hoverUid) {
          e.getWorldPosition(tiltCenterScratch)
          tiltCenterScratch.project(scene.camera)
          const t = computeTiltTarget(p.x, p.y, tiltCenterScratch.x, tiltCenterScratch.y)
          e.setTilt(t.x, t.y)
        } else {
          e.setTilt(0, 0)
        }
      }
    },
  })

  // —— 拾取 → 交互回调 + hover 抬起 ——
  let callbacks: PickCallbacks = {}
  scene.setPickHandlers({
    onPickHover: (info) => {
      const uid = info?.kind === 'handCard' && info.playerId === viewer ? info.uid : null
      if (hoverUid && hoverUid !== uid) hand.get(hoverUid)?.setHovered(false)
      if (uid && uid !== hoverUid) hand.get(uid)?.setHovered(true)
      hoverUid = uid
      callbacks.onHandCardHover?.(uid)
    },
    onPickClick: (info) => {
      if (info.kind === 'handCard' && info.playerId === viewer) callbacks.onHandCardClick?.(info.uid)
      else if (info.kind === 'unit') callbacks.onUnitClick?.(info.instanceId)
      else if (info.kind === 'hero') callbacks.onHeroClick?.(info.playerId)
      else if (info.kind === 'pile') callbacks.onPileClick?.(info.pile, info.playerId)
    },
  })

  // —— 布局 ——
  function relayoutHand(view: PlayerView): void {
    const cards = view.you.hand
    const transforms = handTransforms(cards.length, HAND_Z)
    cards.forEach((c, i) => {
      const e = hand.get(c.uid)
      const t = transforms[i]
      if (e && t) e.setBase(t)
    })
    enemyHand.forEach((e, i) => {
      const t = handSlotTransform(i, enemyHand.length, -HAND_Z)
      e.setBase({ ...t, rotY: Math.PI })
    })
  }

  function relayoutUnits(view: PlayerView): void {
    const byOwner: Record<PlayerId, BoardUnit[]> = { P1: [], P2: [] }
    for (const u of view.board) byOwner[u.ownerId]?.push(u)
    for (const pid of ['P1', 'P2'] as const) {
      const list = byOwner[pid]
      list.forEach((u, i) => {
        const e = units.get(u.instanceId)
        if (!e) return
        e.setBase({
          x: (i - (list.length - 1) / 2) * BOARD_SLOT_DX,
          y: 0.5,
          z: BOARD_Z[pid],
          rotX: -0.32,
          rotY: 0,
          rotZ: 0,
          scale: 1,
        })
      })
    }
  }

  function ensurePile(pile: 'deck' | 'graveyard', playerId: PlayerId): PileLabel {
    const key = `${pile}:${playerId}`
    let label = piles.get(key)
    if (!label) {
      const pos = PILE[pile]
      const s = sideOfRole(playerId)
      label = new PileLabel(pile, playerId, { kind: 'pile', pile, playerId })
      label.group.position.set(pos.x * s, 0, pos.z * s)
      label.group.rotation.y = s > 0 ? 0 : Math.PI
      scene.scene.add(label.group)
      piles.set(key, label)
    }
    return label
  }

  function ensureHero(view: PlayerView): void {
    const entries: [PlayerId, { heroName: string; faction: string; health: number; maxHealth: number; armor: number }][] = [
      [view.viewer, view.you],
      [other(view.viewer), view.opponent],
    ]
    for (const [pid, p] of entries) {
      let plate = heroes.get(pid)
      if (!plate) {
        plate = new HeroPlate(pid)
        const near = pid === view.viewer
        plate.group.position.set(HERO_X, 0.55, near ? HERO_Z.P1 : HERO_Z.P2)
        plate.group.rotation.x = near ? -0.42 : 0.42
        scene.scene.add(plate.group)
        heroes.set(pid, plate)
      }
      plate.setInfo({
        heroName: p.heroName,
        faction: p.faction,
        health: p.health,
        maxHealth: p.maxHealth,
        armor: p.armor,
        primary: resolvePalette(undefined, p.faction).primary,
        active: view.activePlayer === pid && view.phase === 'main',
      })
    }
  }
  function other(pid: PlayerId): PlayerId {
    return pid === 'P1' ? 'P2' : 'P1'
  }

  function syncHand(view: PlayerView): void {
    const seen = new Set<string>()
    view.you.hand.forEach((c, i) => {
      seen.add(c.uid)
      let e = hand.get(c.uid)
      if (!e) {
        e = pool.acquire()
        hand.set(c.uid, e)
        track(e)
        e.setPickInfo({ kind: 'handCard', uid: c.uid, playerId: viewer })
        const def = opts.getCardDef?.(c.cardId) ?? placeholderDef(c.cardId, c.cost)
        const tex = getFace(def, c.cost)
        if (tex) e.setFaceTexture(tex)
        // 立体描边（演出修正阶段二）：按派系上色，传说卡金边
        e.setOutline(outlineColorFor(def.faction, def.rarity))
        // 入场演出：卡背翻正 + 浮落（起手多张按序错峰；与 CARD_DRAWN 飞牌幽灵衔接）
        director.playHandEntrance(e, 0.22 + i * 0.07)
      }
      e.setBase({ rotY: 0 })
    })
    for (const [uid, e] of hand) {
      if (seen.has(uid)) continue
      hand.delete(uid)
      e.setPickInfo({ kind: 'handCard', uid, playerId: viewer })
      e.setInteractive(false)
      pendingRelease.add(e)
    }
    // 对手手牌：只有张数，画卡背；描边按对手派系（牌面未知的派系色环）
    while (enemyHand.length < view.opponent.handSize) {
      const e = pool.acquire()
      track(e)
      e.setOutline(outlineColorFor(view.opponent.faction, undefined))
      enemyHand.push(e)
    }
    while (enemyHand.length > view.opponent.handSize) {
      const e = enemyHand.pop()
      if (e) pendingRelease.add(e)
    }
  }

  function syncUnits(view: PlayerView): void {
    const seen = new Set<string>()
    for (const u of view.board) {
      seen.add(u.instanceId)
      let e = units.get(u.instanceId)
      if (!e) {
        e = pool.acquire()
        units.set(u.instanceId, e)
        track(e)
        e.setPickInfo({ kind: 'unit', instanceId: u.instanceId, ownerId: u.ownerId })
      }
      const def = opts.getCardDef?.(u.cardId) ?? placeholderDef(u.cardId, 0, u.attack, u.health)
      const tex = getFace(def, def.cost, u.attack, u.health)
      if (tex && tex !== e.faceTexture) e.setFaceTexture(tex)
      // 立体描边（演出修正阶段二）：按派系上色，传说卡金边
      e.setOutline(outlineColorFor(def.faction, def.rarity))
      e.show()
    }
    for (const [instanceId, e] of units) {
      if (seen.has(instanceId)) continue
      units.delete(instanceId)
      e.setInteractive(false)
      pendingRelease.add(e)
    }
  }

  function syncPiles(view: PlayerView): void {
    for (const pid of [view.viewer, other(view.viewer)] as const) {
      const self = pid === view.viewer ? view.you : view.opponent
      ensurePile('deck', pid).setCount(self.deckSize)
      ensurePile('graveyard', pid).setCount(self.graveyardSize)
    }
  }

  function syncView(view: PlayerView): void {
    if (disposed) return
    ensureHero(view)
    syncUnits(view)
    syncHand(view)
    relayoutHand(view)
    relayoutUnits(view)
    syncPiles(view)
    syncTheme(view)
  }

  // —— 牌桌派系主题（M4-R3D5 需求 5）：双方派系色 → 灯光/环境/槽位，平滑过渡 ——
  let themeKey = ''
  function syncTheme(view: PlayerView): void {
    const key = `${view.you.faction}|${view.opponent.faction}`
    if (key === themeKey) return
    themeKey = key
    // low 档关闭牌桌染色（'theme' 闸门）：null → SceneManager 回落中性暗色
    scene.setFactionTheme(fxEnabled('theme') ? tableThemeFor(view.you.faction, view.opponent.faction) : null)
  }

  function enqueueEvents(events: readonly GameEvent[]): void {
    if (disposed) return
    director.enqueueEvents(events)
  }

  function fastForward(): void {
    scene.fastForward() // 内含 director.fastForward → 哨兵触发 flushReleased
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    scene.unregisterUpdatable(director)
    for (const plate of heroes.values()) plate.dispose()
    for (const pile of piles.values()) {
      scene.scene.remove(pile.group)
      pile.dispose()
    }
    pool.releaseAll()
    pool.dispose()
    ghostPool.dispose()
    faceCache.dispose()
    cardBackTexture?.dispose()
    hand.clear()
    units.clear()
    enemyHand.length = 0
    pendingRelease.clear()
    liveEntities.clear()
    scene.dispose()
  }

  return {
    syncView,
    enqueueEvents,
    fastForward,
    setPickCallbacks: (cb) => {
      callbacks = cb
    },
    setFxQuality: (q) => {
      setEffectQuality(q)
    },
    get isPlaying(): boolean {
      return director.timeline.active
    },
    dispose,
  }
}
