import { describe, expect, it } from 'vitest'
import { makeGameState, makeSetup, makeUnit } from '../testing/state'
import type { PublicPlayerState, SelfPlayerState } from '../types/state'
import { applyAction } from './apply'
import { initGame } from './init'
import { viewFor } from './view'

const PUBLIC_KEYS = [
  'armor',
  'deckSize',
  'faction',
  'fatigue',
  'graveyardSize',
  'handSize',
  'health',
  'heroName',
  'heroPowerUsed',
  'id',
  'mana',
  'maxHealth',
  'maxMana',
].sort()

describe('viewFor —— 视角裁剪（rules.md §10）', () => {
  it('自己：完整手牌（uid/cardId/cost）与全部公开数值', () => {
    const state = initGame(makeSetup())
    const view = viewFor(state, 'P1')
    expect(view.viewer).toBe('P1')
    expect(view.turn).toBe(1)
    expect(view.phase).toBe('main')
    expect(view.activePlayer).toBe('P1')
    expect(view.winner).toBeNull()
    const you: SelfPlayerState = view.you
    expect(you.hand).toEqual(state.players.P1.hand)
    expect(you.hand.map((c) => c.uid)).toEqual(['h1', 'h3', 'h5'])
    expect(you.hand.every((c) => typeof c.cost === 'number')).toBe(true)
    expect(you.mana).toBe(100)
  })

  it('对手：只有计数（handSize/deckSize/graveyardSize），不泄露手牌与牌库内容', () => {
    const state = initGame(makeSetup())
    const view = viewFor(state, 'P1')
    const opp: PublicPlayerState = view.opponent
    expect(Object.keys(opp).sort()).toEqual(PUBLIC_KEYS)
    expect(opp.handSize).toBe(3)
    expect(opp.deckSize).toBe(27)
    expect(opp.graveyardSize).toBe(0)
    expect(opp.faction).toBe('amd')
    // 对手视角对称
    const view2 = viewFor(state, 'P2')
    expect(Object.keys(view2.opponent).sort()).toEqual(PUBLIC_KEYS)
    expect(view2.you.hand).toEqual(state.players.P2.hand)
    expect(view2.opponent.handSize).toBe(3)
  })

  it('永不泄露 rng.state', () => {
    const state = initGame(makeSetup())
    const json = JSON.stringify(viewFor(state, 'P1'))
    expect(json).not.toContain('"rng"')
    expect('rng' in viewFor(state, 'P1')).toBe(false)
  })

  it('board 全量公开：双方视角看到同一份场上单位', () => {
    const unit = makeUnit({ ownerId: 'P1', instanceId: 'u1', attack: 3, health: 2, maxHealth: 2 })
    const state = makeGameState({ board: [unit] })
    expect(viewFor(state, 'P1').board).toEqual([unit])
    expect(viewFor(state, 'P2').board).toEqual([unit])
  })

  it('终局视角携带 winner / phase', () => {
    const state = initGame(makeSetup())
    const ended = applyAction(state, { type: 'CONCEDE', playerId: 'P2' }).state
    const view = viewFor(ended, 'P1')
    expect(view.phase).toBe('ended')
    expect(view.winner).toBe('P1')
  })
})
