/**
 * M1-R3D4 无头测试：事件→动画映射表完整性（docs/rules.md §6 的 17 种渲染契约）。
 *
 * 三层保障：
 * 1. 编译期：eventAnimationMap 声明为映射类型 `{ [K in GameEvent['type']] }`，
 *    引擎新增事件而本表未补 → yarn typecheck 直接失败；
 * 2. 本测试 A 组：运行时键集 == §6 目录（防"键写错名"式的静默缺失）；
 * 3. 本测试 B/C 组：逐事件真实播放（stub 场景 + 真实 Timeline/实体），
 *    断言补间确实入队、快进可一步清场、幽灵体回收。
 */

import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import type { BoardUnit, GameEvent } from '@siliconcard/core'
import { CardEntity } from '../CardEntity'
import { eventAnimationMap } from '../anim/eventAnimationMap'
import type { AnimationContext } from '../anim/types'
import { Timeline } from '../anim/tween'

/** docs/rules.md §6 事件目录定稿（17 种）——渲染契约的镜像清单 */
const CATALOG_17 = [
  'GAME_START',
  'TURN_START',
  'TURN_END',
  'CARD_DRAWN',
  'CARD_PLAYED',
  'CARD_BURNED',
  'MINION_SUMMONED',
  'MINION_DIED',
  'ATTACK_DECLARED',
  'DAMAGE_DEALT',
  'HEALING',
  'KEYWORD_TRIGGERED',
  'HERO_POWER_USED',
  'FATIGUE',
  'BURN_OUT',
  'ARMOR_GAINED',
  'GAME_END',
] as const

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

/** stub 场景上下文：真实 Timeline + 真实 CardEntity（THREE 纯 CPU 对象，无 WebGL） */
function makeCtx() {
  const timeline = new Timeline()
  const spawned: CardEntity[] = []
  const released: CardEntity[] = []
  const unit = new CardEntity(new THREE.Texture())
  const handCard = new CardEntity(new THREE.Texture())
  unit.faceTexture = new THREE.Texture()
  const hero = { getWorldPosition: vi.fn((out: THREE.Vector3) => out.set(0, 0.5, -2.9)) }
  const floatTexts: string[] = []

  const ctx: AnimationContext = {
    timeline,
    viewerId: 'P1',
    getHandCard: vi.fn(() => handCard),
    getUnit: vi.fn(() => unit),
    getHero: vi.fn(() => hero),
    deckAnchor: vi.fn(() => new THREE.Vector3(4.6, 0.1, 3.1)),
    handAnchor: vi.fn(() => new THREE.Vector3(4.3, 0.15, 3.7)),
    boardCenter: vi.fn(() => new THREE.Vector3(0, 0.2, 1.15)),
    targetPosition: vi.fn(() => new THREE.Vector3(0, 0.5, -1.15)),
    floatText: vi.fn((_pos: THREE.Vector3, spec: { text: string }) => floatTexts.push(spec.text)),
    smokeAt: vi.fn(),
    shatterAt: vi.fn(),
    screenFlash: vi.fn(),
    banner: vi.fn(),
    cameraSnap: vi.fn(),
    cameraMove: vi.fn(),
    spawnGhost: vi.fn((tex: THREE.Texture | null, rotY = 0) => {
      const ghost = new CardEntity(new THREE.Texture())
      ghost.setBase({ rotY })
      if (tex) ghost.setFaceTexture(tex)
      spawned.push(ghost)
      return ghost
    }),
    releaseGhost: vi.fn((ghost: CardEntity) => released.push(ghost)),
  }
  return { ctx, timeline, spawned, released, unit, handCard, floatTexts }
}

