/**
 * 演出修正阶段一 无头测试：全屏演出层与强力时刻触发路由（需求 3）。
 *
 * 覆盖：
 * - ScreenImpactFx 生命周期（fire → 推进 → 熄灭；重入重启；快进清场；dispose）；
 * - isAoeDamageBatch 批判定纯函数（≥3 不同目标；单挑攻反 2 目标不误报）；
 * - 事件映射的全屏演出触发：传说入场 / 高费入场 / 大额一次伤害 / 效果入场传说，
 *   以及不触发的反例（低费、小额、质保完全格挡、play 入场的传说不双触发）。
 */

import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardUnit, GameEvent } from '@siliconcard/core'
import { CardEntity } from '../CardEntity'
import { eventAnimationMap, FULLSCREEN_AOE_COLOR, FULLSCREEN_BIG_DAMAGE, FULLSCREEN_COST_THRESHOLD, isAoeDamageBatch } from '../anim/eventAnimationMap'
import type { AnimationContext } from '../anim/types'
import { Timeline } from '../anim/tween'
import { setEffectQuality } from '../fx/quality'
import { ScreenImpactFx } from '../fx/screenImpact'

afterEach(() => {
  setEffectQuality('high')
})

describe('ScreenImpactFx（相机挂载全屏 quad，单实例池化）', () => {
  it('fire → 演出中 → 播完自动熄灭', () => {
    const fx = new ScreenImpactFx(new THREE.PerspectiveCamera())
    expect(fx.activeCount).toBe(0)
    fx.fire('#ff9d2e', 1.1)
    expect(fx.activeCount).toBe(1)
    fx.update(0.2)
    expect(fx.activeCount).toBe(1)
    fx.update(0.4) // 0.6s > duration 0.5s
    expect(fx.activeCount).toBe(0)
    fx.dispose()
  })

  it('重入 fire 即重启（单实例合并，不叠加抢戏）', () => {
    const fx = new ScreenImpactFx(new THREE.PerspectiveCamera())
    fx.fire('#ff5d4d', 0.9)
    fx.update(0.3)
    fx.fire('#ff9d2e', 1.1) // 重入：重新计时
    expect(fx.activeCount).toBe(1)
    fx.update(0.2)
    expect(fx.activeCount).toBe(1)
    fx.update(0.35)
    expect(fx.activeCount).toBe(0)
    fx.dispose()
  })

  it('finishAll 快进立即清场；intensity 钳制在 0.6~1.3', () => {
    const fx = new ScreenImpactFx(new THREE.PerspectiveCamera())
    fx.fire('#35d0ff', 99) // 过大 → 钳到 1.3
    fx.update(0.1)
    fx.finishAll()
    expect(fx.activeCount).toBe(0)
    fx.fire('#35d0ff', -5) // 过小 → 钳到 0.6，仍可播放
    expect(fx.activeCount).toBe(1)
    fx.finishAll()
    fx.dispose()
  })

  it('推进过程中各组份 opacity 按各自曲线演化（冲击波/色偏衰减、暗角快起）', () => {
    const fx = new ScreenImpactFx(new THREE.PerspectiveCamera()) as unknown as {
      waveMat: THREE.MeshBasicMaterial
      chromaMatA: THREE.MeshBasicMaterial
      vignetteMat: THREE.MeshBasicMaterial
      update(dt: number): void
      fire(color: string, intensity?: number): void
      finishAll(): void
      dispose(): void
    }
    fx.fire('#ffc53d', 1)
    const wave0 = fx.waveMat.opacity
    const chroma0 = fx.chromaMatA.opacity
    expect(wave0).toBeGreaterThan(0) // 触发帧即有完整视觉态
    expect(fx.vignetteMat.opacity).toBe(0) // 暗角从 0 快起
    fx.update(0.04)
    expect(fx.vignetteMat.opacity).toBeGreaterThan(0) // 快起段
    fx.update(0.11)
    expect(fx.waveMat.opacity).toBeGreaterThan(0)
    expect(fx.waveMat.opacity).toBeLessThan(wave0)
    expect(fx.chromaMatA.opacity).toBeLessThan(chroma0) // 色偏快速归位
    fx.finishAll()
    fx.dispose()
  })
})

