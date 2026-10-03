/**
 * 胜负收口终审（M1-ENG7）：docs/rules.md §9 全部致命路径经**公开接口 applyAction**
 * （真实引擎、完整结算序列）逐一审计——GAME_END 必须是终局动作事件流的最后一个事件、
 * 恰好发出一次，且结算画面所需数据（winner / reason / 回合数 / 双方展示信息）
 * 可从终局 state + GAME_END 事件完整获得（§6 / §9 结算信息完整性裁定）。
 *
 * 覆盖致命路径：攻击 CPU 致死 / battlecry（出牌效果）致死 / heroPower 致死 /
 * onDamaged 触发致死 / 亡语致死 / turnEnd 触发致死（含双方同时归零平局）/
 * turnStart 触发致死 / 疲劳致死 / CONCEDE；对局结束后一切动作 GAME_ENDED。
 * 疲劳节奏与平局语义的单测细节另见 fatigue.test.ts / combat.test.ts。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { GameEvent, GameEndReason } from '../types/events'
import type { TargetRef } from '../types/actions'
import type { Action } from '../types/actions'
import type { DeckEntry, GameState, HandCard, PlayerId, PlayerState } from '../types/state'
import { makeGameState, makePlayer, makeUnit } from '../testing/state'
import { viewFor } from './view'
import { applyAction } from './apply'
import { registerCardDefinitions } from './registry'

// —— 测试卡池（vitest 文件间注册表隔离）：每张卡对应一条致命路径 ——

const EG_CARDS: CardDefinition[] = [
  // battlecry 直杀：出牌效果对敌方 CPU 结算 30 点
  { id: 'eg-execution', name: '电源炸了', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'enemyHero' }, amount: 30 }] } },
  // onDamaged 触发致死：受伤时对 opposingPlayer（攻击方 CPU）结算 30 点
  { id: 'eg-static', name: '静电装甲', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 3,
    effect: { trigger: 'onDamaged', steps: [{ op: 'damage', target: { kind: 'all', pool: 'opposingPlayer' }, amount: 30 }] } },
  // 亡语致死：死亡时对 opposingPlayer（击杀方 CPU）结算 30 点
  { id: 'eg-legacy', name: '传家宝爆炸', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'damage', target: { kind: 'all', pool: 'opposingPlayer' }, amount: 30 }] } },
  // turnEnd 触发致死（全场 anyCharacter，双方 CPU 同时归零 → 平局）
  { id: 'eg-offwork', name: '下班炸机', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 2,
    effect: { trigger: 'turnEnd', steps: [{ op: 'damage', target: { kind: 'all', pool: 'anyCharacter' }, amount: 30 }] } },
  // turnStart 触发致死（同上，回合开始时点）
  { id: 'eg-morning', name: '晨间炸机', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 2,
    effect: { trigger: 'turnStart', steps: [{ op: 'damage', target: { kind: 'all', pool: 'anyCharacter' }, amount: 30 }] } },
]
registerCardDefinitions(EG_CARDS)

// —— 构造工具 ——

const heroRef = (playerId: 'P1' | 'P2'): TargetRef => ({ kind: 'hero', playerId })
const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })
const hc = (uid: string, cardId: string, cost = 100): HandCard => ({ uid, cardId, cost })

interface EndgameStateOptions {
  turn?: number
  activePlayer?: PlayerId
  board?: GameState['board']
  p1?: Partial<PlayerState>
  p2?: Partial<PlayerState>
}

/** 合成状态：turn 默认 3、P1 行动；双方牌库各留 1 张（疲劳测试自行清空） */
function endgameState(opts: EndgameStateOptions = {}): GameState {
  return makeGameState({
    turn: opts.turn ?? 3,
    activePlayer: opts.activePlayer ?? 'P1',
    players: {
      P1: { ...makePlayer('P1'), deck: [{ cardId: 'smoke-gpu' }] as DeckEntry[], ...(opts.p1 ?? {}) },
      P2: { ...makePlayer('P2'), deck: [{ cardId: 'smoke-gpu' }] as DeckEntry[], ...(opts.p2 ?? {}) },
    },
    board: opts.board ?? [],
  })
}

