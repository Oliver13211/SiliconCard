/**
 * 白名单门控单测（P2-EDU1 定向测试）—— 纯函数：StepGate × view → 放行/拦截。
 */

import { describe, expect, it } from 'vitest'
import type { Action, HandCard, PlayerView } from '@siliconcard/core'
import {
  cardIdByInstance,
  cardIdByUid,
  gateAttack,
  gateConcede,
  gateEndTurn,
  gateHeroPower,
  gatePlay,
  gateTarget,
  narrowActionTargets,
} from '../gates'
import type { StepGate } from '../types'

const handCard = (uid: string, cardId: string, cost = 100): HandCard => ({ uid, cardId, cost })

const boardUnit = (instanceId: string, cardId: string, ownerId: 'P1' | 'P2') => ({
  instanceId,
  cardId,
  ownerId,
  attack: 2,
  health: 2,
  maxHealth: 2,
  keywords: [],
  summonedOnTurn: 1,
  attacksRemaining: 1,
  attackedThisTurn: false,
})

function mockView(
  overrides: { hand?: readonly HandCard[]; mana?: number; heroPowerUsed?: boolean; boardUnits?: ReturnType<typeof boardUnit>[] } = {},
): PlayerView {
  const hand = overrides.hand ?? [handCard('h1', 'amd-rx-550'), handCard('h2', 'intel-arc-a380')]
  const board = overrides.boardUnits ?? [boardUnit('m1', 'amd-rx-550', 'P1'), boardUnit('e1', 'intel-arc-a380', 'P2')]
  const mana = overrides.mana ?? 200
  const heroPowerUsed = overrides.heroPowerUsed ?? false
  const you = {
    id: 'P1' as const,
    faction: 'neutral',
    heroName: '你',
    health: 30,
    maxHealth: 30,
    armor: 0,
    mana,
    maxMana: 200,
    handSize: hand.length,
    deckSize: 27,
    graveyardSize: 0,
    fatigue: 0,
    heroPowerUsed,
    hand,
  }
  const opponent = {
    id: 'P2' as const,
    faction: 'neutral',
    heroName: '教学靶机',
    health: 30,
    maxHealth: 30,
    armor: 0,
    mana: 100,
    maxMana: 100,
    handSize: 4,
    deckSize: 26,
    graveyardSize: 0,
    fatigue: 0,
    heroPowerUsed: false,
  }
  return {
    viewer: 'P1',
    turn: 3,
    phase: 'main',
    activePlayer: 'P1',
    winner: null,
    you,
    opponent,
    board,
  }
}

describe('出牌门控', () => {
  it('白名单内放行', () => {
    const gate: StepGate = { allowPlayCardIds: ['amd-rx-550'] }
    expect(gatePlay(gate, mockView(), 'h1').allowed).toBe(true)
  })

  it('白名单外拦截并带教学文案', () => {
    const gate: StepGate = { allowPlayCardIds: ['amd-rx-550'], blockCopy: '先专心上 RX 550' }
    const decision = gatePlay(gate, mockView(), 'h2')
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('先专心上 RX 550')
  })

  it("缺省/'all' 全放行；uid 归属不明 fail-open", () => {
    expect(gatePlay(undefined, mockView(), 'h2').allowed).toBe(true)
    expect(gatePlay({ allowPlayCardIds: 'all' }, mockView(), 'h2').allowed).toBe(true)
    expect(gatePlay({ allowPlayCardIds: ['amd-rx-550'] }, mockView(), 'ghost-uid').allowed).toBe(true)
  })
})

describe('攻击门控', () => {
  it('按攻击者 cardId 归属', () => {
    expect(gateAttack({ allowAttackCardIds: ['amd-rx-550'] }, mockView(), 'm1').allowed).toBe(true)
    // 场上有归属的攻击者，cardId 不在白名单 → 拦截
    const decision = gateAttack({ allowAttackCardIds: ['amd-rx-550'] }, mockView(), 'e1')
    expect(decision.allowed).toBe(false)
    // 场上不存在的实例（归属不明）→ fail-open，不制造假死局
    expect(gateAttack({ allowAttackCardIds: ['amd-rx-550'] }, mockView(), 'm-other').allowed).toBe(true)
  })

  it('空数组 = 本步禁攻', () => {
    expect(gateAttack({ allowAttackCardIds: [] }, mockView(), 'm1').allowed).toBe(false)
  })
})

describe('技能 / 结束回合 / 目标 / 认输门控', () => {
  it('技能：缺省放行，显式 false 拦截', () => {
    expect(gateHeroPower(undefined).allowed).toBe(true)
    const decision = gateHeroPower({ allowHeroPower: false })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBeTruthy()
  })

  it('结束回合：谓词收得到 (view, events)', () => {
    const gate: StepGate = { allowEndTurn: (view, events) => view.you.mana < 200 && events.length === 0 }
    expect(gateEndTurn(gate, mockView({ mana: 100 })).allowed).toBe(true)
    expect(gateEndTurn(gate, mockView({ mana: 200 })).allowed).toBe(false)
    expect(gateEndTurn(gate, mockView({ mana: 100 }), [{ type: 'TURN_END', turn: 3, playerId: 'P1' }]).allowed).toBe(false)
  })

  it('目标：allowTarget 收窄', () => {
    const gate: StepGate = { allowTarget: (target) => target.kind === 'unit' && target.instanceId === 'm1' }
    expect(gateTarget(gate, mockView(), { kind: 'unit', instanceId: 'm1' }).allowed).toBe(true)
    expect(gateTarget(gate, mockView(), { kind: 'hero', playerId: 'P2' }).allowed).toBe(false)
  })

  it('认输：一律拦截（教程失败走重试）', () => {
    const decision = gateConcede()
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('重新来过')
  })
})

describe('legalActions 目标收窄投影', () => {
  const view = mockView()
  const actions: Action[] = [
    { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'unit', instanceId: 'm1' } },
    { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'unit', instanceId: 'e1' } },
    { type: 'ATTACK', playerId: 'P1', attackerId: 'm1', target: { kind: 'unit', instanceId: 'e1' } },
    { type: 'END_TURN', playerId: 'P1' },
  ]

  it('无 allowTarget 时原样返回', () => {
    expect(narrowActionTargets(undefined, actions, view)).toHaveLength(4)
  })

  it('allowTarget 只保留白名单目标（动作粒度 = 每个目标一个动作；END_TURN 不受影响）', () => {
    const narrowed = narrowActionTargets(
      { allowTarget: (target) => target.kind === 'unit' && target.instanceId === 'm1' },
      actions,
      view,
    )
    expect(narrowed).toHaveLength(2)
    expect(narrowed[0]).toMatchObject({ type: 'PLAY_CARD', target: { instanceId: 'm1' } })
    expect(narrowed[1]).toMatchObject({ type: 'END_TURN' })
  })
})

describe('视图投影辅助', () => {
  const view = mockView()
  it('uid → cardId', () => {
    expect(cardIdByUid(view, 'h1')).toBe('amd-rx-550')
    expect(cardIdByUid(view, 'nope')).toBeNull()
  })
  it('instanceId → cardId', () => {
    expect(cardIdByInstance(view, 'e1')).toBe('intel-arc-a380')
    expect(cardIdByInstance(view, 'gone')).toBeNull()
  })
})