describe('isAoeDamageBatch（AOE 批判定纯函数）', () => {
  const dmg = (instanceId: string): GameEvent => ({
    type: 'DAMAGE_DEALT',
    source: { kind: 'effect' },
    target: { kind: 'unit', instanceId },
    amount: 1,
    remainingHealth: 0,
  })

  it('同批 ≥3 个不同目标受击 → AOE', () => {
    expect(isAoeDamageBatch([dmg('a'), dmg('b'), dmg('c')])).toBe(true)
  })

  it('同批 2 个目标（普通攻击 + 反击）→ 不误报', () => {
    expect(isAoeDamageBatch([dmg('a'), dmg('b')])).toBe(false)
  })

  it('同一目标反复受击不累计；混入英雄目标也按去重计', () => {
    expect(isAoeDamageBatch([dmg('a'), dmg('a'), dmg('a')])).toBe(false)
    expect(
      isAoeDamageBatch([
        dmg('a'),
        dmg('b'),
        { type: 'DAMAGE_DEALT', source: { kind: 'effect' }, target: { kind: 'hero', playerId: 'P2' }, amount: 1, remainingHealth: 9 },
      ]),
    ).toBe(true)
    expect(isAoeDamageBatch([{ type: 'CARD_DRAWN', playerId: 'P1', cardId: 'c1', source: 'deck' }])).toBe(false)
    expect(isAoeDamageBatch([])).toBe(false)
  })

  it('阈值常量与汇报口径一致（≥400W 高费 / ≥5 大额）', () => {
    expect(FULLSCREEN_COST_THRESHOLD).toBe(400)
    expect(FULLSCREEN_BIG_DAMAGE).toBe(5)
    expect(FULLSCREEN_AOE_COLOR).toBe('#ff5d4d')
  })
})

// —— 事件映射的全屏演出触发路由（ctx 桩带 screenImpact 记录器） ——

function mkUnit(overrides: Partial<BoardUnit> = {}): BoardUnit {
  return {
    instanceId: 'i1',
    cardId: 'c1',
    ownerId: 'P1',
    attack: 3,
    health: 3,
    maxHealth: 3,
    keywords: [],
    summonedOnTurn: 1,
    attacksRemaining: 1,
    attackedThisTurn: false,
    ...overrides,
  }
}

function makeCtx(rarity: string | undefined = undefined) {
  const timeline = new Timeline()
  const unit = new CardEntity(new THREE.Texture())
  unit.faceTexture = new THREE.Texture()
  const impacts: { color: string; intensity?: number }[] = []
  const shakes: number[] = []
  const hero = { getWorldPosition: vi.fn((out: THREE.Vector3) => out.set(0, 0.55, 2.95)) }
  const ctx: AnimationContext = {
    timeline,
    viewerId: 'P1',
    getHandCard: vi.fn(() => new CardEntity(new THREE.Texture())),
    getUnit: vi.fn(() => unit),
    getHero: vi.fn(() => hero),
    deckAnchor: vi.fn(() => new THREE.Vector3()),
    handAnchor: vi.fn(() => new THREE.Vector3(4.3, 0.15, 3.7)),
    boardCenter: vi.fn(() => new THREE.Vector3(0, 0.2, 1.15)),
    targetPosition: vi.fn(() => new THREE.Vector3(0, 0.5, -1.15)),
    floatText: vi.fn(),
    smokeAt: vi.fn(),
    shatterAt: vi.fn(),
    screenFlash: vi.fn(),
    banner: vi.fn(),
    cameraSnap: vi.fn(),
    cameraMove: vi.fn(),
    spawnGhost: vi.fn(() => {
      const g = new CardEntity(new THREE.Texture())
      return g
    }),
    releaseGhost: vi.fn(),
    getCardRarity: vi.fn(() => rarity),
    particles: vi.fn(),
    ringAt: vi.fn(),
    pillarAt: vi.fn(),
    boltBetween: vi.fn(),
    beamTo: vi.fn(),
    progressBarAt: vi.fn(),
    shakeCamera: vi.fn((trauma: number) => shakes.push(trauma)),
    screenImpact: vi.fn((color: string, intensity?: number) => impacts.push({ color, intensity })),
  }
  return { ctx, timeline, impacts, shakes }
}

