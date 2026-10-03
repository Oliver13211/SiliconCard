import { beforeEach, describe, expect, it } from 'vitest'
import type { Action, BoardUnit, HandCard } from '@siliconcard/core'
import { deriveInteractivity, attackStatusOf, handCardStatus, heroPowerStatus } from '../game/legal'
import { ensureContentRegistered } from '../game/deckLoader'
import { boardUnit, handCard, makeView } from './fixtures'

// handCardStatus/attackStatusOf 读取展示用卡牌定义（demo 池），与真实 content 隔离
beforeEach(() => {
  ensureContentRegistered({ cards: {}, decks: {} })
})

const HERO_P2: Action = { type: 'ATTACK', playerId: 'P1', attackerId: 'u9', target: { kind: 'hero', playerId: 'P2' } }

function firstHand(view: ReturnType<typeof makeView>): HandCard {
  return view.you.hand[0] as HandCard
}

describe('可交互性推导（getLegalActions 驱动 + 梗化禁用原因）', () => {
  it('deriveInteractivity：按动作类型归组，无目标展开记为空数组', () => {
    const view = makeView({ you: { hand: [handCard({ uid: 'h1' })] } })
    const legal: Action[] = [
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'hero', playerId: 'P2' } },
      HERO_P2,
      { type: 'END_TURN', playerId: 'P1' },
      { type: 'CONCEDE', playerId: 'P1' },
    ]
    const it0 = deriveInteractivity(view, legal)
    expect(it0.yourTurn).toBe(true)
    expect(it0.canEndTurn).toBe(true)
    expect(it0.playsByUid.get('h1')).toEqual([]) // 无需目标
    expect(it0.playsByUid.get('h2')).toEqual([{ kind: 'hero', playerId: 'P2' }])
    expect(it0.attacksByAttacker.get('u9')).toEqual([{ kind: 'hero', playerId: 'P2' }])
    expect(it0.heroPowerTargets).toBeNull()
  })

  it('手牌禁用原因：功耗不足 →「供电不够」', () => {
    const view = makeView({ you: { mana: 50, hand: [handCard({ cardId: 'demo-rtx-4090', cost: 450 })] } })
    const it0 = deriveInteractivity(view, [])
    const status = handCardStatus(view, it0, firstHand(view))
    expect(status.available).toBe(false)
    expect(status.reason).toContain('供电不够')
    expect(status.reason).toContain('450W')
  })

  it('手牌禁用原因：非你回合', () => {
    const view = makeView({ activePlayer: 'P2' })
    const it0 = deriveInteractivity(view, [])
    expect(handCardStatus(view, it0, firstHand(view)).reason).toContain('还没轮到你')
  })

  it('手牌禁用原因：扩展槽插满（7/7）', () => {
    const full = Array.from({ length: 7 }, (_, i) => boardUnit({ instanceId: `u${i}` }))
    const view = makeView({ turn: 5, board: full, you: { mana: 500, hand: [handCard()] } })
    const it0 = deriveInteractivity(view, [])
    expect(handCardStatus(view, it0, firstHand(view)).reason).toContain('扩展槽插满了')
  })

  it('攻击禁用原因：召唤失调（入场当回合、无超频）', () => {
    const view = makeView({ turn: 3, board: [boardUnit({ summonedOnTurn: 3, attacksRemaining: 1 })] })
    const it0 = deriveInteractivity(view, [])
    const status = attackStatusOf(view, it0, view.board[0] as BoardUnit)
    expect(status.available).toBe(false)
    expect(status.reason).toContain('召唤失调')
  })

  it('攻击禁用原因：攻击次数用完优先于失调', () => {
    const view = makeView({ turn: 3, board: [boardUnit({ summonedOnTurn: 1, attacksRemaining: 0 })] })
    const it0 = deriveInteractivity(view, [])
    expect(attackStatusOf(view, it0, view.board[0] as BoardUnit).reason).toContain('攻击次数用完')
  })

  it('超频（charge）单位入场当回合可攻击（引擎展开动作即可用）', () => {
    const view = makeView({
      turn: 4,
      board: [boardUnit({ cardId: 'demo-rtx-5090', summonedOnTurn: 4, attacksRemaining: 1, keywords: ['charge'] })],
      you: { mana: 600 },
    })
    const it0 = deriveInteractivity(view, [
      { type: 'ATTACK', playerId: 'P1', attackerId: 'u1', target: { kind: 'hero', playerId: 'P2' } },
    ])
    expect(attackStatusOf(view, it0, view.board[0] as BoardUnit).available).toBe(true)
  })

  it('技能禁用原因：已交（每回合一次）/ 供电不够', () => {
    const view = makeView({ you: { heroPowerUsed: true, mana: 500 } })
    const it0 = deriveInteractivity(view, [])
    expect(heroPowerStatus(view, it0).reason).toContain('已经交了')

    const poor = makeView({ you: { heroPowerUsed: false, mana: 100 } })
    const it1 = deriveInteractivity(poor, [])
    const status = heroPowerStatus(poor, it1)
    expect(status.reason).toContain('供电不够')
    expect(status.reason).toContain('200W')
  })

  it('对局结束：一切可用性为 false', () => {
    const view = makeView({ phase: 'ended' })
    const it0 = deriveInteractivity(view, [])
    expect(it0.yourTurn).toBe(false)
    expect(handCardStatus(view, it0, firstHand(view)).reason).toContain('对局已结束')
  })
})
