/**
 * M4-SND1 无头测试：事件→音效映射表完整性（docs/rules.md §6 的 17 种音频契约）。
 *
 * 与 eventAnimationMap.test 同款三层保障：
 * 1. 编译期：eventSoundMap 声明为映射类型 `{ [K in GameEvent['type']] }`，
 *    引擎新增事件而本表未补 → typecheck 直接失败；
 * 2. A 组：运行时键集 == §6 目录（防键名写错的静默缺失）；
 * 3. B/C 组：逐事件解析 spec 并做合法性校验（不允许哑音条目 / 越界参数），
 *    变体级（视角 / 伤害类型 / 七派系技能）必须给出可区分的音色。
 */

import { describe, expect, it } from 'vitest'
import type { BoardUnit, GameEvent } from '@siliconcard/core'
import { eventSoundMap, resolveEventSound } from '../audio/soundMap'
import { specProblems } from '../audio/spec'
import type { SoundSpec } from '../audio/spec'

/** docs/rules.md §6 事件目录定稿（17 种）——音频契约的镜像清单（与渲染契约同源） */
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

describe('A 组：映射表完整性（音频契约）', () => {
  it('键集 == docs/rules.md §6 的 17 种事件，不多不少', () => {
    expect(Object.keys(eventSoundMap).sort()).toEqual([...CATALOG_17].sort())
  })

  it('每个条目都是可调用函数（17/17 无哑音条目、无默认吞事件）', () => {
    for (const type of CATALOG_17) {
      expect(typeof eventSoundMap[type], `${type} 必须有条目`).toBe('function')
    }
  })
})

describe('B 组：17 事件逐条解析（spec 合法、参数不越界）', () => {
  for (const type of CATALOG_17) {
    it(`${type}：resolveEventSound 产出合法 SoundSpec`, () => {
      const spec = resolveEventSound(sampleEvent(type), 'P1')
      expect(spec.layers.length, `${type} 必须有主音层`).toBeGreaterThan(0)
      expect(specProblems(spec), `${type} spec 存在非法参数`).toEqual([])
    })
  }

  it('命中音落在视觉冲击帧附近（ATTACK_DECLARED 的 delay 对齐弹冲段）', () => {
    const spec = resolveEventSound(
      { type: 'ATTACK_DECLARED', attackerId: 'i1', target: { kind: 'unit', instanceId: 'i2' } },
      'P1',
    )
    const delays = spec.layers.map((l) => l.delay ?? 0)
    // 视觉：0.16s 蓄力结束起弹冲，p>0.45（≈0.31s）触发冲击 → 命中音应落在 0.25..0.4s
    expect(delays.some((d) => d >= 0.25 && d <= 0.4)).toBe(true)
    // 出手破空音应在蓄力结束附近（≤0.2s）
    expect(delays.filter((d) => d <= 0.2).length).toBeGreaterThan(0)
  })

  it('CARD_PLAYED 落场音对齐 0.42s 飞行补间的冲击帧', () => {
    const spec = resolveEventSound(
      { type: 'CARD_PLAYED', playerId: 'P1', uid: 'h1', cardId: 'c1', cost: 100, target: null },
      'P1',
    )
    const delays = spec.layers.map((l) => l.delay ?? 0)
    expect(delays.some((d) => d >= 0.35 && d <= 0.45)).toBe(true)
  })
})

