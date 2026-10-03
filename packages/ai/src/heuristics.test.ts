/**
 * 启发式纯函数单测（M1-AI1）：关键词估值 / 单位价值 / 全局评估 / 直伤估计与斩杀检测。
 * 只构造 PlayerView 夹具与合法 Action，不经引擎——纯函数行为逐点断言。
 */

import { beforeAll, describe, expect, test } from 'vitest'
import type { Action, BoardUnit, PlayerView, SelfPlayerState } from '@siliconcard/core'
import { registerAiCardPool } from './cardPool'
import { KEYWORD_SCORE, evaluateView, keywordBonus, unitScore } from './evaluate'
import {
  actionFaceDamage,
  estimateAvailableFaceDamage,
  isLethalAvailable,
  lethalCandidateActions,
} from './lethal'

beforeAll(() => registerAiCardPool())

// —— 夹具 ——

function unit(over: Partial<BoardUnit> & { instanceId: string; ownerId: 'P1' | 'P2' }): BoardUnit {
  return {
    cardId: 'ai-brick',
    attack: 3,
    health: 3,
    maxHealth: 3,
    keywords: [],
    summonedOnTurn: 1,
    attacksRemaining: 1,
    attackedThisTurn: false,
    ...over,
  }
}

function side(id: 'P1' | 'P2', over: Partial<SelfPlayerState> = {}): SelfPlayerState {
  const hand = over.hand ?? []
  return {
    id,
    faction: 'nvidia',
    heroName: `cpu-${id}`,
    health: 30,
    maxHealth: 30,
    armor: 0,
    mana: 0,
    maxMana: 400,
    handSize: hand.length,
    deckSize: 20,
    graveyardSize: 0,
    fatigue: 0,
    heroPowerUsed: false,
    hand: [],
    ...over,
  }
}

function view(over: {
  you?: Partial<SelfPlayerState>
  opponent?: Partial<SelfPlayerState>
  board?: BoardUnit[]
  activePlayer?: 'P1' | 'P2'
  phase?: 'main' | 'ended'
} = {}): PlayerView {
  return {
    viewer: 'P1',
    turn: 5,
    phase: over.phase ?? 'main',
    activePlayer: over.activePlayer ?? 'P1',
    winner: null,
    you: side('P1', over.you),
    opponent: side('P2', over.opponent),
    board: over.board ?? [],
  }
}

// —— 关键词与单位价值 ——

describe('keywordBonus / unitScore', () => {
  test('空关键词无加成', () => {
    expect(keywordBonus([])).toBe(0)
  })

  test('正负面关键词按表计分（overload 为负）', () => {
    expect(KEYWORD_SCORE['overload']).toBeLessThan(0)
    expect(keywordBonus(['taunt'])).toBe(1)
    expect(keywordBonus(['divine_shield', 'charge'])).toBe(3)
    expect(keywordBonus(['windfury', 'taunt', 'overload'])).toBe(2)
  })

  test('单位价值 = 攻 + 当前血 + 关键词加成，残血贬值', () => {
    expect(unitScore(unit({ instanceId: 'u1', ownerId: 'P1', attack: 3, health: 2 }))).toBe(5)
    expect(
      unitScore(unit({ instanceId: 'u2', ownerId: 'P1', attack: 2, health: 2, keywords: ['divine_shield'] })),
    ).toBe(6)
  })
})

// —— 全局评估 ——

describe('evaluateView', () => {
  test('完全对称的局面为 0 分（无未耗功耗）', () => {
    const mirrored = [
      unit({ instanceId: 'm1', ownerId: 'P1' }),
      unit({ instanceId: 'm2', ownerId: 'P2' }),
    ]
    expect(evaluateView(view({ board: mirrored }))).toBe(0)
  })

  test('CPU 体质差与护甲计入', () => {
    expect(evaluateView(view({ opponent: { health: 25 } }))).toBe(5)
    expect(evaluateView(view({ you: { armor: 3 } }))).toBe(3)
  })

  test('场面价值差：我方 3/3 对敌方 2/2 → +2', () => {
    const board = [
      unit({ instanceId: 'a', ownerId: 'P1', attack: 3, health: 3 }),
      unit({ instanceId: 'b', ownerId: 'P2', attack: 2, health: 2 }),
    ]
    expect(evaluateView(view({ board }))).toBe(2)
  })

  test('未耗功耗惩罚只对当前行动方生效（曲线填充驱动）', () => {
    const withMana = view({ you: { mana: 400 } })
    const oppTurn = view({ you: { mana: 400 }, activePlayer: 'P2' })
    expect(evaluateView(withMana)).toBe(-1.6)
    expect(evaluateView(oppTurn)).toBe(0)
  })

  test('手牌差与疲劳差计入', () => {
    expect(evaluateView(view({ you: { hand: [], handSize: 0 }, opponent: { handSize: 3 } }))).toBeCloseTo(-1.2)
    expect(evaluateView(view({ opponent: { fatigue: 2 } }))).toBe(6)
  })
})

