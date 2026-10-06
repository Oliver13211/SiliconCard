/**
 * M4-R3D5 无头测试：事件→演出路由升级版（在 M1 映射表测试之上加舞台特效出口断言）。
 *
 * 覆盖：
 * - 传说卡 MINION_SUMMONED 专属演出（光柱 + 震屏 + 流光）与普通卡的区分；
 * - HERO_POWER_USED 七系派系技能专属动画 + 未知技能兜底；
 * - amd 光追失败借位事件（KEYWORD_TRIGGERED detail='光追失败'）的失败演出；
 * - ATTACK_DECLARED 命中反馈、CARD_DRAWN 拖迹、CARD_PLAYED 落场环、BURN_OUT 电弧、
 *   GAME_END 定格、DAMAGE_DEALT 受击闪色等；
 * - 17/17 全事件在新出口缺失的旧桩上仍可播放（向后兼容）。
 */

import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BoardUnit, GameEvent } from '@siliconcard/core'
import { CardEntity } from '../CardEntity'
import { eventAnimationMap, SKILL_FACTION } from '../anim/eventAnimationMap'
import type { AnimationContext } from '../anim/types'
import { Timeline } from '../anim/tween'
import { setEffectQuality } from '../fx/quality'
import type { ParticlePresetName } from '../fx/stageFx'

afterEach(() => {
  setEffectQuality('high')
})

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

/** 带新出口记录器的扩展桩（新出口全部落数组供断言） */
function makeCtx(rarity: string | undefined = undefined) {
  const timeline = new Timeline()
  const unit = new CardEntity(new THREE.Texture())
  const handCard = new CardEntity(new THREE.Texture())
  unit.faceTexture = new THREE.Texture()
  const ghosts: CardEntity[] = []
  const released: CardEntity[] = []
  const particles: ParticlePresetName[] = []
  const rings: string[] = []
  const pillars: string[] = []
  const bolts: number[] = []
  const beams: number[] = []
  const progress: number[] = []
  const shakes: number[] = []
  const floatTexts: string[] = []
  const hero = { getWorldPosition: vi.fn((out: THREE.Vector3) => out.set(0, 0.55, 2.95)) }

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
      ghosts.push(ghost)
      return ghost
    }),
    releaseGhost: vi.fn((ghost: CardEntity) => released.push(ghost)),
    // —— M4-R3D5 新出口 ——
    getCardRarity: vi.fn(() => rarity),
    particles: vi.fn((_pos: THREE.Vector3, preset: ParticlePresetName) => particles.push(preset)),
    ringAt: vi.fn((_pos: THREE.Vector3, color: string) => rings.push(color)),
    pillarAt: vi.fn((_pos: THREE.Vector3, color: string) => pillars.push(color)),
    boltBetween: vi.fn(() => bolts.push(1)),
    beamTo: vi.fn(() => beams.push(1)),
    progressBarAt: vi.fn(() => progress.push(1)),
    shakeCamera: vi.fn((trauma: number) => shakes.push(trauma)),
  }
  return { ctx, timeline, unit, handCard, ghosts, released, particles, rings, pillars, bolts, beams, progress, shakes, floatTexts }
}

/** 类型收窄助手：播放条目并断言为真动画 */
function playEntry(entry: { kind: string }, ctx: AnimationContext, ev: GameEvent): void {
  if (entry.kind !== 'animation' || !('play' in entry)) throw new Error('expected animation entry')
  ;(entry.play as (c: AnimationContext, e: GameEvent) => void)(ctx, ev)
}

