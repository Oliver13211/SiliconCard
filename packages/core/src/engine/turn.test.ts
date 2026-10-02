import { describe, expect, it } from 'vitest'
import { MAX_MANA } from '../constants'
import type { GameEvent } from '../types/events'
import { catchRuleError, makeGameState, makeSetup, makeUnit } from '../testing/state'
import { applyAction } from './apply'
import { initGame } from './init'
import { ownTurnNumber } from './turn'

function endTurn(playerId: 'P1' | 'P2') {
  return { type: 'END_TURN', playerId } as const
}

/** 从初始状态起跑 n 次 END_TURN（按 P1/P2 交替），返回累计事件流与最终状态 */
function runEndTurns(count: number): { state: ReturnType<typeof initGame>; events: GameEvent[] } {
  let state = initGame(makeSetup())
  const events: GameEvent[] = []
  for (let i = 0; i < count; i++) {
    const result = applyAction(state, endTurn(i % 2 === 0 ? 'P1' : 'P2'))
    state = result.state
    events.push(...result.events)
  }
  return { state, events }
}

describe('回合开始序列（rules.md §2.2）', () => {
  it('ownTurnNumber：P1 占奇数回合、P2 占偶数回合', () => {
    expect(ownTurnNumber(1, 'P1')).toBe(1)
    expect(ownTurnNumber(1, 'P2')).toBe(0)
    expect(ownTurnNumber(2, 'P2')).toBe(1)
    expect(ownTurnNumber(3, 'P1')).toBe(2)
    expect(ownTurnNumber(20, 'P2')).toBe(10)
    expect(ownTurnNumber(21, 'P1')).toBe(11)
  })

  it('供电曲线逐回合 +100W，至 MAX_MANA 封顶', () => {
    const { events } = runEndTurns(24) // 覆盖 turn 2..25
    const turnStarts = events.filter((e) => e.type === 'TURN_START')
    expect(turnStarts).toHaveLength(24)
    for (const event of turnStarts) {
      if (event.type !== 'TURN_START') continue
      const k = ownTurnNumber(event.turn, event.playerId)
      expect(event.maxMana).toBe(Math.min(k * 100, MAX_MANA))
    }
    // P1 自身第 10 回合（turn 19）起封顶 1000W
    const t19 = turnStarts.find((e) => e.type === 'TURN_START' && e.turn === 19)
    expect(t19 && t19.type === 'TURN_START' && t19.maxMana).toBe(1000)
    const t25 = turnStarts.find((e) => e.type === 'TURN_START' && e.turn === 25)
    expect(t25 && t25.type === 'TURN_START' && t25.maxMana).toBe(1000)
  })

  it('P1 首回合不抽牌（起手 3 张、牌库 27）；P2 首回合正常抽 1 张', () => {
    const state = initGame(makeSetup())
    expect(state.players.P1.hand).toHaveLength(3)
    expect(state.players.P1.deck).toHaveLength(27)

    const { state: afterOne, events } = runEndTurns(1)
    // turn 2 = P2 首回合：抽 1 张
    expect(afterOne.players.P2.hand).toHaveLength(4)
    expect(afterOne.players.P2.deck).toHaveLength(26)
    expect(afterOne.players.P1.hand).toHaveLength(3) // P1 未动作
    const drawn = events.filter((e) => e.type === 'CARD_DRAWN')
    expect(drawn).toEqual([
      { type: 'CARD_DRAWN', playerId: 'P2', cardId: 'smoke-gpu', source: 'deck' },
    ])
    const ts = events.find((e) => e.type === 'TURN_START')
    expect(ts).toMatchObject({ type: 'TURN_START', turn: 2, playerId: 'P2', maxMana: 100, drawCount: 1 })
  })

  it('每回合可用功耗 = maxMana - lockedMana（未锁定时等于 maxMana，不跨回合累积）', () => {
    const { state } = runEndTurns(2) // turn 3 = P1 自身第 2 回合
    expect(state.players.P1.maxMana).toBe(200)
    expect(state.players.P1.mana).toBe(200)
  })

  it('跳闸：lockedMana > 0 时发 BURN_OUT、按锁定量扣可用功耗，随后清零', () => {
    // turn 2 = P2 回合；P1 身上带着上回合跳闸锁定的 200W（牌库留牌避免疲劳事件混入）
    const base = makeGameState()
    const state = makeGameState({
      turn: 2,
      activePlayer: 'P2',
      players: {
        P1: { ...base.players.P1, lockedMana: 200, deck: [{ cardId: 'smoke-gpu' }] },
        P2: { ...base.players.P2, deck: [{ cardId: 'smoke-gpu' }] },
      },
    })
    const result = applyAction(state, endTurn('P2'))
    const p1 = result.state.players.P1
    expect(p1.maxMana).toBe(200) // 自身第 2 回合
    expect(p1.mana).toBe(0) // 200 - 200
    expect(p1.lockedMana).toBe(0) // 结算后清零
    expect(result.events.filter((e) => e.type === 'BURN_OUT')).toEqual([
      { type: 'BURN_OUT', playerId: 'P1', lockedMana: 200 },
    ])
    // 事件顺序：TURN_END(P2) → TURN_START(P1) → BURN_OUT → 正常抽牌
    expect(result.events.map((e) => e.type)).toEqual(['TURN_END', 'TURN_START', 'BURN_OUT', 'CARD_DRAWN'])

    // 再转一圈回来不再重复发 BURN_OUT
    const again = applyAction(result.state, endTurn('P1'))
    const next = applyAction(again.state, endTurn('P2'))
    expect(next.events.filter((e) => e.type === 'BURN_OUT')).toHaveLength(0)
    expect(next.state.players.P1.mana).toBe(next.state.players.P1.maxMana)
  })

  it('己方单位回合开始重置攻击次数（windfury=2、其余 1）与 attackedThisTurn；对方单位不受影响', () => {
    const state = makeGameState({
      turn: 2,
      activePlayer: 'P2',
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-wf', keywords: ['windfury'], attacksRemaining: 0, attackedThisTurn: true }),
        makeUnit({ ownerId: 'P1', instanceId: 'u-plain', attacksRemaining: 0, attackedThisTurn: true }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-oppo', attacksRemaining: 1, attackedThisTurn: false }),
      ],
    })
    const result = applyAction(state, endTurn('P2')) // 进入 turn 3（P1 回合）
    const board = result.state.board
    expect(board.find((u) => u.instanceId === 'u-wf')).toMatchObject({ attacksRemaining: 2, attackedThisTurn: false })
    expect(board.find((u) => u.instanceId === 'u-plain')).toMatchObject({ attacksRemaining: 1, attackedThisTurn: false })
    expect(board.find((u) => u.instanceId === 'u-oppo')).toMatchObject({ attacksRemaining: 1, attackedThisTurn: false })
    expect(result.state.players.P1.heroPowerUsed).toBe(false)
  })

  it('非法回合流转：非行动方 END_TURN → NOT_YOUR_TURN，状态原样保留', () => {
    const state = initGame(makeSetup())
    const error = catchRuleError(() => applyAction(state, endTurn('P2')))
    expect(error.code).toBe('NOT_YOUR_TURN')
    expect(error.message).toContain('P1')
    // 抛错不改状态
    expect(state.turn).toBe(1)
    expect(state.activePlayer).toBe('P1')
  })
})
