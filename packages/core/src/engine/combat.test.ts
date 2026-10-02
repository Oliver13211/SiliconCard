/**
 * M1-ENG3 攻击结算单测：合法性拒绝（各错误码路径）、taunt（信仰充值）拦截与
 * taunt×stealth 冲突、双向伤害数值、三年质保消耗（双方侧）、潜行现身、
 * 双芯 GPU 攻击次数、超频召唤失调豁免、攻击 accessory 与光环回收、
 * 攻击致死与同时归零平局、getLegalActions ATTACK 枚举、确定性。
 * 规则依据：docs/rules.md §2.4 / §3 / §6 / §7 / §9。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { TargetRef } from '../types/actions'
import type { BoardUnit, DeckEntry, GameState, HandCard, PlayerId, PlayerState } from '../types/state'
import { catchRuleError, makeGameState, makePlayer, makeSetup, makeUnit, TEST_SEED } from '../testing/state'
import { stableHash } from '../testing/hash'
import type { Action } from '../types/actions'
import { applyAction, getLegalActions } from './apply'
import type { AttackAction } from './combat'
import { initGame } from './init'
import { registerCardDefinitions } from './registry'

// —— 测试卡池（vitest 文件间注册表隔离）——
const CARDS: CardDefinition[] = [
  { id: 'c-vanilla', name: '白板显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 2 },
  { id: 'c-charged', name: '超频核心', faction: 'neutral', type: 'gpu', cost: 200, attack: 3, health: 1, keywords: ['charge'] },
  { id: 'c-dual', name: '双芯超频', faction: 'neutral', type: 'gpu', cost: 200, attack: 2, health: 2, keywords: ['charge', 'windfury'] },
  { id: 'c-zero', name: '零输出卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 4 },
  { id: 'c-buff', name: '驱动小补丁', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'chosen', pool: 'ownUnits' }, attack: 2 }] } },
  { id: 'c-aura-atk', name: '信仰灯条', faction: 'neutral', type: 'accessory', cost: 100,
    effect: { trigger: 'battlecry', aura: { stat: 'attack', delta: 1, scope: 'ownUnits' } } },
]
registerCardDefinitions(CARDS)

// —— 构造工具 ——

const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })
const heroRef = (playerId: 'P1' | 'P2'): TargetRef => ({ kind: 'hero', playerId })
const atk = (attackerId: string, target: TargetRef, playerId: PlayerId = 'P1'): AttackAction => ({
  type: 'ATTACK',
  playerId,
  attackerId,
  target,
})
const endTurn = (playerId: 'P1' | 'P2'): Action => ({ type: 'END_TURN', playerId })
const eventsOf = (events: readonly GameEvent[]): string[] => events.map((e) => e.type)
const hc = (uid: string, cardId: string, cost = 100): HandCard => ({ uid, cardId, cost })

interface AttackStateOptions {
  turn?: number
  activePlayer?: PlayerId
  board?: BoardUnit[]
  enemyBoard?: BoardUnit[]
  p1?: Partial<PlayerState>
  p2?: Partial<PlayerState>
}

/** 合成状态：turn 默认 3、P1 行动；单位默认 summonedOnTurn=1（非入场回合）、attacksRemaining=1（就绪） */
function attackState(opts: AttackStateOptions = {}): GameState {
  return makeGameState({
    turn: opts.turn ?? 3,
    activePlayer: opts.activePlayer ?? 'P1',
    players: {
      // 牌库各留 1 张，避免 END_TURN 链路测试混入疲劳伤害
      P1: { ...makePlayer('P1'), deck: [{ cardId: 'smoke-gpu' }] as DeckEntry[], ...(opts.p1 ?? {}) },
      P2: { ...makePlayer('P2'), deck: [{ cardId: 'smoke-gpu' }] as DeckEntry[], ...(opts.p2 ?? {}) },
    },
    board: [...(opts.board ?? []), ...(opts.enemyBoard ?? [])],
  })
}

interface RealStateOptions {
  hand?: HandCard[]
  mana?: number
  board?: BoardUnit[]
  enemyBoard?: BoardUnit[]
  turn?: number
}

/** 真实出牌链路用状态：手牌 + 供电 + 少量牌库（避免疲劳），turn 默认 3 */
function realState(opts: RealStateOptions = {}): GameState {
  return makeGameState({
    turn: opts.turn ?? 3,
    activePlayer: 'P1',
    players: {
      P1: {
        ...makePlayer('P1'),
        hand: opts.hand ?? [],
        mana: opts.mana ?? 500,
        maxMana: 500,
        deck: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
      },
      P2: {
        ...makePlayer('P2'),
        deck: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
      },
    },
    board: [...(opts.board ?? []), ...(opts.enemyBoard ?? [])],
  })
}