describe('传说卡入场专属演出（验收硬标准）', () => {
  it('rarity=legendary：光柱 + 震屏 + 金环 + 传说粒子 + 描边流光，编排显著更长', () => {
    const { ctx, timeline, unit, pillars, rings, particles, shakes } = makeCtx('legendary')
    playEntry(eventAnimationMap.MINION_SUMMONED, ctx, {
      type: 'MINION_SUMMONED',
      unit: mkUnit(),
      source: 'play',
    })
    expect(pillars).toHaveLength(1)
    expect(pillars[0]).toBe('#ff9d2e')
    expect(shakes.length).toBeGreaterThan(0)
    expect(rings).toContain('#ff9d2e')
    expect(particles).toContain('legendSpark')
    expect(unit.flashing).toBe(true) // 金色描边流光
    expect(timeline.size).toBeGreaterThanOrEqual(2)
    timeline.fastForward()
    expect(unit.fxScale).toBe(1)
    expect(unit.opacity).toBe(1)
  })

  it('普通卡：仅短促蓝色召唤光柱、无震屏无流光，走空投+落场环的短编排（与传说明显区分）', () => {
    const { ctx, unit, pillars, shakes, rings, particles } = makeCtx(undefined)
    playEntry(eventAnimationMap.MINION_SUMMONED, ctx, {
      type: 'MINION_SUMMONED',
      unit: mkUnit(),
      source: 'play',
    })
    expect(pillars).toEqual(['#35d0ff']) // 召唤光柱：短促、本方蓝
    expect(shakes).toHaveLength(0) // 无镜头微震
    expect(rings).toContain('#35d0ff') // 落场冲击环
    expect(particles).toContain('dust') // 落场尘土
    expect(unit.flashing).toBe(false) // 无金色描边流光
  })
})

describe('HERO_POWER_USED 七系派系技能专属动画', () => {
  const cases: { skillId: string; assert: (r: ReturnType<typeof makeCtx>) => void }[] = [
    {
      skillId: 'dlss',
      assert: (r) => {
        // 帧插值拖影：目标单位残影 ×3
        expect(r.ghosts).toHaveLength(3)
        expect(r.particles).toContain('drawStreak')
      },
    },
    {
      skillId: 'ray_tracing_try',
      assert: (r) => {
        expect(r.beams).toHaveLength(1) // 英雄位→目标光束
      },
    },
    {
      skillId: 'driver_update',
      assert: (r) => {
        expect(r.progress).toHaveLength(1) // 分段进度条
        expect(r.rings).toHaveLength(1)
      },
    },
    {
      skillId: 'dust_off',
      assert: (r) => {
        expect(r.particles).toContain('dustClean') // 灰尘扬起
        expect(r.rings).toHaveLength(1)
      },
    },
    {
      skillId: 'efficiency',
      assert: (r) => {
        expect(r.rings.length).toBeGreaterThanOrEqual(2) // 能效护盾环
        expect(r.particles).toContain('healMote')
      },
    },
    {
      skillId: 'tops_marketing',
      assert: (r) => {
        expect(r.rings.length).toBeGreaterThanOrEqual(2) // 连环营销环
        expect(r.particles).toContain('topsBurst')
        expect(r.shakes.length).toBeGreaterThan(0)
      },
    },
    {
      skillId: 'reference_design',
      assert: (r) => {
        expect(r.pillars).toHaveLength(1) // 传送光柱
        expect(r.particles).toContain('teleport')
      },
    },
  ]

  it.each(cases.map((c) => [c.skillId] as const))('%s：专属演出命中', (skillId) => {
    const r = makeCtx()
    const c = cases.find((x) => x.skillId === skillId)
    if (!c) throw new Error('unreachable')
    playEntry(eventAnimationMap.HERO_POWER_USED, r.ctx, {
      type: 'HERO_POWER_USED',
      playerId: 'P1',
      skillId,
      target: { kind: 'unit', instanceId: 'i2' },
    })
    c.assert(r)
    expect(SKILL_FACTION[skillId]).toBeTruthy()
    r.timeline.fastForward()
  })

  it('未知技能（mod）：回落通用演出，不炸不空转', () => {
    const r = makeCtx()
    playEntry(eventAnimationMap.HERO_POWER_USED, r.ctx, {
      type: 'HERO_POWER_USED',
      playerId: 'P1',
      skillId: 'mod_skill_x',
      target: null,
    })
    expect(r.beams).toHaveLength(0)
    expect(r.pillars).toHaveLength(0)
    expect(r.floatTexts.some((t) => t.includes('mod_skill_x'))).toBe(true)
  })

  it('七系 skillId 表与 rules.md §8 一一对应', () => {
    expect(Object.keys(SKILL_FACTION).sort()).toEqual(
      ['dlss', 'driver_update', 'dust_off', 'efficiency', 'ray_tracing_try', 'reference_design', 'tops_marketing'].sort(),
    )
  })
})

