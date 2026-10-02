import { describe, expect, it } from 'vitest'
import { HAND_LIMIT } from '../constants'
import type { Action } from '../types/actions'
import type { HandCard, PlayerState } from '../types/state'
import { catchRuleError, makeGameState, makePlayer, makeSetup } from '../testing/state'
import { stableHash } from '../testing/hash'
import { applyAction, getLegalActions } from './apply'
import { initGame } from './init'

function endTurn(playerId: 'P1' | 'P2'): Action {
  return { type: 'END_TURN', playerId }
}

function concede(playerId: 'P1' | 'P2'): Action {
  return { type: 'CONCEDE', playerId }
}

function handOf(count: number, startUid = 1): HandCard[] {
  return Array.from({ length: count }, (_, i) => ({ uid: `h${startUid + i}`, cardId: 'smoke-gpu', cost: 100 }))
}

function stateWithHand(handSize: number) {
  return makeGameState({
    players: {
      P1: { ...makePlayer('P1'), hand: handOf(handSize), deck: [], maxMana: 100, mana: 100 },
      // P2 牌库留牌，避免其回合开始的疲劳事件混入本用例
      P2: { ...makePlayer('P2'), deck: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }] },
    },
  })
}

describe('END_TURN —— 回合结束（rules.md §2.5）', () => {
  it('切换行动方并推进回合；输入状态不被原地修改', () => {
    const state = initGame(makeSetup())
    const before = stableHash(state)
    const result = applyAction(state, endTurn('P1'))
    expect(result.state.turn).toBe(2)
    expect(result.state.activePlayer).toBe('P2')
    expect(result.events[0]).toEqual({ type: 'TURN_END', turn: 1, playerId: 'P1' })
    // 不可变性：原状态哈希不变
    expect(stableHash(state)).toBe(before)
  })

  it('手牌超上限：从末尾烧牌，烧掉的牌不进弃牌堆', () => {
    const state = stateWithHand(HAND_LIMIT + 2) // 12 张
    const result = applyAction(state, endTurn('P1'))
    // 烧两张，且从末尾烧（h12 先于 h11）
    expect(result.events.filter((e) => e.type === 'CARD_BURNED')).toEqual([
      { type: 'CARD_BURNED', playerId: 'P1', cardId: 'smoke-gpu', reason: 'hand_full' },
      { type: 'CARD_BURNED', playerId: 'P1', cardId: 'smoke-gpu', reason: 'hand_full' },
    ])
    const p1: PlayerState = result.state.players.P1
    expect(p1.hand).toHaveLength(HAND_LIMIT)
    expect(p1.hand.map((c) => c.uid)).toEqual(handOf(10).map((c) => c.uid))
    expect(p1.graveyard).toHaveLength(0) // 烧牌 ≠ 弃牌
    // 事件顺序：TURN_END → 烧牌 → TURN_START
    expect(result.events.map((e) => e.type)).toEqual([
      'TURN_END',
      'CARD_BURNED',
      'CARD_BURNED',
      'TURN_START',
      'CARD_DRAWN',
    ])
  })

  it('手牌恰好等于上限：不烧牌', () => {
    const result = applyAction(stateWithHand(HAND_LIMIT), endTurn('P1'))
    expect(result.events.filter((e) => e.type === 'CARD_BURNED')).toHaveLength(0)
    expect(result.state.players.P1.hand).toHaveLength(HAND_LIMIT)
  })

  it('非行动方 END_TURN → NOT_YOUR_TURN', () => {
    const state = initGame(makeSetup())
    expect(catchRuleError(() => applyAction(state, endTurn('P2'))).code).toBe('NOT_YOUR_TURN')
  })
})

describe('CONCEDE —— 认输（rules.md §9）', () => {
  it('任意玩家可在任意时刻认输，对方获胜', () => {
    const state = initGame(makeSetup())
    // P2 在 P1 回合中认输
    const result = applyAction(state, concede('P2'))
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBe('P1')
    expect(result.state.endReason).toBe('concede')
    expect(result.events).toEqual([{ type: 'GAME_END', winner: 'P1', reason: 'concede' }])
  })

  it('行动方认输同样成立', () => {
    const state = initGame(makeSetup())
    const result = applyAction(state, concede('P1'))
    expect(result.state.winner).toBe('P2')
  })
})

describe('未知动作结构 → UNKNOWN_ACTION', () => {
  // USE_HERO_POWER 自 M1-ENG5 起完整实装（见 heroPower.test.ts），五种动作全通
  it('完全未知的动作结构 → UNKNOWN_ACTION', () => {
    const state = initGame(makeSetup())
    const error = catchRuleError(() =>
      applyAction(state, { type: 'TIME_TRAVEL' } as unknown as Action),
    )
    expect(error.code).toBe('UNKNOWN_ACTION')
  })
})

describe('对局结束后的动作闸门（rules.md §3）', () => {
  it('结束后 END_TURN / CONCEDE 均抛 GAME_ENDED', () => {
    const state = initGame(makeSetup())
    const ended = applyAction(state, concede('P2')).state
    expect(catchRuleError(() => applyAction(ended, endTurn('P1'))).code).toBe('GAME_ENDED')
    expect(catchRuleError(() => applyAction(ended, concede('P1'))).code).toBe('GAME_ENDED')
  })
})

describe('getLegalActions（AI / UI 可交互性共用）', () => {
  it('未结束：当前行动玩家得到 [END_TURN, CONCEDE, PLAY_CARD…]（起手 3 张均 playable），对手得到 []', () => {
    const state = initGame(makeSetup())
    expect(getLegalActions(state, 'P1')).toEqual([
      { type: 'END_TURN', playerId: 'P1' },
      { type: 'CONCEDE', playerId: 'P1' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h3' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h5' },
    ])
    expect(getLegalActions(state, 'P2')).toEqual([])
  })

  it('对局结束：所有人得到 []', () => {
    const ended = applyAction(initGame(makeSetup()), concede('P1')).state
    expect(getLegalActions(ended, 'P1')).toEqual([])
    expect(getLegalActions(ended, 'P2')).toEqual([])
  })
})