describe('C 组：变体分流（同事件不同 payload 必须可区分）', () => {
  const fingerprint = (spec: SoundSpec): string => JSON.stringify(spec)

  it('TURN_START：己方回合（明亮升调）≠ 对面回合（低弱降调）', () => {
    const mine = resolveEventSound({ type: 'TURN_START', turn: 1, playerId: 'P1', maxMana: 100, drawCount: 1 }, 'P1')
    const theirs = resolveEventSound({ type: 'TURN_START', turn: 1, playerId: 'P2', maxMana: 100, drawCount: 1 }, 'P1')
    expect(fingerprint(mine)).not.toBe(fingerprint(theirs))
  })

  it('TURN_END：己方 vs 对面可区分', () => {
    const mine = resolveEventSound({ type: 'TURN_END', turn: 1, playerId: 'P1' }, 'P1')
    const theirs = resolveEventSound({ type: 'TURN_END', turn: 1, playerId: 'P2' }, 'P1')
    expect(fingerprint(mine)).not.toBe(fingerprint(theirs))
  })

  it('CARD_DRAWN：正常抽牌 ≠ 疲劳空抽', () => {
    const deck = resolveEventSound({ type: 'CARD_DRAWN', playerId: 'P1', cardId: 'c1', source: 'deck' }, 'P1')
    const fatigue = resolveEventSound({ type: 'CARD_DRAWN', playerId: 'P1', cardId: null, source: 'fatigue' }, 'P1')
    expect(fingerprint(deck)).not.toBe(fingerprint(fatigue))
  })

  it('DAMAGE_DEALT：直伤 / 三年质保 / 护甲格挡三种反馈可区分', () => {
    const base = { type: 'DAMAGE_DEALT', source: { kind: 'unit', instanceId: 'i1' }, amount: 2 } as const
    const plain = resolveEventSound({ ...base, target: { kind: 'unit', instanceId: 'i2' }, remainingHealth: 1 }, 'P1')
    const shield = resolveEventSound(
      { ...base, target: { kind: 'unit', instanceId: 'i2' }, remainingHealth: 1, shieldConsumed: true },
      'P1',
    )
    const armor = resolveEventSound(
      { ...base, target: { kind: 'unit', instanceId: 'i2' }, remainingHealth: 1, armorAbsorbed: 1 },
      'P1',
    )
    const set = new Set([fingerprint(plain), fingerprint(shield), fingerprint(armor)])
    expect(set.size).toBe(3)
  })

  it('KEYWORD_TRIGGERED：光追失败（借位契约）≠ 普通关键词生效', () => {
    const fail = resolveEventSound(
      { type: 'KEYWORD_TRIGGERED', keyword: 'overload', instanceId: 'i1', detail: '光追失败' },
      'P1',
    )
    const normal = resolveEventSound(
      { type: 'KEYWORD_TRIGGERED', keyword: 'overload', instanceId: 'i1', detail: '' },
      'P1',
    )
    expect(fingerprint(fail)).not.toBe(fingerprint(normal))
  })

  it('HERO_POWER_USED：七派系技能音色两两可辨，未知技能（mod）回落通用音不哑', () => {
    const skills = ['dlss', 'ray_tracing_try', 'driver_update', 'dust_off', 'efficiency', 'tops_marketing', 'reference_design']
    const prints = new Set<string>()
    for (const skillId of skills) {
      const spec = resolveEventSound({ type: 'HERO_POWER_USED', playerId: 'P1', skillId, target: null }, 'P1')
      expect(spec.layers.length, skillId).toBeGreaterThan(0)
      expect(specProblems(spec), skillId).toEqual([])
      prints.add(fingerprint(spec))
    }
    expect(prints.size, '七派系音色必须两两可辨').toBe(skills.length)
    const unknown = resolveEventSound({ type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'mod_unknown', target: null }, 'P1')
    expect(unknown.layers.length).toBeGreaterThan(0)
    expect(prints.has(fingerprint(unknown))).toBe(false)
  })

  it('GAME_END：胜利 / 败北 / 平局三种定格音可区分（按 viewer 视角）', () => {
    const win = resolveEventSound({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' }, 'P1')
    const lose = resolveEventSound({ type: 'GAME_END', winner: 'P2', reason: 'health_zero' }, 'P1')
    const draw = resolveEventSound({ type: 'GAME_END', winner: null, reason: 'health_zero' }, 'P1')
    const loseFromP2 = resolveEventSound({ type: 'GAME_END', winner: 'P2', reason: 'concede' }, 'P2')
    const set = new Set([fingerprint(win), fingerprint(lose), fingerprint(draw)])
    expect(set.size).toBe(3)
    // 同一结果换视角翻转：P2 视角的 P2 获胜 = 胜利音
    expect(fingerprint(loseFromP2)).toBe(fingerprint(win))
  })
})