function advanceOneRound(state: GameState): GameState {
  const first = applyAction(state, endTurn(state.activePlayer === 'P1' ? 'P1' : 'P2'))
  return applyAction(first.state, endTurn(first.state.activePlayer === 'P1' ? 'P1' : 'P2')).state
}

describe('ATTACK 合法性拒绝（rules.md §3）', () => {
  it('非行动方攻击 → NOT_YOUR_TURN', () => {
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })] })
    const error = catchRuleError(() => applyAction(state, atk('a1', heroRef('P2'), 'P2')))
    expect(error.code).toBe('NOT_YOUR_TURN')
    expect(error.detail).toMatchObject({ activePlayer: 'P1', playerId: 'P2' })
  })

  it('attacker 不在场上（幽灵 id）→ UNIT_NOT_ON_BOARD', () => {
    const state = attackState()
    const error = catchRuleError(() => applyAction(state, atk('ghost', heroRef('P2'))))
    expect(error.code).toBe('UNIT_NOT_ON_BOARD')
    expect(error.detail).toMatchObject({ attackerId: 'ghost' })
  })

  it('attacker 属于对手（不在"你的场上"）→ UNIT_NOT_ON_BOARD', () => {
    const state = attackState({ enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1' })] })
    const error = catchRuleError(() => applyAction(state, atk('e1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_NOT_ON_BOARD')
  })

  it('召唤失调（入场当回合、无 charge）→ UNIT_CANNOT_ATTACK{reason:summoning_sickness}', () => {
    const state = attackState({
      turn: 3,
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', summonedOnTurn: 3, attacksRemaining: 0 })],
    })
    const error = catchRuleError(() => applyAction(state, atk('a1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ attackerId: 'a1', reason: 'summoning_sickness' })
  })

  it('0 攻单位 → UNIT_CANNOT_ATTACK{reason:zero_attack}', () => {
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 0 })] })
    const error = catchRuleError(() => applyAction(state, atk('a1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'zero_attack' })
  })

  it('配件不可发起攻击（即使光环叠加出正攻击值）→ UNIT_CANNOT_ATTACK{reason:accessory_cannot_attack}', () => {
    const accessory = makeUnit({
      ownerId: 'P1', instanceId: 'acc', cardId: 'c-aura-atk',
      attack: 1, health: 1, maxHealth: 1, attacksRemaining: 0, // 光环后攻击值 > 0，但配件恒无攻击预算
    })
    const state = attackState({ board: [accessory] })
    const error = catchRuleError(() => applyAction(state, atk('acc', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'accessory_cannot_attack' })
  })

  it('攻击次数耗尽（attacksRemaining=0 且非召唤回合）→ UNIT_CANNOT_ATTACK{reason:no_attacks_remaining}', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', summonedOnTurn: 1, attacksRemaining: 0 })],
    })
    const error = catchRuleError(() => applyAction(state, atk('a1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'no_attacks_remaining' })
  })

  it('存在已现身 taunt 时攻击敌方 CPU → TAUNT_BLOCKING（detail 携带 taunt 列表）', () => {
    const taunt = makeUnit({ ownerId: 'P2', instanceId: 'e-t', keywords: ['taunt'] })
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })], enemyBoard: [taunt] })
    const error = catchRuleError(() => applyAction(state, atk('a1', heroRef('P2'))))
    expect(error.code).toBe('TAUNT_BLOCKING')
    expect(error.detail).toMatchObject({ taunts: [unitRef('e-t')], target: heroRef('P2') })
  })

  it('存在已现身 taunt 时攻击非 taunt 单位 → TAUNT_BLOCKING', () => {
    const taunt = makeUnit({ ownerId: 'P2', instanceId: 'e-t', keywords: ['taunt'] })
    const plain = makeUnit({ ownerId: 'P2', instanceId: 'e-p' })
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })], enemyBoard: [taunt, plain] })
    const error = catchRuleError(() => applyAction(state, atk('a1', unitRef('e-p'))))
    expect(error.code).toBe('TAUNT_BLOCKING')
  })

  it('攻击己方 CPU → INVALID_TARGET{reason:own_hero}', () => {
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })] })
    const error = catchRuleError(() => applyAction(state, atk('a1', heroRef('P1'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'own_hero' })
  })

  it('攻击己方单位 → INVALID_TARGET{reason:not_enemy_unit}', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' }), makeUnit({ ownerId: 'P1', instanceId: 'a2' })],
    })
    const error = catchRuleError(() => applyAction(state, atk('a1', unitRef('a2'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'not_enemy_unit' })
  })

  it('攻击目标不在场上（幽灵 id）→ INVALID_TARGET{reason:unit_not_on_board}', () => {
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })] })
    const error = catchRuleError(() => applyAction(state, atk('a1', unitRef('ghost'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'unit_not_on_board' })
  })

  it('攻击未现身潜行单位 → INVALID_TARGET{reason:stealth_hidden}；同场普通单位照常可攻', () => {
    const stealth = makeUnit({ ownerId: 'P2', instanceId: 'e-s', keywords: ['stealth'] })
    const plain = makeUnit({ ownerId: 'P2', instanceId: 'e-p' })
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })], enemyBoard: [stealth, plain] })
    const error = catchRuleError(() => applyAction(state, atk('a1', unitRef('e-s'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'stealth_hidden' })
    const ok = applyAction(state, atk('a1', unitRef('e-p')))
    expect(ok.state.board.some((u) => u.instanceId === 'e-p')).toBe(false)
  })

  it('对局结束后攻击 → GAME_ENDED', () => {
    const ended = applyAction(initGame(makeSetup()), { type: 'CONCEDE', playerId: 'P2' }).state
    const error = catchRuleError(() => applyAction(ended, atk('u1', heroRef('P2'))))
    expect(error.code).toBe('GAME_ENDED')
  })

  it('非法攻击抛错后原状态哈希不变（深拷贝隔离）', () => {
    const state = attackState({ enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e-t', keywords: ['taunt'] })] })
    const before = stableHash(state)
    expect(() => applyAction(state, atk('a1', heroRef('P2')))).toThrow()
    expect(stableHash(state)).toBe(before)
  })
})