/** 逐类型代表事件（payload 合法、可复现 §6 各行的主路径） */
function sampleEvent(type: (typeof CATALOG_17)[number]): GameEvent {
  const unit = mkUnit()
  switch (type) {
    case 'GAME_START':
      return { type: 'GAME_START', seed: 42, firstPlayer: 'P1' }
    case 'TURN_START':
      return { type: 'TURN_START', turn: 3, playerId: 'P1', maxMana: 300, drawCount: 1 }
    case 'TURN_END':
      return { type: 'TURN_END', turn: 3, playerId: 'P1' }
    case 'CARD_DRAWN':
      return { type: 'CARD_DRAWN', playerId: 'P1', cardId: 'c1', source: 'deck' }
    case 'CARD_PLAYED':
      return { type: 'CARD_PLAYED', playerId: 'P1', uid: 'h1', cardId: 'c1', cost: 100, target: null }
    case 'CARD_BURNED':
      return { type: 'CARD_BURNED', playerId: 'P1', cardId: 'c1', reason: 'hand_full' }
    case 'MINION_SUMMONED':
      return { type: 'MINION_SUMMONED', unit, source: 'play' }
    case 'MINION_DIED':
      return { type: 'MINION_DIED', unit, cause: 'damage' }
    case 'ATTACK_DECLARED':
      return { type: 'ATTACK_DECLARED', attackerId: 'i1', target: { kind: 'unit', instanceId: 'i2' } }
    case 'DAMAGE_DEALT':
      return {
        type: 'DAMAGE_DEALT',
        source: { kind: 'unit', instanceId: 'i1' },
        target: { kind: 'unit', instanceId: 'i2' },
        amount: 2,
        remainingHealth: 1,
      }
    case 'HEALING':
      return { type: 'HEALING', target: { kind: 'hero', playerId: 'P1' }, amount: 3, resultingHealth: 10 }
    case 'KEYWORD_TRIGGERED':
      return { type: 'KEYWORD_TRIGGERED', keyword: 'divine_shield', instanceId: 'i1', detail: '' }
    case 'HERO_POWER_USED':
      return { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'dlss', target: null }
    case 'FATIGUE':
      return { type: 'FATIGUE', playerId: 'P1', fatigueCount: 2, damage: 2 }
    case 'BURN_OUT':
      return { type: 'BURN_OUT', playerId: 'P1', lockedMana: 100 }
    case 'ARMOR_GAINED':
      return { type: 'ARMOR_GAINED', playerId: 'P1', amount: 2, totalArmor: 2 }
    case 'GAME_END':
      return { type: 'GAME_END', winner: 'P1', reason: 'health_zero' }
  }
}

describe('A 组：映射表完整性（渲染契约）', () => {
  it('键集 == docs/rules.md §6 的 17 种事件，不多不少', () => {
    expect(Object.keys(eventAnimationMap).sort()).toEqual([...CATALOG_17].sort())
  })

  it('每个条目要么是真动画、要么带非空豁免理由（验收条款）', () => {
    for (const type of CATALOG_17) {
      const entry = eventAnimationMap[type]
      if (entry.kind === 'exempt') {
        expect(entry.reason.trim().length, `${type} 豁免必须写明理由`).toBeGreaterThan(0)
      } else {
        expect(typeof entry.play, `${type} 动画条目必须有 play`).toBe('function')
      }
    }
  })
})

describe('B 组：17 事件逐条真实播放（stub 场景不炸、补间入队、快进清场）', () => {
  for (const type of CATALOG_17) {
    it(`${type}：play 可执行，演出全部入 Timeline 且可快进`, () => {
      const { ctx, timeline } = makeCtx()
      const ev = sampleEvent(type)
      const entry = eventAnimationMap[type]
      expect(entry.kind).toBe('animation')
      if (entry.kind !== 'animation') return
      entry.play(ctx, ev as never)
      // 快进：全部补间一步到位（onDone 触发幽灵回收等收尾）
      timeline.fastForward()
      expect(timeline.active).toBe(false)
    })
  }
})