function playEntry(entry: { kind: string }, ctx: AnimationContext, ev: GameEvent): void {
  if (entry.kind !== 'animation' || !('play' in entry)) throw new Error('expected animation entry')
  ;(entry.play as (c: AnimationContext, e: GameEvent) => void)(ctx, ev)
}

describe('强力时刻全屏演出触发路由', () => {
  it('传说卡入场（CARD_PLAYED）：全屏演出 + 微震，传说色', () => {
    const r = makeCtx('legendary')
    playEntry(eventAnimationMap.CARD_PLAYED, r.ctx, {
      type: 'CARD_PLAYED', playerId: 'P1', uid: 'h1', cardId: 'c1', cost: 50, target: null,
    })
    expect(r.impacts).toEqual([{ color: '#ff9d2e', intensity: 1.1 }])
    expect(r.shakes.length).toBeGreaterThan(0)
  })

  it('高费卡入场（cost ≥ 400W，非传说）：全屏演出 + 微震，信息蓝', () => {
    const r = makeCtx(undefined)
    playEntry(eventAnimationMap.CARD_PLAYED, r.ctx, {
      type: 'CARD_PLAYED', playerId: 'P1', uid: 'h1', cardId: 'c1', cost: 450, target: null,
    })
    expect(r.impacts).toEqual([{ color: '#35d0ff', intensity: 0.9 }])
    expect(r.shakes.length).toBeGreaterThan(0)
  })

  it('低费普通卡入场：无全屏演出（反例）', () => {
    const r = makeCtx(undefined)
    playEntry(eventAnimationMap.CARD_PLAYED, r.ctx, {
      type: 'CARD_PLAYED', playerId: 'P1', uid: 'h1', cardId: 'c1', cost: 150, target: null,
    })
    expect(r.impacts).toHaveLength(0)
  })

  it('大额一次伤害（≥5 且未盾耗）触发；小额与质保格挡不触发（反例）', () => {
    const big = makeCtx()
    playEntry(eventAnimationMap.DAMAGE_DEALT, big.ctx, {
      type: 'DAMAGE_DEALT', source: { kind: 'unit', instanceId: 'i1' },
      target: { kind: 'unit', instanceId: 'i2' }, amount: 6, remainingHealth: 0,
    })
    expect(big.impacts).toHaveLength(1)
    expect(big.impacts[0]).toMatchObject({ color: '#ff5d4d' })

    const small = makeCtx()
    playEntry(eventAnimationMap.DAMAGE_DEALT, small.ctx, {
      type: 'DAMAGE_DEALT', source: { kind: 'unit', instanceId: 'i1' },
      target: { kind: 'unit', instanceId: 'i2' }, amount: 2, remainingHealth: 1,
    })
    expect(small.impacts).toHaveLength(0)

    const shielded = makeCtx()
    playEntry(eventAnimationMap.DAMAGE_DEALT, shielded.ctx, {
      type: 'DAMAGE_DEALT', source: { kind: 'unit', instanceId: 'i1' },
      target: { kind: 'unit', instanceId: 'i2' }, amount: 5, remainingHealth: 3, shieldConsumed: true,
    })
    expect(shielded.impacts).toHaveLength(0)
  })

  it('传说卡效果入场（source=effect）补齐全屏演出；play 入场不双触发（由 CARD_PLAYED 承担）', () => {
    const effect = makeCtx('legendary')
    playEntry(eventAnimationMap.MINION_SUMMONED, effect.ctx, {
      type: 'MINION_SUMMONED', unit: mkUnit(), source: 'effect',
    })
    expect(effect.impacts).toEqual([{ color: '#ff9d2e', intensity: 1.1 }])

    const play = makeCtx('legendary')
    playEntry(eventAnimationMap.MINION_SUMMONED, play.ctx, {
      type: 'MINION_SUMMONED', unit: mkUnit(), source: 'play',
    })
    expect(play.impacts).toHaveLength(0)
  })
})
