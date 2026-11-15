/**
 * 脚本对手解析单测（P2-EDU1 定向测试）—— 手工构建 GameState（纯数据，不依赖引擎对局），
 * 验证各行为档案的确定性编排与防御性跳过。卡牌定义经 core 注册表注入最小集合。
 */

import { describe, expect, it } from 'vitest'
import { registerCardDefinitions, type BoardUnit, type CardDefinition, type GameState, type HandCard, type Keyword, type PlayerState } from '@siliconcard/core'
import { resolveP2Turn } from '../scripted'
import type { P2Profile } from '../types'

const DEFS: readonly CardDefinition[] = [
  { id: 'intel-arc-a380', name: 'A380', faction: 'intel', type: 'gpu', cost: 100, attack: 2, health: 3 },
  { id: 'amd-rx-550', name: 'RX 550', faction: 'amd', type: 'gpu', cost: 50, attack: 2, health: 2 },
  { id: 'intel-i9-9900k', name: '9900K', faction: 'intel', type: 'gpu', cost: 100, attack: 2, health: 6 },
  { id: 'apple-macbook-air-m2', name: 'Air M2', faction: 'apple', type: 'gpu', cost: 100, attack: 2, health: 3 },
  { id: 'neutral-g502-hero', name: 'G502', faction: 'neutral', type: 'gpu', cost: 200, attack: 4, health: 2 },
  { id: 'arm-dimensity-9300', name: '天玑', faction: 'arm', type: 'gpu', cost: 150, attack: 4, health: 4 },
]
registerCardDefinitions(DEFS)

const unit = (
  instanceId: string,
  cardId: string,
  ownerId: 'P1' | 'P2',
  keywords: Keyword[] = [],
  attacksRemaining = 1,
): BoardUnit => ({
  instanceId,
  cardId,
  ownerId,
  attack: 2,
  health: 2,
  maxHealth: 2,
  keywords,
  summonedOnTurn: 1,
  attacksRemaining,
  attackedThisTurn: false,
})

function player(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    id: 'P2',
    faction: 'neutral',
    heroName: '教学靶机',
    health: 30,
    maxHealth: 30,
    armor: 0,
    mana: 100,
    maxMana: 100,
    lockedMana: 0,
    deck: [],
    hand: [],
    graveyard: [],
    fatigue: 0,
    heroPowerUsed: false,
    ...overrides,
  }
}

function boardState(p2Hand: readonly HandCard[], p2Mana = 100, board: readonly ReturnType<typeof unit>[] = []): GameState {
  return {
    turn: 4,
    activePlayer: 'P2',
    phase: 'main',
    players: {
      P1: player({ id: 'P1', mana: 200, maxMana: 200, hand: [hand('h9', 'amd-rx-550', 50)] }),
      P2: player({ hand: p2Hand, mana: p2Mana }),
    },
    board,
    nextInstanceId: 20,
    rng: { state: 42 },
    winner: null,
    endReason: null,
  }
}

const hand = (uid: string, cardId: string, cost: number): HandCard => ({ uid, cardId, cost })

describe('passer：永远只结束回合', () => {
  it('空场也只收工', () => {
    const actions = resolveP2Turn({ kind: 'passer' }, boardState([]))
    expect(actions).toEqual([{ type: 'END_TURN', playerId: 'P2' }])
  })
})

describe('spawner：没单位就投放靶子', () => {
  const profile: P2Profile = { kind: 'spawner', cardId: 'intel-arc-a380' }

  it('在手且付得起 → 出牌 + 收工', () => {
    const actions = resolveP2Turn(profile, boardState([hand('h1', 'intel-arc-a380', 100)]))
    expect(actions).toEqual([
      { type: 'PLAY_CARD', playerId: 'P2', uid: 'h1' },
      { type: 'END_TURN', playerId: 'P2' },
    ])
  })

  it('付不起电 → 防御性跳过，只收工', () => {
    const actions = resolveP2Turn(profile, boardState([hand('h1', 'intel-arc-a380', 100)], 50))
    expect(actions).toEqual([{ type: 'END_TURN', playerId: 'P2' }])
  })

  it('不在手 → 只收工（等抽到，教学流程自愈）', () => {
    const actions = resolveP2Turn(profile, boardState([hand('h1', 'amd-rx-550', 50)]))
    expect(actions).toEqual([{ type: 'END_TURN', playerId: 'P2' }])
  })

  it('场上已有单位 → 不重复投放', () => {
    const actions = resolveP2Turn(profile, boardState([hand('h1', 'intel-arc-a380', 100)], 100, [unit('e1', 'intel-arc-a380', 'P2')]))
    expect(actions).toEqual([{ type: 'END_TURN', playerId: 'P2' }])
  })
})