describe('C 组：行为断言（代表性演出真的在做事）', () => {
  it('CARD_DRAWN(source=deck)：生成卡背幽灵并飞向手牌，快进后回收', () => {
    const { ctx, timeline, spawned, released } = makeCtx()
    const entry = eventAnimationMap.CARD_DRAWN
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, { type: 'CARD_DRAWN', playerId: 'P1', cardId: 'c1', source: 'deck' })
    expect(spawned).toHaveLength(1)
    expect(ctx.deckAnchor).toHaveBeenCalledWith('P1')
    timeline.fastForward()
    expect(released).toEqual(spawned)
  })

  it('CARD_DRAWN(source=fatigue)：无卡可飞，零幽灵（疲劳演出由 FATIGUE 事件承担）', () => {
    const { ctx, timeline, spawned } = makeCtx()
    const entry = eventAnimationMap.CARD_DRAWN
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, { type: 'CARD_DRAWN', playerId: 'P1', cardId: null, source: 'fatigue' })
    expect(spawned).toHaveLength(0)
    expect(timeline.active).toBe(false)
  })

  it('MINION_DIED：本体隐藏 + 生成 3×3 碎裂', () => {
    const { ctx, timeline, unit } = makeCtx()
    const entry = eventAnimationMap.MINION_DIED
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, { type: 'MINION_DIED', unit: mkUnit(), cause: 'damage' })
    expect(unit.group.visible).toBe(false)
    expect(ctx.shatterAt).toHaveBeenCalledTimes(1)
    timeline.fastForward()
  })

  it('DAMAGE_DEALT：红色飘字，盾耗附加质保提示', () => {
    const { ctx, floatTexts } = makeCtx()
    const entry = eventAnimationMap.DAMAGE_DEALT
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, {
      type: 'DAMAGE_DEALT',
      source: { kind: 'unit', instanceId: 'i1' },
      target: { kind: 'unit', instanceId: 'i2' },
      amount: 5,
      remainingHealth: 0,
      shieldConsumed: true,
    })
    expect(floatTexts).toContain('-5')
    expect(floatTexts).toContain('三年质保碎裂')
  })

  it('ATTACK_DECLARED：蓄力+弹冲两段补间入队', () => {
    const { ctx, timeline } = makeCtx()
    const entry = eventAnimationMap.ATTACK_DECLARED
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, { type: 'ATTACK_DECLARED', attackerId: 'i1', target: { kind: 'unit', instanceId: 'i2' } })
    expect(timeline.size).toBe(2) // sequence 的两段
    timeline.fastForward()
    expect(timeline.active).toBe(false)
  })

  it('GAME_START：先 snap 到开场机位，随后补间切回对战机位', () => {
    const { ctx, timeline } = makeCtx()
    const entry = eventAnimationMap.GAME_START
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, { type: 'GAME_START', seed: 1, firstPlayer: 'P1' })
    expect(ctx.cameraSnap).toHaveBeenCalledWith('intro')
    timeline.fastForward()
    expect(ctx.cameraMove).toHaveBeenCalledWith('table')
  })

  it('BURN_OUT：跳闸闪屏 + 锁定提示', () => {
    const { ctx, floatTexts } = makeCtx()
    const entry = eventAnimationMap.BURN_OUT
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, { type: 'BURN_OUT', playerId: 'P1', lockedMana: 200 })
    expect(ctx.screenFlash).toHaveBeenCalledWith('#ffd23d', 0.7, 1.8)
    expect(floatTexts.some((t) => t.includes('200'))).toBe(true)
  })

  it('GAME_END：胜利文案按视角区分（viewerId=P1）', () => {
    const { ctx } = makeCtx()
    const entry = eventAnimationMap.GAME_END
    if (entry.kind !== 'animation') throw new Error('unreachable')
    entry.play(ctx, { type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
    expect(ctx.banner).toHaveBeenCalledWith('胜利！R.I.P 对面烧了', '#ffc53d')
    entry.play(ctx, { type: 'GAME_END', winner: 'P2', reason: 'health_zero' })
    expect(ctx.banner).toHaveBeenCalledWith('败北 · 你的卡阵亡了', '#ff5d4d')
    entry.play(ctx, { type: 'GAME_END', winner: null, reason: 'health_zero' })
    expect(ctx.banner).toHaveBeenCalledWith('平局 · 双双烧毁', '#c8d4dd')
  })
})
