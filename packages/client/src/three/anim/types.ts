/**
 * 事件→动画映射的类型契约（M1-R3D4）。
 *
 * 映射表键集 = GameEvent['type']（17 种，docs/rules.md §6 渲染契约），
 * 用映射类型 `[K in GameEvent['type']]` 强制全键覆盖：新增引擎事件而不补映射
 * 时 typecheck 直接报错（WF-ENGINE 要求的「先补映射再写动画」由此落地）。
 */

import type { GameEvent, PlayerId, TargetRef } from '@siliconcard/core'
import type * as THREE from 'three'
import type { CardEntity } from '../CardEntity'
import type { FloatTextSpec } from '../fx/textSprite'
import type { CameraShot } from '../layout'
import type { Timeline } from './tween'

/** 动画播放环境：由 AnimationDirector 实现（依赖倒置，映射表零场景依赖、可无头桩测） */
export interface AnimationContext {
  /** 共享补间时间线（快进 = Timeline.fastForward） */
  timeline: Timeline
  /** 当前视角（GAME_END 胜负文案需要） */
  viewerId: PlayerId

  // —— 实体查找（找不到一律安全 no-op，事件与视觉短暂不同步不炸） ——
  getHandCard(uid: string): CardEntity | null
  getUnit(instanceId: string): CardEntity | null
  getHero(playerId: PlayerId): { getWorldPosition(out: THREE.Vector3): THREE.Vector3 } | null

  // —— 锚点 ——
  deckAnchor(playerId: PlayerId): THREE.Vector3
  handAnchor(playerId: PlayerId): THREE.Vector3
  boardCenter(playerId: PlayerId): THREE.Vector3

  /** TargetRef → 世界坐标（单位/英雄），解析失败返回 null */
  targetPosition(target: TargetRef): THREE.Vector3 | null

  // —— 特效出口 ——
  floatText(pos: THREE.Vector3, spec: FloatTextSpec): void
  smokeAt(pos: THREE.Vector3, count?: number): void
  shatterAt(pos: THREE.Vector3, cardTexture: THREE.Texture | null, rotY: number): void
  screenFlash(color: string, peakOpacity?: number, decayPerSec?: number): void
  /** 全场横幅（回合切换 / 结算） */
  banner(text: string, color: string): void
  cameraSnap(shot: CameraShot): void
  cameraMove(shot: CameraShot): void

  /** 幽灵飞行体（脱离 syncView 对账的临时卡面，出牌/抽牌演出用） */
  spawnGhost(cardTexture: THREE.Texture | null, rotY?: number): CardEntity
  releaseGhost(ghost: CardEntity): void
}

/** 映射表条目：真动画，或带逐条理由的豁免（验收允许明确豁免） */
export type EventAnimation<K extends GameEvent['type']> =
  | {
      kind: 'animation'
      play: (ctx: AnimationContext, event: Extract<GameEvent, { type: K }>) => void
    }
  | { kind: 'exempt'; reason: string }

/** 17 事件的完整映射（键全量由编译期保证） */
export type EventAnimationMap = { [K in GameEvent['type']]: EventAnimation<K> }
