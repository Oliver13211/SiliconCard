import { describe, expect, it } from 'vitest'
import { DECK_SIZE } from '../constants'
import { catchRuleError, makeDeckSpec, makeDistinctDeckSpec, makeSetup, TEST_SEED } from '../testing/state'
import { stableHash } from '../testing/hash'
import { createEngine } from './index'
import { initGame } from './init'

const engine = createEngine()

describe('initGame —— 开局构建（rules.md §2.1）', () => {
  it('进入 P1 的第 1 回合：turn 1 / 先手 P1 / P1 供电 100W，P2 尚未开始回合', () => {
    const state = initGame(makeSetup())
    expect(state.turn).toBe(1)
    expect(state.activePlayer).toBe('P1')
    expect(state.phase).toBe('main')
    expect(state.winner).toBeNull()
    expect(state.endReason).toBeNull()
    expect(state.nextInstanceId).toBe(7) // 6 张起手牌消耗 h1..h6
    const { P1, P2 } = state.players
    expect(P1.maxMana).toBe(100)
    expect(P1.mana).toBe(100)
    expect(P1.lockedMana).toBe(0)
    expect(P1.heroPowerUsed).toBe(false)
    expect(P1.health).toBe(30)
    expect(P1.maxHealth).toBe(30)
    expect(P1.fatigue).toBe(0)
    // P2 未经历自身回合：供电为 0，等其第 1 回合开始再涨
    expect(P2.maxMana).toBe(0)
    expect(P2.mana).toBe(0)
  })

  it('起手各 3 张、P1 先抽交替发牌，uid 全局唯一', () => {
    const state = initGame(makeSetup())
    const p1 = state.players.P1
    const p2 = state.players.P2
    expect(p1.hand).toHaveLength(3)
    expect(p2.hand).toHaveLength(3)
    expect(p1.deck).toHaveLength(DECK_SIZE - 3)
    expect(p2.deck).toHaveLength(DECK_SIZE - 3)
    // 发牌顺序 P1,P2,P1,P2,P1,P2 → uid 按序占用全局计数
    expect(p1.hand.map((c) => c.uid)).toEqual(['h1', 'h3', 'h5'])
    expect(p2.hand.map((c) => c.uid)).toEqual(['h2', 'h4', 'h6'])
    const all = [...p1.hand, ...p2.hand].map((c) => c.uid)
    expect(new Set(all).size).toBe(6)
  })

  it('起手牌不消耗牌库以外的张数，rng.state 为整数并随状态序列化', () => {
    const state = initGame(makeSetup())
    expect(Number.isInteger(state.rng.state)).toBe(true)
    expect(state.rng.state).toBeGreaterThanOrEqual(0)
    expect(state.rng.state).toBeLessThan(2 ** 32)
    // rng 状态 ≠ 原始 seed（洗牌已推进）
    expect(state.rng.state).not.toBe(TEST_SEED >>> 0)
  })

  it('洗牌确定性：同 seed 牌库顺序一致，异 seed 顺序不同', () => {
    const a = initGame(makeSetup(TEST_SEED, makeDistinctDeckSpec()))
    const b = initGame(makeSetup(TEST_SEED, makeDistinctDeckSpec()))
    const c = initGame(makeSetup(TEST_SEED + 1, makeDistinctDeckSpec()))
    expect(a.players.P1.deck).toEqual(b.players.P1.deck)
    expect(a.players.P2.deck).toEqual(b.players.P2.deck)
    expect(a.players.P1.deck).not.toEqual(c.players.P1.deck)
    expect(a.players.P2.deck).not.toEqual(c.players.P2.deck)
  })

  it('确定性：同 seed 初始状态哈希一致，异 seed 哈希不同', () => {
    expect(stableHash(initGame(makeSetup(TEST_SEED)))).toBe(stableHash(initGame(makeSetup(TEST_SEED))))
    expect(stableHash(initGame(makeSetup(TEST_SEED)))).not.toBe(
      stableHash(initGame(makeSetup(TEST_SEED + 1))),
    )
  })

  it('DECK_INVALID：总数不足/超出', () => {
    const short = catchRuleError(() => initGame(makeSetup(TEST_SEED, makeDeckSpec('x', 29))))
    expect(short.code).toBe('DECK_INVALID')
    expect(short.message).toContain('30')
    const over = catchRuleError(() => initGame(makeSetup(TEST_SEED, makeDeckSpec('x', 31))))
    expect(over.code).toBe('DECK_INVALID')
  })

  it('DECK_INVALID：数量非正整数 / 非法对局配置', () => {
    const zero = catchRuleError(() =>
      initGame({ seed: 1, players: [
        { id: 'P1', faction: 'nvidia', deck: { cards: [{ cardId: 'a', count: 0 }] } },
        { id: 'P2', faction: 'amd', deck: makeDeckSpec() },
      ] }),
    )
    expect(zero.code).toBe('DECK_INVALID')
    const negative = catchRuleError(() =>
      initGame({ seed: 1, players: [
        { id: 'P1', faction: 'nvidia', deck: { cards: [{ cardId: 'a', count: -5 }] } },
        { id: 'P2', faction: 'amd', deck: makeDeckSpec() },
      ] }),
    )
    expect(negative.code).toBe('DECK_INVALID')
    const fractional = catchRuleError(() =>
      initGame({ seed: 1, players: [
        { id: 'P1', faction: 'nvidia', deck: { cards: [{ cardId: 'a', count: 1.5 }] } },
        { id: 'P2', faction: 'amd', deck: makeDeckSpec() },
      ] }),
    )
    expect(fractional.code).toBe('DECK_INVALID')
    const wrongId = catchRuleError(() =>
      initGame({ seed: 1, players: [
        { id: 'P2', faction: 'nvidia', deck: makeDeckSpec() },
        { id: 'P2', faction: 'amd', deck: makeDeckSpec() },
      ] }),
    )
    expect(wrongId.code).toBe('DECK_INVALID')
  })

  it('createEngine 门面与直连实现行为一致', () => {
    expect(stableHash(engine.initGame(makeSetup(TEST_SEED)))).toBe(
      stableHash(initGame(makeSetup(TEST_SEED))),
    )
  })
})