/** 结算画面信息完整性断言（§6 / §9）：GAME_END 收尾、恰好一次、state/事件/view 三方同源 */
function assertSettlement(result: { state: GameState; events: readonly GameEvent[] }): {
  winner: PlayerId | null
  reason: GameEndReason
} {
  const last = result.events.at(-1)
  expect(last?.type).toBe('GAME_END')
  const gameEnds = result.events.filter((e) => e.type === 'GAME_END')
  expect(gameEnds.length).toBe(1) // 幂等：多条致命路径/重复判定不重复收局
  const gameEnd = last as Extract<GameEvent, { type: 'GAME_END' }>
  // 事件与终局 state 同源
  expect(gameEnd.winner).toBe(result.state.winner)
  expect(gameEnd.reason).toBe(result.state.endReason)
  expect(result.state.phase).toBe('ended')
  // 结算画面所需数据齐备：回合数、双方展示信息（§6 GAME_END 消费方：结算画面）
  expect(Number.isInteger(result.state.turn)).toBe(true)
  expect(result.state.players.P1.heroName).toBeTruthy()
  expect(result.state.players.P2.heroName).toBeTruthy()
  expect(result.state.players.P1.faction).toBeTruthy()
  expect(result.state.players.P2.faction).toBeTruthy()
  // 视角裁剪视图同样携带终局结论（client-ui 结算画面经 viewFor 消费）
  for (const viewer of ['P1', 'P2'] as const) {
    const view = viewFor(result.state, viewer)
    expect(view.phase).toBe('ended')
    expect(view.winner).toBe(result.state.winner)
  }
  return { winner: gameEnd.winner, reason: gameEnd.reason }
}

