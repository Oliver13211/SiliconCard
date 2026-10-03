import { describe, expect, it } from 'vitest'
import type { GameEvent } from '@siliconcard/core'
import { eventsToLogEntries, gameEndOf } from '../game/eventLog'
import { makeView } from './fixtures'

const view = makeView()

describe('事件 → 战报（M1-UI1）', () => {
  it('combat 类事件生成梗化战报：质保挡伤 / 疲劳 / 跳闸', () => {
    const events: GameEvent[] = [
      { type: 'DAMAGE_DEALT', source: { kind: 'effect' }, target: { kind: 'unit', instanceId: 'u1' }, amount: 5, remainingHealth: 2, shieldConsumed: true },
      { type: 'DAMAGE_DEALT', source: { kind: 'unit', instanceId: 'u9' }, target: { kind: 'hero', playerId: 'P2' }, amount: 3, remainingHealth: 0 },
      { type: 'FATIGUE', playerId: 'P1', fatigueCount: 2, damage: 2 },
      { type: 'BURN_OUT', playerId: 'P2', lockedMana: 100 },
    ]
    const entries = eventsToLogEntries(view, events)
    expect(entries).toHaveLength(4)
    expect(entries[0]?.text).toContain('三年质保')
    expect(entries[1]?.text).toContain('直接烧了')
    expect(entries[2]?.text).toContain('疲劳')
    expect(entries[3]?.text).toContain('跳闸')
    expect(entries[1]?.tone).toBe('combat')
  })

  it('开局与终局：GAME_START / GAME_END（含平局文案）', () => {
    const events: GameEvent[] = [
      { type: 'GAME_START', seed: 7, firstPlayer: 'P1' },
      { type: 'GAME_END', winner: 'P1', reason: 'health_zero' },
    ]
    const entries = eventsToLogEntries(view, events)
    expect(entries[0]?.text).toContain('对局开始')
    expect(entries[1]?.text).toContain('赢')
    const draw = eventsToLogEntries(view, [{ type: 'GAME_END', winner: null, reason: 'health_zero' }])
    expect(draw[0]?.text).toContain('平局')
  })

  it('gameEndOf：GAME_END 为事件流末尾时提取，否则 null（§9 收口约定）', () => {
    expect(gameEndOf([{ type: 'GAME_END', winner: 'P2', reason: 'concede' }])).toEqual({ winner: 'P2', reason: 'concede' })
    expect(gameEndOf([{ type: 'TURN_END', turn: 2, playerId: 'P1' }])).toBeNull()
  })

  it('未注册定义的卡牌 id 优雅降级（不崩、展示原始 id）', () => {
    const entries = eventsToLogEntries(view, [
      { type: 'CARD_PLAYED', playerId: 'P1', uid: 'x', cardId: 'not-registered-card', cost: 1, target: null },
    ])
    expect(entries[0]?.text).toContain('not-registered-card')
  })
})
