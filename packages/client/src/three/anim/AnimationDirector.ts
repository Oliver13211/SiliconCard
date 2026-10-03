/**
 * 动画导演（M1-R3D4）：事件流的播放枢纽。
 *
 * 职责：把 GameEvent[] 逐条经 eventAnimationMap 路由到具体演出；持有共享
 * Timeline（update 由 SceneManager 渲染循环驱动；fastForward 一步清空）；
 * 提供 AnimationContext 的全部实现（实体查找经 DirectorBridge 回调到
 * TableRenderer 的实体登记表，避免导演直接持有对账状态）。
 *
 * 顺序契约：调用方先 syncView 再 enqueueEvents；本批事件播完（或快进）时
 * 经 flushReleased 回调让 TableRenderer 释放"上一帧已消失"的实体，
 * 保证 MINION_DIED / CARD_PLAYED 这类"事件需要旧实体位置"的演出有据可查。
 */

import * as THREE from 'three'
import type { GameEvent, PlayerId, TargetRef } from '@siliconcard/core'
import type { CardEntity } from '../CardEntity'
import type { CameraShot } from '../layout'
import type { FloatTextSpec } from '../fx/textSprite'
import type { SceneManager, Updatable } from '../SceneManager'
import type { AnimationContext } from './types'
import { eventAnimationMap } from './eventAnimationMap'
import { Timeline } from './tween'

export interface DirectorBridge {
  viewerId: PlayerId
  getHandCard(uid: string): CardEntity | null
  getUnit(instanceId: string): CardEntity | null
  getHero(playerId: PlayerId): { getWorldPosition(out: THREE.Vector3): THREE.Vector3 } | null
  deckAnchor(playerId: PlayerId): THREE.Vector3
  handAnchor(playerId: PlayerId): THREE.Vector3
  boardCenter(playerId: PlayerId): THREE.Vector3
  /** 本批事件演完/快进后回收待释放实体 */
  flushReleased(): void
  /** 幽灵飞行体（与对账实体池分离，演出不与 syncView 打架） */
  spawnGhost(cardTexture: THREE.Texture | null, rotY?: number): CardEntity
  releaseGhost(ghost: CardEntity): void
}

export class AnimationDirector implements Updatable {
  readonly timeline = new Timeline()
  private ctx: AnimationContext
  private playing = false

  constructor(
    private readonly scene: SceneManager,
    private readonly bridge: DirectorBridge,
  ) {
    this.ctx = {
      timeline: this.timeline,
      viewerId: bridge.viewerId,
      getHandCard: (uid) => bridge.getHandCard(uid),
      getUnit: (instanceId) => bridge.getUnit(instanceId),
      getHero: (playerId) => bridge.getHero(playerId),
      deckAnchor: (playerId) => bridge.deckAnchor(playerId),
      handAnchor: (playerId) => bridge.handAnchor(playerId),
      boardCenter: (playerId) => bridge.boardCenter(playerId),
      targetPosition: (target: TargetRef) => this.resolveTarget(target),
      floatText: (pos, spec: FloatTextSpec) => scene.floaters.spawn(pos, spec),
      smokeAt: (pos, count) => scene.smoke.spawn(pos, count),
      shatterAt: (pos, tex, rotY) => scene.shards.burst(pos, tex, rotY),
      screenFlash: (color, peak, decay) => scene.flash.flash(color, peak, decay),
      banner: (text, color) =>
        scene.floaters.spawn(new THREE.Vector3(0, 2.5, 0.6), {
          text,
          color,
          size: 96,
          life: 1.6,
          rise: 0.35,
        }),
      cameraSnap: (shot: CameraShot) => {
        scene.cameraRig.moveTo(shot)
        scene.cameraRig.snap()
      },
      cameraMove: (shot: CameraShot) => scene.cameraRig.moveTo(shot),
      spawnGhost: (tex, rotY = 0) => bridge.spawnGhost(tex, rotY),
      releaseGhost: (ghost) => bridge.releaseGhost(ghost),
    }
  }

  /** 批量入队（一次 applyAction 的 events 数组整批播放） */
  enqueueEvents(events: readonly GameEvent[]): void {
    for (const ev of events) this.playOne(ev)
    if (events.length > 0) {
      // 哨兵：本批最后一条演出结束时回收待释放实体（快进同样触发）
      this.timeline.add({ duration: 0.05, onDone: () => this.bridge.flushReleased() })
    }
  }

  /** 单条事件路由（映射表是唯一入口） */
  playOne(ev: GameEvent): void {
    const entry = eventAnimationMap[ev.type]
    if (entry.kind === 'exempt') return
    // TS 无法在索引访问后保留判别联合关联，此处收口为一次受控断言
    ;(entry.play as (ctx: AnimationContext, event: GameEvent) => void)(this.ctx, ev)
  }

  update(dt: number): void {
    this.timeline.update(dt)
    this.playing = this.timeline.active
  }

  /** 快进：清空全部补间（含哨兵 → flushReleased 触发） */
  fastForward(): void {
    this.timeline.fastForward()
    this.playing = false
  }

  private resolveTarget(target: TargetRef): THREE.Vector3 | null {
    if (target.kind === 'unit') {
      const unit = this.bridge.getUnit(target.instanceId)
      return unit ? unit.getWorldPosition(new THREE.Vector3()) : null
    }
    const hero = this.bridge.getHero(target.playerId)
    return hero ? hero.getWorldPosition(new THREE.Vector3()) : null
  }
}