describe('taunt（信仰充值）拦截与绕过（rules.md §7）', () => {
  it('多个 taunt 任选其一：攻击其中任意一个均合法', () => {
    const t1 = makeUnit({ ownerId: 'P2', instanceId: 'e-t1', attack: 1, health: 2, maxHealth: 2, keywords: ['taunt'] })
    const t2 = makeUnit({ ownerId: 'P2', instanceId: 'e-t2', attack: 1, health: 2, maxHealth: 2, keywords: ['taunt'] })
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [t1, t2],
    })
    const result = applyAction(state, atk('a1', unitRef('e-t2')))
    expect(result.state.board.some((u) => u.instanceId === 'e-t2')).toBe(false)
    expect(result.state.board.some((u) => u.instanceId === 'e-t1')).toBe(true)
  })

  it('击杀唯一 taunt 后（跨回合）即可绕过攻击 CPU', () => {
    const taunt = makeUnit({
      ownerId: 'P2', instanceId: 'e-t', attack: 2, health: 5, maxHealth: 5, keywords: ['taunt'],
    })
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 5, health: 6, maxHealth: 6 })],
      enemyBoard: [taunt],
    })
    const killed = applyAction(state, atk('a1', unitRef('e-t')))
    expect(killed.state.players.P2.graveyard).toEqual([{ instanceId: 'e-t', cardId: 'test-gpu' }])
    expect(killed.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 4 }) // 反击 2

    const nextRound = advanceOneRound(killed.state)
    const through = applyAction(nextRound, atk('a1', heroRef('P2')))
    expect(through.state.players.P2.health).toBe(25) // 30 - 5
  })

  it('taunt×stealth 冲突：唯一 taunt 未现身 → taunt 无效（可攻 CPU），且其自身不可被攻击', () => {
    const hiddenTaunt = makeUnit({
      ownerId: 'P2', instanceId: 'e-ht', attack: 1, health: 2, maxHealth: 2, keywords: ['taunt', 'stealth'],
    })
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })], enemyBoard: [hiddenTaunt] })
    const through = applyAction(state, atk('a1', heroRef('P2')))
    expect(through.state.players.P2.health).toBe(29)

    const error = catchRuleError(() => applyAction(state, atk('a1', unitRef('e-ht'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'stealth_hidden' })
  })

  it('taunt×stealth 冲突：另有已现身 taunt 时照常拦截；未现身 taunt 不可作为目标（TAUNT_BLOCKING）', () => {
    const hiddenTaunt = makeUnit({ ownerId: 'P2', instanceId: 'e-ht', keywords: ['taunt', 'stealth'] })
    const visibleTaunt = makeUnit({ ownerId: 'P2', instanceId: 'e-vt', keywords: ['taunt'] })
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })], enemyBoard: [hiddenTaunt, visibleTaunt] })
    expect(catchRuleError(() => applyAction(state, atk('a1', heroRef('P2')))).code).toBe('TAUNT_BLOCKING')
    expect(catchRuleError(() => applyAction(state, atk('a1', unitRef('e-ht')))).code).toBe('TAUNT_BLOCKING')
    const ok = applyAction(state, atk('a1', unitRef('e-vt')))
    expect(eventsOf(ok.events)).toContain('ATTACK_DECLARED')
  })

  it('敌方潜行（非 taunt）单位不拦截攻击；未现身者不可被指定', () => {
    const stealth = makeUnit({ ownerId: 'P2', instanceId: 'e-s', keywords: ['stealth'] })
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })], enemyBoard: [stealth] })
    const through = applyAction(state, atk('a1', heroRef('P2')))
    expect(through.state.players.P2.health).toBe(29)
    expect(catchRuleError(() => applyAction(state, atk('a1', unitRef('e-s')))).code).toBe('INVALID_TARGET')
  })
})