// —— 直伤估计与斩杀检测 ——

describe('actionFaceDamage / estimateAvailableFaceDamage / isLethalAvailable', () => {
  const zap = { uid: 'h1', cardId: 'ai-zap', cost: 100 }
  const fireball = { uid: 'h2', cardId: 'ai-fireball', cost: 400 }
  const draw = { uid: 'h3', cardId: 'ai-driver-update', cost: 300 }

  test('攻击打脸计攻击力，攻击单位为 0', () => {
    const v = view({ board: [unit({ instanceId: 'm1', ownerId: 'P1', attack: 5 })] })
    expect(
      actionFaceDamage({ type: 'ATTACK', playerId: 'P1', attackerId: 'm1', target: { kind: 'hero', playerId: 'P2' } }, v),
    ).toBe(5)
    expect(
      actionFaceDamage({ type: 'ATTACK', playerId: 'P1', attackerId: 'm1', target: { kind: 'unit', instanceId: 'x' } }, v),
    ).toBe(0)
  })

  test('手牌直伤按卡面步骤估计，非直伤牌为 0', () => {
    const v = view({ you: { hand: [zap, fireball, draw] } })
    expect(
      actionFaceDamage({ type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'hero', playerId: 'P2' } }, v),
    ).toBe(4)
    expect(
      actionFaceDamage({ type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' }, v),
    ).toBe(1)
    expect(
      actionFaceDamage({ type: 'PLAY_CARD', playerId: 'P1', uid: 'h3' }, v),
    ).toBe(0)
  })

  test('派系技能：nvidia DLSS 非直伤；amd 光追按 70% 估计；手牌同 uid 多目标去重', () => {
    const amdView = view({ you: { faction: 'amd', hand: [fireball] } })
    expect(
      actionFaceDamage({ type: 'USE_HERO_POWER', playerId: 'P1', target: { kind: 'hero', playerId: 'P2' } }, amdView),
    ).toBeCloseTo(0.7)
    expect(
      actionFaceDamage({ type: 'USE_HERO_POWER', playerId: 'P1', target: { kind: 'unit', instanceId: 'x' } }, amdView),
    ).toBe(0)

    const v = view({ you: { hand: [fireball, fireball, fireball] } })
    const legal: Action[] = [
      { type: 'END_TURN', playerId: 'P1' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'hero', playerId: 'P2' } },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'unit', instanceId: 'x' } },
    ]
    // 同 uid 多目标展开只计一次（估计的是「这张牌能打多少」，不是「这几个动作加起来」）
    expect(estimateAvailableFaceDamage(v, legal)).toBe(4)
  })

  test('双芯 GPU（windfury）两次打脸各计一次', () => {
    const v = view({
      board: [unit({ instanceId: 'w1', ownerId: 'P1', attack: 3, keywords: ['windfury'], attacksRemaining: 2 })],
    })
    const legal: Action[] = [
      { type: 'ATTACK', playerId: 'P1', attackerId: 'w1', target: { kind: 'hero', playerId: 'P2' } },
      { type: 'ATTACK', playerId: 'P1', attackerId: 'w1', target: { kind: 'hero', playerId: 'P2' } },
    ]
    expect(estimateAvailableFaceDamage(v, legal)).toBe(6)
  })

  test('斩杀线：打脸伤害 ≥ 对方血量 + 护甲', () => {
    const lethalView = view({ you: { hand: [fireball] }, opponent: { health: 4 } })
    const legal: Action[] = [
      { type: 'END_TURN', playerId: 'P1' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'hero', playerId: 'P2' } },
    ]
    expect(isLethalAvailable(lethalView, legal)).toBe(true)
    expect(lethalCandidateActions(lethalView, legal)).toHaveLength(1)

    const noLethal = view({ you: { hand: [fireball] }, opponent: { health: 5 } })
    expect(isLethalAvailable(noLethal, legal)).toBe(false)

    const armored = view({ you: { hand: [fireball] }, opponent: { health: 2, armor: 2 } })
    expect(isLethalAvailable(armored, legal)).toBe(true)
    const tooTanky = view({ you: { hand: [fireball] }, opponent: { health: 3, armor: 2 } })
    expect(isLethalAvailable(tooTanky, legal)).toBe(false)
  })

  test('对局已结束时不判定斩杀', () => {
    const ended = view({ phase: 'ended', opponent: { health: 0 } })
    expect(isLethalAvailable(ended, [])).toBe(false)
  })
})