describe('AMD 光追失败（rules.md §5 借位契约）', () => {
  it("KEYWORD_TRIGGERED detail='光追失败'：红色电弧 + 灰尘 + 失败飘字（无金色迸发）", () => {
    const r = makeCtx()
    playEntry(eventAnimationMap.KEYWORD_TRIGGERED, r.ctx, {
      type: 'KEYWORD_TRIGGERED',
      keyword: 'overload',
      instanceId: 'ray_tracing_try',
      detail: '光追失败',
    })
    expect(r.bolts.length).toBe(2)
    expect(r.particles).toContain('dustClean')
    expect(r.particles).not.toContain('goldBurst')
    expect(r.floatTexts.some((t) => t.includes('光追失败'))).toBe(true)
  })

  it('普通 KEYWORD_TRIGGERED：金色迸发 + 梗名飘字，无电弧', () => {
    const r = makeCtx()
    playEntry(eventAnimationMap.KEYWORD_TRIGGERED, r.ctx, {
      type: 'KEYWORD_TRIGGERED',
      keyword: 'divine_shield',
      instanceId: 'i1',
      detail: '',
    })
    expect(r.bolts).toHaveLength(0)
    expect(r.particles).toContain('goldBurst')
    expect(r.floatTexts).toContain('三年质保')
  })
})