describe('双向伤害结算（rules.md §6 / §7）', () => {
  it('基础交换：3/2 攻击 2/2 → 同时结算、双双阵亡、各入墓地', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 2, maxHealth: 2 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 2, health: 2, maxHealth: 2 })],
    })
    const result = applyAction(state, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual([
      'ATTACK_DECLARED',
      'DAMAGE_DEALT', // a1 → e1
      'MINION_DIED', // e1
      'DAMAGE_DEALT', // e1 → a1（同时结算：反击照常）
      'MINION_DIED', // a1
    ])
    expect(result.events[0]).toEqual({ type: 'ATTACK_DECLARED', attackerId: 'a1', target: unitRef('e1') })
    expect(result.events[1]).toMatchObject({
      source: { kind: 'unit', instanceId: 'a1' },
      target: unitRef('e1'),
      amount: 3,
      remainingHealth: 0,
    })
    expect(result.events[3]).toMatchObject({
      source: { kind: 'unit', instanceId: 'e1' },
      target: unitRef('a1'),
      amount: 2,
      remainingHealth: 0,
    })
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P1.graveyard).toEqual([{ instanceId: 'a1', cardId: 'test-gpu' }])
    expect(result.state.players.P2.graveyard).toEqual([{ instanceId: 'e1', cardId: 'test-gpu' }])
  })

  it('部分交换：3/2 攻击 2/5 → 防守方剩 2 血，攻击者被反击致死', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 2, maxHealth: 2 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 2, health: 5, maxHealth: 5 })],
    })
    const result = applyAction(state, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'DAMAGE_DEALT', 'MINION_DIED'])
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ health: 2 })
    expect(result.state.players.P1.graveyard).toHaveLength(1)
  })

  it('攻击 CPU 无反击；护甲先于体质（armorAbsorbed 载荷）', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3 })],
      p2: { armor: 5 },
    })
    const result = applyAction(state, atk('a1', heroRef('P2')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT'])
    expect(result.events[1]).toMatchObject({
      source: { kind: 'unit', instanceId: 'a1' },
      target: heroRef('P2'),
      amount: 3,
      remainingHealth: 30,
      armorAbsorbed: 3,
    })
    expect(result.state.players.P2).toMatchObject({ armor: 2, health: 30 })
  })

  it('攻击 CPU 无护甲时直接扣体质，DAMAGE_DEALT 不带 armorAbsorbed', () => {
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3 })] })
    const result = applyAction(state, atk('a1', heroRef('P2')))
    expect(result.state.players.P2.health).toBe(27)
    expect('armorAbsorbed' in (result.events[1] as object)).toBe(false)
  })

  it('防守方三年质保：消耗并置 shieldConsumed，防守方无伤且照常反击', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 's1', attack: 2, health: 3, maxHealth: 3, keywords: ['divine_shield'] }),
      ],
    })
    const result = applyAction(state, atk('a1', unitRef('s1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'KEYWORD_TRIGGERED', 'DAMAGE_DEALT'])
    expect(result.events[1]).toMatchObject({ target: unitRef('s1'), amount: 3, remainingHealth: 3, shieldConsumed: true })
    expect(result.events[2]).toMatchObject({ keyword: 'divine_shield', instanceId: 's1' })
    expect(result.events[3]).toMatchObject({ source: { kind: 'unit', instanceId: 's1' }, target: unitRef('a1'), amount: 2 })
    const board = result.state.board
    expect(board.find((u) => u.instanceId === 's1')).toMatchObject({ health: 3, keywords: [] }) // 质保消失
    expect(board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 1 })
  })

  it('攻击者三年质保：反击触发消耗，攻击者无伤', () => {
    const state = attackState({
      board: [
        makeUnit({
          ownerId: 'P1', instanceId: 'a1', attack: 3, health: 2, maxHealth: 2, keywords: ['divine_shield'],
        }),
      ],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 2, health: 5, maxHealth: 5 })],
    })
    const result = applyAction(state, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'DAMAGE_DEALT', 'KEYWORD_TRIGGERED'])
    expect(result.events[2]).toMatchObject({ target: unitRef('a1'), amount: 2, remainingHealth: 2, shieldConsumed: true })
    expect(result.events[3]).toMatchObject({ keyword: 'divine_shield', instanceId: 'a1' })
    expect(result.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 2, keywords: [] })
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ health: 2 })
  })

  it('同时结算：防守方被先手伤害击杀仍以宣告时快照反击（双双阵亡）', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 1, maxHealth: 1 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 4, health: 1, maxHealth: 1 })],
    })
    const result = applyAction(state, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual([
      'ATTACK_DECLARED',
      'DAMAGE_DEALT',
      'MINION_DIED', // e1 先倒
      'DAMAGE_DEALT', // e1 快照反击 4 点仍结算
      'MINION_DIED', // a1 随后倒下
    ])
    expect(result.events[3]).toMatchObject({ source: { kind: 'unit', instanceId: 'e1' }, amount: 4 })
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P1.graveyard).toHaveLength(1)
    expect(result.state.players.P2.graveyard).toHaveLength(1)
  })

  it('0 攻防守方不反击：交换只有一次 DAMAGE_DEALT，攻击者无伤', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 1, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 0, health: 5, maxHealth: 5 })],
    })
    const result = applyAction(state, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT'])
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ health: 4 })
    expect(result.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 3 })
  })

  it('击杀 accessory（0 攻不反击）：受击、死亡、墓地照常', () => {
    const accessory = makeUnit({
      ownerId: 'P2', instanceId: 'acc', cardId: 'c-aura-atk', attack: 0, health: 1, maxHealth: 1,
    })
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 1, health: 3, maxHealth: 3 })], enemyBoard: [accessory] })
    const result = applyAction(state, atk('a1', unitRef('acc')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'MINION_DIED'])
    expect(result.events[2]).toMatchObject({ cause: 'damage', unit: { instanceId: 'acc', cardId: 'c-aura-atk' } })
    expect(result.state.players.P2.graveyard).toEqual([{ instanceId: 'acc', cardId: 'c-aura-atk' }])
    expect(result.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 3 })
  })

  it('攻击致死 aura 源 accessory：光环随之回收（存活单位攻击回落）', () => {
    // 合成场上光环已投影：灯条自身 0+1=1 攻，己方单位 2+1=3 攻
    const accessory = makeUnit({
      ownerId: 'P2', instanceId: 'acc', cardId: 'c-aura-atk', attack: 1, health: 1, maxHealth: 1,
    })
    const boosted = makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 3, health: 2, maxHealth: 2 })
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 1, health: 5, maxHealth: 5 })],
      enemyBoard: [accessory, boosted],
    })
    const result = applyAction(state, atk('a1', unitRef('acc')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'MINION_DIED', 'DAMAGE_DEALT'])
    // 宣告时灯条（含自身光环）攻击 1 → 反击 1 点
    expect(result.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 4 })
    // 光环回收：3 - 1 = 2（基础 2 + 永久 buff 0）
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ attack: 2 })
    expect(result.state.players.P2.graveyard).toEqual([{ instanceId: 'acc', cardId: 'c-aura-atk' }])
  })
})

