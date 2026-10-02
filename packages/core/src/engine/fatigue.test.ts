import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../types/events'
import type { PlayerId } from '../types/state'
import { catchRuleError, makeGameState, makePlayer } from '../testing/state'
import { applyAction } from './apply'
import { checkGameEnd } from './turn'

function endTurn(playerId: PlayerId) {
  return { type: 'END_TURN', playerId } as const
}

/** 双方牌库皆空的最小状态：每次回合开始都进入疲劳 */
const fatigueState = makeGameState

describe('疲劳（rules.md §9）', () => {
  it('牌库为空：fatigue 递增 1,2,3…，受伤等于 fatigue 点，事件序 CARD_DRAWN(fatigue) → DAMAGE_DEALT → FATIGUE', () => {
    const state = fatigueState()
    // P1 END_TURN → turn 2（P2 首回合）：P2 fatigue 1
    const r1 = applyAction(state, endTurn('P1'))
    expect(r1.state.players.P2.fatigue).toBe(1)
    expect(r1.state.players.P2.health).toBe(29)
    expect(r1.events.filter((e) => e.type !== 'TURN_START' && e.type !== 'TURN_END')).toEqual([
      { type: 'CARD_DRAWN', playerId: 'P2', cardId: null, source: 'fatigue' },
      {
        type: 'DAMAGE_DEALT',
        source: { kind: 'fatigue' },
        target: { kind: 'hero', playerId: 'P2' },
        amount: 1,
        remainingHealth: 29,
      },
      { type: 'FATIGUE', playerId: 'P2', fatigueCount: 1, damage: 1 },
    ])

    // 继续：turn 3（P1 fatigue 1）、turn 4（P2 fatigue 2）
    const r2 = applyAction(r1.state, endTurn('P2'))
    expect(r2.state.players.P1.fatigue).toBe(1)
    expect(r2.state.players.P1.health).toBe(29)
    const r3 = applyAction(r2.state, endTurn('P1'))
    expect(r3.state.players.P2.fatigue).toBe(2)
    expect(r3.state.players.P2.health).toBe(27) // 29 - 2
    const fatigueEvent = r3.events.find((e) => e.type === 'FATIGUE')
    expect(fatigueEvent).toMatchObject({ playerId: 'P2', fatigueCount: 2, damage: 2 })
  })

  it('疲劳抽牌不给手牌加卡', () => {
    const state = fatigueState()
    const r1 = applyAction(state, endTurn('P1'))
    expect(r1.state.players.P2.hand).toHaveLength(0)
    expect(r1.state.players.P2.deck).toHaveLength(0)
  })

  it('护甲先于体质结算（armorAbsorbed 计入 DAMAGE_DEALT，体质无损）', () => {
    // P2 已疲劳 1 次并带 5 点护甲；END_TURN P1 后进入 P2 回合 → P2 疲劳 2、伤害 2 全由护甲吸收
    const state = fatigueState({
      turn: 1,
      activePlayer: 'P1',
      players: {
        P1: makePlayer('P1'),
        P2: { ...makePlayer('P2'), fatigue: 1, armor: 5 },
      },
    })
    const result = applyAction(state, endTurn('P1'))
    const p2 = result.state.players.P2
    expect(p2.fatigue).toBe(2)
    expect(p2.armor).toBe(3) // 5 - 2
    expect(p2.health).toBe(30) // 体质无损
    const damage = result.events.find((e) => e.type === 'DAMAGE_DEALT')
    expect(damage).toMatchObject({
      source: { kind: 'fatigue' },
      target: { kind: 'hero', playerId: 'P2' },
      amount: 2,
      remainingHealth: 30,
      armorAbsorbed: 2,
    })
  })

  it('护甲吸收后仍会透伤：护甲 1、疲劳伤害 2 → 护甲清零、体质扣 1', () => {
    const state = fatigueState({
      turn: 2,
      activePlayer: 'P2',
      players: {
        P1: { ...makePlayer('P1'), armor: 1 },
        P2: makePlayer('P2'),
      },
    })
    const result = applyAction(state, endTurn('P2')) // turn 3：P1 fatigue 1，伤害 1 全由护甲吸收
    const p1 = result.state.players.P1
    expect(p1.armor).toBe(0)
    expect(p1.health).toBe(30)
    const damage = result.events.find((e) => e.type === 'DAMAGE_DEALT')
    expect(damage).toMatchObject({ amount: 1, remainingHealth: 30, armorAbsorbed: 1 })

    // 再转两圈：turn 5 P1 fatigue 2、伤害 2 → 护甲已空，体质 30 → 28
    const r2 = applyAction(result.state, endTurn('P1'))
    const r3 = applyAction(r2.state, endTurn('P2'))
    expect(r3.state.players.P1.health).toBe(28)
    expect(r3.state.players.P1.armor).toBe(0)
  })

  it('疲劳致死：累计伤害 ≥ 体质 → GAME_END{health_zero}，对手获胜', () => {
    let state = fatigueState()
    let lastEvents: GameEvent[] = []
    let guard = 0
    while (state.phase !== 'ended') {
      if (guard++ > 30) throw new Error('对局未按预期终止')
      const result = applyAction(state, endTurn(state.activePlayer))
      state = result.state
      lastEvents = [...result.events]
    }
    // 双方同节奏疲劳，P2 的第 k 次疲劳总在 P1 之前一步到来 → P2 先死（fatigue 8：1+2+…+8=36 ≥ 30）
    expect(state.players.P2.fatigue).toBe(8)
    expect(state.players.P2.health).toBe(0) // 血量截断为 0，不出现负数
    expect(state.players.P1.fatigue).toBe(7)
    expect(state.players.P1.health).toBe(2)
    expect(state.winner).toBe('P1')
    expect(state.endReason).toBe('health_zero')
    // 终局事件以 GAME_END 收尾
    expect(lastEvents.at(-1)).toEqual({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
    expect(lastEvents.filter((e) => e.type === 'FATIGUE')).toEqual([
      { type: 'FATIGUE', playerId: 'P2', fatigueCount: 8, damage: 8 },
    ])
  })

  it('结束后再动作 → GAME_ENDED', () => {
    let state = fatigueState()
    let guard = 0
    while (state.phase !== 'ended' && guard++ < 30) {
      state = applyAction(state, endTurn(state.activePlayer)).state
    }
    const error = catchRuleError(() => applyAction(state, endTurn('P1')))
    expect(error.code).toBe('GAME_ENDED')
  })
})

describe('胜负判定边界（rules.md §9：同时归零 → 平局）', () => {
  it('双方同时归零：winner null、reason health_zero', () => {
    const state = makeGameState({
      players: {
        P1: { ...makePlayer('P1'), health: 0, armor: 0 },
        P2: { ...makePlayer('P2'), health: 0, armor: 0 },
      },
    })
    const events: GameEvent[] = []
    checkGameEnd(state, events)
    expect(state.phase).toBe('ended')
    expect(state.winner).toBeNull()
    expect(state.endReason).toBe('health_zero')
    expect(events).toEqual([{ type: 'GAME_END', winner: null, reason: 'health_zero' }])
  })

  it('仅一方归零：对方获胜', () => {
    const events: GameEvent[] = []
    const state = makeGameState({
      players: {
        P1: { ...makePlayer('P1'), health: 0, armor: 0 },
        P2: { ...makePlayer('P2'), health: 10, armor: 0 },
      },
    })
    checkGameEnd(state, events)
    expect(state.winner).toBe('P2')
  })

  it('护甲可挡下致命伤：health 0 + armor 3 不算倒下', () => {
    const events: GameEvent[] = []
    const state = makeGameState({
      players: {
        P1: { ...makePlayer('P1'), health: 0, armor: 3 },
        P2: makePlayer('P2'),
      },
    })
    checkGameEnd(state, events)
    expect(state.phase).toBe('main')
    expect(events).toHaveLength(0)
  })
})