describe('aggressive：投放 + 通用目标优先级', () => {
  const profile: P2Profile = { kind: 'aggressive', cardId: 'intel-arc-a380' }

  it('已有单位 → 直接攻击（嘲讽优先）', () => {
    const state = boardState([], 100, [
      unit('taunt1', 'intel-i9-9900k', 'P1', ['taunt']),
      unit('mine1', 'amd-rx-550', 'P1'),
      unit('atk1', 'intel-arc-a380', 'P2'),
    ])
    const actions = resolveP2Turn(profile, state)
    expect(actions).toEqual([
      { type: 'ATTACK', playerId: 'P2', attackerId: 'atk1', target: { kind: 'unit', instanceId: 'taunt1' } },
      { type: 'END_TURN', playerId: 'P2' },
    ])
  })

  it('对面只有潜行单位 → 打 CPU（潜行不可被指定）', () => {
    const state = boardState([], 100, [
      unit('air1', 'apple-macbook-air-m2', 'P1', ['stealth']),
      unit('atk1', 'intel-arc-a380', 'P2'),
    ])
    const actions = resolveP2Turn(profile, state)
    expect(actions[0]).toEqual({
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'atk1',
      target: { kind: 'hero', playerId: 'P1' },
    })
  })

  it('质保单位优先于裸单位（shieldDemo 之外的通用规则）', () => {
    const state = boardState([], 100, [
      unit('bare1', 'amd-rx-550', 'P1'),
      unit('shielded1', 'amd-rx-550', 'P1', ['divine_shield']),
      unit('atk1', 'intel-arc-a380', 'P2'),
    ])
    const actions = resolveP2Turn(profile, state)
    expect(actions[0]).toMatchObject({ target: { kind: 'unit', instanceId: 'shielded1' } })
  })
})

describe('shieldDemo：只在对方亮质保时才动刀', () => {
  const profile: P2Profile = { kind: 'shieldDemo', cardId: 'intel-arc-a380' }

  it('有质保单位 → 攻击它', () => {
    const state = boardState([], 100, [
      unit('shielded1', 'amd-rx-550', 'P1', ['divine_shield']),
      unit('atk1', 'intel-arc-a380', 'P2'),
    ])
    const actions = resolveP2Turn(profile, state)
    expect(actions).toEqual([
      { type: 'ATTACK', playerId: 'P2', attackerId: 'atk1', target: { kind: 'unit', instanceId: 'shielded1' } },
      { type: 'END_TURN', playerId: 'P2' },
    ])
  })

  it('没质保单位 → 收工观望（等玩家上质保，教学节拍）', () => {
    const state = boardState([], 100, [unit('bare1', 'amd-rx-550', 'P1'), unit('atk1', 'intel-arc-a380', 'P2')])
    expect(resolveP2Turn(profile, state)).toEqual([{ type: 'END_TURN', playerId: 'P2' }])
  })
})

describe('sparring：L4 陪练（确定性出牌 + 通用攻击）', () => {
  const profile: P2Profile = { kind: 'sparring' }

  it('最便宜两张优先，计划内功耗不超支（250W：100 + 150）', () => {
    const state = boardState([
      hand('h-exp', 'neutral-g502-hero', 200),
      hand('h-mid', 'arm-dimensity-9300', 150),
      hand('h-cheap', 'amd-rx-550', 50),
    ], 250)
    const actions = resolveP2Turn(profile, state)
    const plays = actions.filter((action) => action.type === 'PLAY_CARD')
    expect(plays).toHaveLength(2)
    const playedCosts = (plays as Extract<typeof actions[number], { type: 'PLAY_CARD' }>[])
      .map((play) => (play as { uid: string }).uid)
      .map((uid) => state.players.P2.hand.find((card) => card.uid === uid)?.cost)
    expect(playedCosts.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([50, 150])
    expect(actions.at(-1)).toEqual({ type: 'END_TURN', playerId: 'P2' })
  })

  it('场上单位攻击：换血优先打最脆皮', () => {
    const state = boardState([], 100, [
      unit('weak1', 'amd-rx-550', 'P1', [], 0),
      unit('atk1', 'intel-arc-a380', 'P2'),
    ])
    const actions = resolveP2Turn(profile, state)
    // 对面唯一单位剩 0 次攻击预算？不——weak1 是 P1 的单位；攻击目标 = 对方单位（无嘲讽/质保）→ 最脆皮
    expect(actions.some((action) => action.type === 'ATTACK')).toBe(true)
    expect(actions.at(-1)).toEqual({ type: 'END_TURN', playerId: 'P2' })
  })

  it('0 攻击预算的己方单位不攻击', () => {
    const state = boardState([], 100, [unit('atk1', 'intel-arc-a380', 'P2', [], 0)])
    const actions = resolveP2Turn(profile, state)
    expect(actions.every((action) => action.type !== 'ATTACK')).toBe(true)
  })
})