describe('17 事件升级后的可感知演出', () => {
  it('ATTACK_DECLARED：命中瞬间只触发一次冲击环+火花+震屏+受击红闪', () => {
    const r = makeCtx()
    playEntry(eventAnimationMap.ATTACK_DECLARED, r.ctx, {
      type: 'ATTACK_DECLARED',
      attackerId: 'i1',
      target: { kind: 'unit', instanceId: 'i2' },
    })
    expect(r.rings).toHaveLength(0) // 冲段前半程未命中
    r.timeline.fastForward() // onUpdate(1) 越过命中点
    expect(r.rings).toContain('#ff5d4d')
    expect(r.particles).toContain('hitSpark')
    expect(r.shakes).toHaveLength(1) // impacted 标记防重复
    expect(r.unit.flashing).toBe(true)
  })

  it('DAMAGE_DEALT：直伤红闪；盾耗金涟漪；护甲格挡灰白涟漪', () => {
    const plain = makeCtx()
    playEntry(eventAnimationMap.DAMAGE_DEALT, plain.ctx, {
      type: 'DAMAGE_DEALT',
      source: { kind: 'unit', instanceId: 'i1' },
      target: { kind: 'unit', instanceId: 'i2' },
      amount: 2,
      remainingHealth: 1,
    })
    expect(plain.rings).toHaveLength(0)
    expect(plain.unit.flashing).toBe(true)
    expect(plain.particles).toContain('hitSpark')

    const shield = makeCtx()
    playEntry(eventAnimationMap.DAMAGE_DEALT, shield.ctx, {
      type: 'DAMAGE_DEALT',
      source: { kind: 'unit', instanceId: 'i1' },
      target: { kind: 'unit', instanceId: 'i2' },
      amount: 5,
      remainingHealth: 0,
      shieldConsumed: true,
    })
    expect(shield.rings).toContain('#ffc53d')
    expect(shield.floatTexts).toContain('三年质保碎裂')

    const armor = makeCtx()
    playEntry(eventAnimationMap.DAMAGE_DEALT, armor.ctx, {
      type: 'DAMAGE_DEALT',
      source: { kind: 'unit', instanceId: 'i1' },
      target: { kind: 'unit', instanceId: 'i2' },
      amount: 5,
      remainingHealth: 3,
      armorAbsorbed: 2,
    })
    expect(armor.rings).toContain('#c8d4dd')
  })

  it('CARD_DRAWN：飞行沿途发射蓝光拖迹；fatigue 源无演出', () => {
    const r = makeCtx()
    playEntry(eventAnimationMap.CARD_DRAWN, r.ctx, {
      type: 'CARD_DRAWN',
      playerId: 'P1',
      cardId: 'c1',
      source: 'deck',
    })
    expect(r.particles).toHaveLength(0)
    r.timeline.update(0.1) // p=0.2 越过首个发射节流点
    expect(r.particles.length).toBeGreaterThan(0)
    r.timeline.fastForward()
    expect(r.released).toEqual(r.ghosts)

    const fatigue = makeCtx()
    playEntry(eventAnimationMap.CARD_DRAWN, fatigue.ctx, {
      type: 'CARD_DRAWN',
      playerId: 'P1',
      cardId: null,
      source: 'fatigue',
    })
    expect(fatigue.ghosts).toHaveLength(0)
    expect(fatigue.timeline.active).toBe(false)
  })

  it('CARD_PLAYED：空翻弧线 + 落场冲击环 + 幽灵回收；传说卡金焰拖迹', () => {
    const r = makeCtx(undefined)
    playEntry(eventAnimationMap.CARD_PLAYED, r.ctx, {
      type: 'CARD_PLAYED',
      playerId: 'P1',
      uid: 'h1',
      cardId: 'c1',
      cost: 100,
      target: null,
    })
    r.timeline.fastForward()
    expect(r.rings).toContain('#35d0ff')
    expect(r.released).toEqual(r.ghosts)

    const legend = makeCtx('legendary')
    playEntry(eventAnimationMap.CARD_PLAYED, legend.ctx, {
      type: 'CARD_PLAYED',
      playerId: 'P1',
      uid: 'h1',
      cardId: 'c1',
      cost: 100,
      target: null,
    })
    legend.timeline.fastForward()
    expect(legend.rings).toContain('#ff9d2e')
    expect(legend.particles).toContain('legendSpark')
  })

  it('BURN_OUT：黄色两连闪屏 + 三道电弧 + 震屏 + 锁定提示', () => {
    const r = makeCtx()
    playEntry(eventAnimationMap.BURN_OUT, r.ctx, { type: 'BURN_OUT', playerId: 'P1', lockedMana: 200 })
    expect(r.bolts).toHaveLength(3)
    expect(r.shakes).toHaveLength(1)
    expect(r.ctx.screenFlash).toHaveBeenCalledWith('#ffd23d', 0.7, 1.8)
    expect(r.floatTexts.some((t) => t.includes('200'))).toBe(true)
  })

  it('GAME_END：胜方彩带+金色光柱+重震；败方只有定格闪屏', () => {
    const win = makeCtx()
    playEntry(eventAnimationMap.GAME_END, win.ctx, { type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
    expect(win.particles).toContain('confetti')
    expect(win.pillars).toHaveLength(1)
    expect(win.shakes).toHaveLength(1)

    const lose = makeCtx()
    playEntry(eventAnimationMap.GAME_END, lose.ctx, { type: 'GAME_END', winner: 'P2', reason: 'health_zero' })
    expect(lose.pillars).toHaveLength(0)
    expect(lose.shakes).toHaveLength(1)
  })

  it('MINION_DIED：碎裂 + 碎裂冲击环 + 黑烟 + 本体隐藏', () => {
    const r = makeCtx()
    playEntry(eventAnimationMap.MINION_DIED, r.ctx, { type: 'MINION_DIED', unit: mkUnit(), cause: 'damage' })
    expect(r.unit.group.visible).toBe(false)
    expect(r.ctx.shatterAt).toHaveBeenCalledTimes(1)
    expect(r.rings).toHaveLength(1)
    expect(r.ctx.smokeAt).toHaveBeenCalledTimes(1)
  })

  it('HEALING / ARMOR_GAINED / CARD_BURNED / FATIGUE / TURN_START：粒子与涟漪齐备', () => {
    const heal = makeCtx()
    playEntry(eventAnimationMap.HEALING, heal.ctx, {
      type: 'HEALING',
      target: { kind: 'hero', playerId: 'P1' },
      amount: 3,
      resultingHealth: 10,
    })
    expect(heal.particles).toContain('healMote')
    expect(heal.floatTexts).toContain('+3')

    const armor = makeCtx()
    playEntry(eventAnimationMap.ARMOR_GAINED, armor.ctx, {
      type: 'ARMOR_GAINED',
      playerId: 'P1',
      amount: 2,
      totalArmor: 2,
    })
    expect(armor.rings).toHaveLength(1)
    expect(armor.particles).toContain('armorUp')

    const burn = makeCtx()
    playEntry(eventAnimationMap.CARD_BURNED, burn.ctx, {
      type: 'CARD_BURNED',
      playerId: 'P1',
      cardId: 'c1',
      reason: 'hand_full',
    })
    expect(burn.particles).toContain('ember')
    expect(burn.ctx.smokeAt).toHaveBeenCalledTimes(1)

    const fatigue = makeCtx()
    playEntry(eventAnimationMap.FATIGUE, fatigue.ctx, {
      type: 'FATIGUE',
      playerId: 'P1',
      fatigueCount: 2,
      damage: 2,
    })
    expect(fatigue.ctx.screenFlash).toHaveBeenCalled()
    expect(fatigue.particles).toContain('ember')

    const turn = makeCtx()
    playEntry(eventAnimationMap.TURN_START, turn.ctx, {
      type: 'TURN_START',
      turn: 3,
      playerId: 'P1',
      maxMana: 300,
      drawCount: 1,
    })
    expect(turn.rings).toHaveLength(1) // 回合方英雄位光环
  })

  it('17/17 全事件在旧桩（新出口缺失）上仍可播放（向后兼容）', () => {
    // 旧桩：无任何 M4-R3D5 新出口 —— 映射表必须可选调用不炸
    const timeline = new Timeline()
    const unit = new CardEntity(new THREE.Texture())
    unit.faceTexture = new THREE.Texture()
    const ghosts: CardEntity[] = []
    const oldStub: AnimationContext = {
      timeline,
      viewerId: 'P1',
      getHandCard: () => null,
      getUnit: () => unit,
      getHero: () => null,
      deckAnchor: () => new THREE.Vector3(),
      handAnchor: () => new THREE.Vector3(),
      boardCenter: () => new THREE.Vector3(),
      targetPosition: () => new THREE.Vector3(0, 0.5, -1.15),
      floatText: () => {},
      smokeAt: () => {},
      shatterAt: () => {},
      screenFlash: () => {},
      banner: () => {},
      cameraSnap: () => {},
      cameraMove: () => {},
      spawnGhost: () => {
        const g = new CardEntity(new THREE.Texture())
        ghosts.push(g)
        return g
      },
      releaseGhost: () => {},
    }
    const samples: GameEvent[] = [
      { type: 'GAME_START', seed: 1, firstPlayer: 'P1' },
      { type: 'TURN_START', turn: 1, playerId: 'P1', maxMana: 100, drawCount: 0 },
      { type: 'TURN_END', turn: 1, playerId: 'P1' },
      { type: 'CARD_DRAWN', playerId: 'P1', cardId: 'c1', source: 'deck' },
      { type: 'CARD_PLAYED', playerId: 'P1', uid: 'h1', cardId: 'c1', cost: 10, target: null },
      { type: 'CARD_BURNED', playerId: 'P1', cardId: 'c1', reason: 'hand_full' },
      { type: 'MINION_SUMMONED', unit: mkUnit(), source: 'play' },
      { type: 'MINION_DIED', unit: mkUnit(), cause: 'damage' },
      { type: 'ATTACK_DECLARED', attackerId: 'i1', target: { kind: 'unit', instanceId: 'i2' } },
      {
        type: 'DAMAGE_DEALT',
        source: { kind: 'unit', instanceId: 'i1' },
        target: { kind: 'unit', instanceId: 'i2' },
        amount: 1,
        remainingHealth: 1,
      },
      { type: 'HEALING', target: { kind: 'hero', playerId: 'P1' }, amount: 1, resultingHealth: 9 },
      { type: 'KEYWORD_TRIGGERED', keyword: 'taunt', instanceId: 'i1', detail: '' },
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'dlss', target: null },
      { type: 'FATIGUE', playerId: 'P1', fatigueCount: 1, damage: 1 },
      { type: 'BURN_OUT', playerId: 'P1', lockedMana: 100 },
      { type: 'ARMOR_GAINED', playerId: 'P1', amount: 1, totalArmor: 1 },
      { type: 'GAME_END', winner: null, reason: 'concede' },
    ]
    for (const ev of samples) {
      const entry = eventAnimationMap[ev.type]
      expect(entry.kind, ev.type).toBe('animation')
      if (entry.kind !== 'animation') continue
      ;(entry.play as (c: AnimationContext, e: GameEvent) => void)(oldStub, ev)
    }
    timeline.fastForward()
    expect(timeline.active).toBe(false)
  })

  it('low 质量档：传说入场跳过光柱/震屏（池 spawn 端联动，此处验证路由端仍在）', () => {
    setEffectQuality('low')
    const r = makeCtx('legendary')
    playEntry(eventAnimationMap.MINION_SUMMONED, r.ctx, {
      type: 'MINION_SUMMONED',
      unit: mkUnit(),
      source: 'play',
    })
    // 路由端照常发出口（真实降级发生在池的 spawn 判 gate，见 stageFxPool.test）
    expect(r.pillars).toHaveLength(1)
    r.timeline.fastForward()
    expect(r.unit.fxScale).toBe(1)
  })
})