describe('攻击次数与召唤失调（rules.md §7）', () => {
  it('攻击后 attacksRemaining -1、attackedThisTurn = true；预算用尽即拒绝', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 2, health: 3, maxHealth: 3, attacksRemaining: 2 })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 1, health: 1, maxHealth: 1 }),
        makeUnit({ ownerId: 'P2', instanceId: 'e2', attack: 1, health: 1, maxHealth: 1 }),
      ],
    })
    const first = applyAction(state, atk('a1', unitRef('e1')))
    expect(first.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({
      attacksRemaining: 1,
      attackedThisTurn: true,
      health: 2, // 反击 1
    })
    const second = applyAction(first.state, atk('a1', unitRef('e2')))
    expect(second.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({
      attacksRemaining: 0,
      attackedThisTurn: true,
    })
    const error = catchRuleError(() => applyAction(second.state, atk('a1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'no_attacks_remaining' })
  })

  it('双芯 GPU（windfury）：每回合两次攻击，第三次拒绝', () => {
    const state = attackState({
      board: [
        makeUnit({
          ownerId: 'P1', instanceId: 'wf', attack: 2, health: 5, maxHealth: 5, keywords: ['windfury'], attacksRemaining: 2,
        }),
      ],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 1, health: 2, maxHealth: 2 }),
        makeUnit({ ownerId: 'P2', instanceId: 'e2', attack: 1, health: 2, maxHealth: 2 }),
      ],
    })
    const first = applyAction(state, atk('wf', unitRef('e1')))
    expect(first.state.board.some((u) => u.instanceId === 'e1')).toBe(false) // 2 伤击杀
    const second = applyAction(first.state, atk('wf', unitRef('e2')))
    expect(second.state.board.some((u) => u.instanceId === 'e2')).toBe(false)
    expect(second.state.board.find((u) => u.instanceId === 'wf')).toMatchObject({ attacksRemaining: 0 })
    const error = catchRuleError(() => applyAction(second.state, atk('wf', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
  })

  it('真实出牌链路：入场当回合不可攻击（召唤失调）→ 跨回合后恢复', () => {
    const state = realState({ hand: [hc('h1', 'c-vanilla')] })
    const played = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(played.state.board[0]).toMatchObject({ instanceId: 'u1', attacksRemaining: 0 })
    const error = catchRuleError(() => applyAction(played.state, atk('u1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'summoning_sickness' })

    const nextRound = advanceOneRound(played.state)
    const ok = applyAction(nextRound, atk('u1', heroRef('P2')))
    expect(ok.state.players.P2.health).toBe(27)
  })

  it('超频（charge）：入场当回合即可攻击；攻击后预算归零、再攻拒绝', () => {
    const state = realState({ hand: [hc('h1', 'c-charged')] })
    const played = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(played.state.board[0]).toMatchObject({ instanceId: 'u1', attacksRemaining: 0, keywords: ['charge'] })
    const attacked = applyAction(played.state, atk('u1', heroRef('P2')))
    expect(attacked.state.players.P2.health).toBe(27)
    expect(attacked.state.board.find((u) => u.instanceId === 'u1')).toMatchObject({
      attacksRemaining: 0,
      attackedThisTurn: true,
    })
    const error = catchRuleError(() => applyAction(attacked.state, atk('u1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'no_attacks_remaining' })
  })

  it('charge × windfury：召唤回合可攻击两次（叠加无冲突，§7）', () => {
    const state = realState({
      hand: [hc('h1', 'c-dual')],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 1, health: 1, maxHealth: 1 })],
    })
    const played = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const first = applyAction(played.state, atk('u1', unitRef('e1')))
    // 预算授予 2 → 首攻后 1
    expect(first.state.board.find((u) => u.instanceId === 'u1')).toMatchObject({ attacksRemaining: 1, health: 1 })
    const second = applyAction(first.state, atk('u1', heroRef('P2')))
    expect(second.state.players.P2.health).toBe(28)
    expect(second.state.board.find((u) => u.instanceId === 'u1')).toMatchObject({ attacksRemaining: 0 })
    const error = catchRuleError(() => applyAction(second.state, atk('u1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
  })

  it('0 攻单位回合开始预算为 0（ENG1 语义）；当回合 buff 出攻击力也不可得预算，下回合恢复', () => {
    const state = realState({ hand: [hc('h1', 'c-zero'), hc('h2', 'c-buff')] })
    const played = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const nextRound = advanceOneRound(played.state)
    expect(nextRound.board[0]).toMatchObject({ attack: 0, attacksRemaining: 0 })

    // 当回合 buff 出 2 攻：预算不补发（回合开始定预算）
    const buffed = applyAction(nextRound, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: unitRef('u1') })
    expect(buffed.state.board[0]).toMatchObject({ attack: 2, attacksRemaining: 0 })
    const error = catchRuleError(() => applyAction(buffed.state, atk('u1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'no_attacks_remaining' })

    // 下回合：攻击力 > 0 → 预算 1，可攻击
    const following = advanceOneRound(buffed.state)
    expect(following.board[0]).toMatchObject({ attack: 2, attacksRemaining: 1 })
    const ok = applyAction(following, atk('u1', heroRef('P2')))
    expect(ok.state.players.P2.health).toBe(28)
  })
})

describe('潜行（无输出亮机）攻击现身（rules.md §7）', () => {
  it('潜行单位攻击后立即现身：关键词移除 + KEYWORD_TRIGGERED，下回合可被敌方攻击', () => {
    const state = attackState({
      board: [
        makeUnit({
          ownerId: 'P1', instanceId: 's1', attack: 2, health: 2, maxHealth: 2, keywords: ['stealth'],
        }),
      ],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 1, health: 3, maxHealth: 3 })],
    })
    const result = applyAction(state, atk('s1', unitRef('e1')))
    expect(result.state.board.find((u) => u.instanceId === 's1')?.keywords).toEqual([])
    expect(result.events).toContainEqual({
      type: 'KEYWORD_TRIGGERED',
      keyword: 'stealth',
      instanceId: 's1',
      detail: '攻击后现身（无输出亮机解除）',
    })

    // 现身后敌方回合可指定它攻击
    const next = applyAction(result.state, endTurn('P1'))
    const p2Attacks = getLegalActions(next.state, 'P2').filter(
      (a): a is AttackAction => a.type === 'ATTACK',
    )
    expect(p2Attacks).toContainEqual({ type: 'ATTACK', playerId: 'P2', attackerId: 'e1', target: unitRef('s1') })
  })

  it('潜行攻击者被反击致死：不发现身事件（阵亡快照保留 stealth）', () => {
    const state = attackState({
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 's1', attack: 1, health: 1, maxHealth: 1, keywords: ['stealth'] }),
      ],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 5, health: 5, maxHealth: 5 })],
    })
    const result = applyAction(state, atk('s1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'DAMAGE_DEALT', 'MINION_DIED'])
    expect(result.events.some((e) => e.type === 'KEYWORD_TRIGGERED')).toBe(false)
    const died = result.events.find((e) => e.type === 'MINION_DIED')
    expect(died).toMatchObject({ unit: { instanceId: 's1', keywords: ['stealth'] } })
  })

  it('潜行单位攻击 CPU：无反击，现身照常', () => {
    const state = attackState({
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 's1', attack: 2, health: 2, maxHealth: 2, keywords: ['stealth'] }),
      ],
    })
    const result = applyAction(state, atk('s1', heroRef('P2')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'KEYWORD_TRIGGERED'])
    expect(result.state.players.P2.health).toBe(28)
    expect(result.state.board.find((u) => u.instanceId === 's1')?.keywords).toEqual([])
  })
})