describe('胜负收口终审（M1-ENG7）：致命路径 × 结算完整性（rules.md §9）', () => {
  it('combat：攻击 CPU 致死 → 对方胜，GAME_END 收尾', () => {
    const state = endgameState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-ram', attack: 30, health: 5, summonedOnTurn: 1, attacksRemaining: 1 })],
      p2: { health: 30 },
    })
    const result = applyAction(state, { type: 'ATTACK', playerId: 'P1', attackerId: 'u-ram', target: heroRef('P2') })
    expect(assertSettlement(result)).toEqual({ winner: 'P1', reason: 'health_zero' })
    expect(result.state.players.P2.health).toBe(0)
  })

  it('battlecry：出牌效果致死 → 对方胜，GAME_END 收尾', () => {
    const state = endgameState({
      p1: { mana: 100, maxMana: 100, hand: [hc('h1', 'eg-execution')] },
      p2: { health: 30 },
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: heroRef('P2') })
    expect(assertSettlement(result)).toEqual({ winner: 'P1', reason: 'health_zero' })
    expect(result.state.players.P2.health).toBe(0)
  })

  it('heroPower：派系技能致死 → 对方胜，GAME_END 收尾', () => {
    const state = endgameState({
      p1: { faction: 'neutral', mana: 200, maxMana: 200, heroPowerUsed: false },
      p2: { health: 1 },
    })
    const result = applyAction(state, { type: 'USE_HERO_POWER', playerId: 'P1', target: heroRef('P2') })
    expect(assertSettlement(result)).toEqual({ winner: 'P1', reason: 'health_zero' })
    expect(result.state.players.P2.health).toBe(0)
  })

  it('onDamaged 触发致死：攻击静电装甲 → 攻击方 CPU 被反杀，GAME_END 收尾', () => {
    const state = endgameState({
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-attacker', attack: 1, health: 5, summonedOnTurn: 1, attacksRemaining: 1 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-static', cardId: 'eg-static', attack: 0, health: 3 }),
      ],
    })
    const result = applyAction(state, { type: 'ATTACK', playerId: 'P1', attackerId: 'u-attacker', target: unitRef('u-static') })
    expect(assertSettlement(result)).toEqual({ winner: 'P2', reason: 'health_zero' })
    expect(result.state.players.P1.health).toBe(0)
    // P1 倒下即收局：防守方剩余血量不受影响
    expect(result.state.players.P2.health).toBe(30)
  })

  it('亡语致死：击杀传家宝 → 击杀方 CPU 被带走，GAME_END 收尾', () => {
    const state = endgameState({
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-attacker', attack: 1, health: 5, summonedOnTurn: 1, attacksRemaining: 1 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-legacy', cardId: 'eg-legacy', attack: 0, health: 1 }),
      ],
    })
    const result = applyAction(state, { type: 'ATTACK', playerId: 'P1', attackerId: 'u-attacker', target: unitRef('u-legacy') })
    expect(assertSettlement(result)).toEqual({ winner: 'P2', reason: 'health_zero' })
    expect(result.state.players.P1.health).toBe(0)
  })

  it('turnEnd 触发致死：双方 CPU 同时归零 → winner null 平局；END_TURN 即刻收局（不烧牌/不切换）', () => {
    const state = endgameState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-offwork', cardId: 'eg-offwork', attack: 0, health: 2 })],
      p1: { hand: [hc('h1', 'smoke-gpu')] }, // 若误走烧牌/切换链路，turn/activePlayer 会漂移
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(assertSettlement(result)).toEqual({ winner: null, reason: 'health_zero' })
    expect(result.state.players.P1.health).toBe(0)
    expect(result.state.players.P2.health).toBe(0)
    // 终局后不再推进：不烧牌、不切换行动方、不进入对方回合
    expect(result.state.turn).toBe(3)
    expect(result.state.activePlayer).toBe('P1')
    expect(result.state.players.P1.hand.length).toBe(1)
    expect(result.events.at(-2)?.type).not.toBe('CARD_BURNED')
  })

  it('turnStart 触发致死：新回合开始时点全场炸机 → 平局，GAME_END 收尾', () => {
    const state = endgameState({
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-morning', cardId: 'eg-morning', attack: 0, health: 2 })],
      p1: { fatigue: 0 },
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(assertSettlement(result)).toEqual({ winner: null, reason: 'health_zero' })
    // turnStart 触发发生在 beginTurn 内：回合已 +1 后收局
    expect(result.state.turn).toBe(4)
  })

  it('疲劳致死：牌库枯竭的玩家在回合开始倒下 → 对方胜，GAME_END 收尾', () => {
    const state = endgameState({
      p2: { deck: [], fatigue: 29, health: 30 },
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(assertSettlement(result)).toEqual({ winner: 'P1', reason: 'health_zero' })
    expect(result.state.players.P2.fatigue).toBe(30)
    expect(result.state.players.P2.health).toBe(0)
  })

  it('concede：认输 → 对方胜（无需轮到该玩家），GAME_END 收尾', () => {
    const state = endgameState({ activePlayer: 'P1' })
    const result = applyAction(state, { type: 'CONCEDE', playerId: 'P2' })
    expect(assertSettlement(result)).toEqual({ winner: 'P1', reason: 'concede' })
  })

  it('对局结束后一切动作 GAME_ENDED（含 END_TURN / ATTACK / PLAY_CARD / USE_HERO_POWER / CONCEDE）', () => {
    const ended = applyAction(endgameState(), { type: 'CONCEDE', playerId: 'P2' }).state
    const actions: Action[] = [
      { type: 'END_TURN', playerId: 'P1' },
      { type: 'CONCEDE', playerId: 'P1' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' },
      { type: 'ATTACK', playerId: 'P1', attackerId: 'u-x', target: heroRef('P2') },
      { type: 'USE_HERO_POWER', playerId: 'P1' },
    ]
    for (const action of actions) {
      expect(() => applyAction(ended, action)).toThrow(/\[GAME_ENDED\]/)
    }
  })

  it('终局动作不可再推进对局：终局 state 再次 applyAction 一律拒绝且原状态不变', () => {
    const ended = applyAction(endgameState({ p2: { deck: [], fatigue: 29 } }), { type: 'END_TURN', playerId: 'P1' }).state
    expect(ended.phase).toBe('ended')
    expect(() => applyAction(ended, { type: 'END_TURN', playerId: ended.activePlayer })).toThrow(/GAME_ENDED/)
    expect(ended.winner).toBe('P1')
  })
})