describe('胜负与平局（rules.md §9）', () => {
  it('攻击 CPU 致死 → GAME_END{health_zero}，行动方获胜，此后无合法动作', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3 })],
      p2: { health: 3 },
    })
    const result = applyAction(state, atk('a1', heroRef('P2')))
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBe('P1')
    expect(result.state.endReason).toBe('health_zero')
    expect(result.events.at(-1)).toEqual({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
    expect(getLegalActions(result.state, 'P1')).toEqual([])
    expect(getLegalActions(result.state, 'P2')).toEqual([])
  })

  it('双方 CPU 同时归零 → winner null（平局）', () => {
    // 合成场景：P1 体质已归零（phase 仍 main），P1 攻击击穿 P2 最后一点体质
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 1 })],
      p1: { health: 0 },
      p2: { health: 1 },
    })
    const result = applyAction(state, atk('a1', heroRef('P2')))
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBeNull()
    expect(result.state.endReason).toBe('health_zero')
    expect(result.events.at(-1)).toEqual({ type: 'GAME_END', winner: null, reason: 'health_zero' })
  })
})

describe('getLegalActions ATTACK 枚举（M1-ENG3 扩展）', () => {
  it('合法 attacker × 目标展开：board 序、CPU 末位；失调/0 攻/耗尽被过滤', () => {
    const state = attackState({
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 2, health: 2, maxHealth: 2 }), // 就绪
        makeUnit({
          ownerId: 'P1', instanceId: 'a2', attack: 2, health: 2, maxHealth: 2, summonedOnTurn: 3, attacksRemaining: 0,
        }), // 失调
        makeUnit({ ownerId: 'P1', instanceId: 'a3', attack: 0, health: 2, maxHealth: 2 }), // 0 攻
        makeUnit({
          ownerId: 'P1', instanceId: 'a4', attack: 2, health: 2, maxHealth: 2, attacksRemaining: 0,
        }), // 预算耗尽
      ],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1' }), makeUnit({ ownerId: 'P2', instanceId: 'e2' })],
    })
    const attacks = getLegalActions(state, 'P1').filter((a): a is AttackAction => a.type === 'ATTACK')
    expect(attacks).toEqual([
      { type: 'ATTACK', playerId: 'P1', attackerId: 'a1', target: unitRef('e1') },
      { type: 'ATTACK', playerId: 'P1', attackerId: 'a1', target: unitRef('e2') },
      { type: 'ATTACK', playerId: 'P1', attackerId: 'a1', target: heroRef('P2') },
    ])
  })

  it('存在已现身 taunt：目标集合收敛为 taunt 单位', () => {
    const state = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e-p' }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-t', keywords: ['taunt'] }),
      ],
    })
    const attacks = getLegalActions(state, 'P1').filter((a): a is AttackAction => a.type === 'ATTACK')
    expect(attacks).toEqual([{ type: 'ATTACK', playerId: 'P1', attackerId: 'a1', target: unitRef('e-t') }])
  })

  it('潜行敌方单位被过滤；敌方无单位时目标仅剩 CPU', () => {
    const withStealth = attackState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e-s', keywords: ['stealth'] }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-p' }),
      ],
    })
    expect(getLegalActions(withStealth, 'P1').filter((a): a is AttackAction => a.type === 'ATTACK')).toEqual([
      { type: 'ATTACK', playerId: 'P1', attackerId: 'a1', target: unitRef('e-p') },
      { type: 'ATTACK', playerId: 'P1', attackerId: 'a1', target: heroRef('P2') },
    ])

    const emptyBoard = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })] })
    expect(getLegalActions(emptyBoard, 'P1').filter((a): a is AttackAction => a.type === 'ATTACK')).toEqual([
      { type: 'ATTACK', playerId: 'P1', attackerId: 'a1', target: heroRef('P2') },
    ])
  })

  it('accessory 不产生攻击动作；charge 召唤回合（待授予预算）产生动作', () => {
    const accessory = makeUnit({
      ownerId: 'P1', instanceId: 'acc', cardId: 'c-aura-atk', attack: 1, health: 1, maxHealth: 1, attacksRemaining: 1,
    })
    const withAccessory = attackState({ board: [accessory] })
    expect(getLegalActions(withAccessory, 'P1').some((a) => a.type === 'ATTACK')).toBe(false)

    const charged = attackState({
      board: [
        makeUnit({
          ownerId: 'P1', instanceId: 'ch', attack: 2, health: 2, maxHealth: 2, keywords: ['charge'],
          summonedOnTurn: 3, attacksRemaining: 0,
        }),
      ],
    })
    const attacks = getLegalActions(charged, 'P1').filter((a): a is AttackAction => a.type === 'ATTACK')
    expect(attacks).toEqual([{ type: 'ATTACK', playerId: 'P1', attackerId: 'ch', target: heroRef('P2') }])
  })

  it('无幽灵动作：枚举出的全部 ATTACK 均可被 applyAction 接受', () => {
    const state = attackState({
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 2, health: 2, maxHealth: 2 }),
        makeUnit({
          ownerId: 'P1', instanceId: 'a2', attack: 1, health: 1, maxHealth: 1, keywords: ['windfury'], attacksRemaining: 2,
        }),
        makeUnit({ ownerId: 'P1', instanceId: 'acc', cardId: 'c-aura-atk', attack: 1, health: 1, maxHealth: 1, attacksRemaining: 0 }),
      ],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e-p' }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-t', keywords: ['taunt'] }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-s', keywords: ['stealth'] }),
      ],
    })
    const before = stableHash(state)
    for (const action of getLegalActions(state, 'P1')) {
      if (action.type === 'ATTACK') {
        expect(() => applyAction(state, action)).not.toThrow()
      }
    }
    expect(stableHash(state)).toBe(before)
  })

  it('USE_HERO_POWER 不出现（M1-ENG5）；非行动方与结束后枚举为空', () => {
    const state = attackState({ board: [makeUnit({ ownerId: 'P1', instanceId: 'a1' })] })
    const actions = getLegalActions(state, 'P1')
    expect(actions.some((a) => a.type === 'USE_HERO_POWER')).toBe(false)
    expect(getLegalActions(state, 'P2')).toEqual([])

    const ended = applyAction(initGame(makeSetup(TEST_SEED)), { type: 'CONCEDE', playerId: 'P2' }).state
    expect(getLegalActions(ended, 'P1')).toEqual([])
  })

  it('确定性：同 seed + 攻击序列两次执行，状态哈希与事件流逐字节一致', () => {
    const build = () =>
      attackState({
        board: [
          makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 2, maxHealth: 2 }),
        ],
        enemyBoard: [
          makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 2, health: 4, maxHealth: 4 }),
        ],
      })
    const run = () => {
      const first = applyAction(build(), atk('a1', unitRef('e1')))
      const second = applyAction(first.state, endTurn('P1'))
      return { state: second.state, events: [...first.events, ...second.events] }
    }
    const a = run()
    const b = run()
    expect(a.events).toEqual(b.events)
    expect(stableHash(a.state)).toBe(stableHash(b.state))
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
  })
})
