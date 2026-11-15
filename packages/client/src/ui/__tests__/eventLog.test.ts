import { describe, expect, it } from 'vitest'
import type { GameEvent } from '@siliconcard/core'
import { eventsToLogEntries, gameEndOf, groupLogByTurn, LOG_DEFAULT_OPEN_TURNS, type LogEntry } from '../game/eventLog'
import { ensureContentRegistered } from '../game/deckLoader'
import { BattleDriver } from '../game/battleDriver'
import { createBot } from '../game/bot'
import { deckOf, makeView } from './fixtures'

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

describe('P2-UI1：回合标注 + 分组 + 关键事件类别', () => {
  it('条目携带回合号（TURN_START 推进，GAME_START 归开局段）', () => {
    const events: GameEvent[] = [
      { type: 'GAME_START', seed: 7, firstPlayer: 'P1' },
      { type: 'TURN_START', turn: 1, playerId: 'P1', maxMana: 100, drawCount: 1 },
      { type: 'CARD_PLAYED', playerId: 'P1', uid: 'x', cardId: 'demo-gt-1030', cost: 30, target: null },
      { type: 'TURN_END', turn: 1, playerId: 'P1' },
      { type: 'TURN_START', turn: 2, playerId: 'P2', maxMana: 200, drawCount: 1 },
      { type: 'CARD_PLAYED', playerId: 'P2', uid: 'y', cardId: 'demo-gt-1030', cost: 30, target: null },
    ]
    const entries = eventsToLogEntries(view, events)
    expect(entries[0]?.turn).toBe(0)
    expect(entries[1]?.turn).toBe(1)
    expect(entries[1]?.kind).toBe('turn')
    expect(entries[2]?.turn).toBe(1)
    expect(entries[3]?.turn).toBe(1)
    expect(entries[4]?.turn).toBe(2)
    expect(entries[5]?.turn).toBe(2)
  })

  it('关键事件类别：斩杀（英雄归零）/ 质保破 / 跳闸 / 终局', () => {
    const events: GameEvent[] = [
      { type: 'TURN_START', turn: 3, playerId: 'P1', maxMana: 300, drawCount: 1 },
      { type: 'DAMAGE_DEALT', source: { kind: 'effect' }, target: { kind: 'unit', instanceId: 'u1' }, amount: 5, remainingHealth: 2, shieldConsumed: true },
      { type: 'DAMAGE_DEALT', source: { kind: 'unit', instanceId: 'u9' }, target: { kind: 'unit', instanceId: 'u1' }, amount: 5, remainingHealth: 0 },
      { type: 'DAMAGE_DEALT', source: { kind: 'unit', instanceId: 'u9' }, target: { kind: 'hero', playerId: 'P2' }, amount: 30, remainingHealth: 0 },
      { type: 'BURN_OUT', playerId: 'P2', lockedMana: 100 },
      { type: 'GAME_END', winner: 'P1', reason: 'health_zero' },
    ]
    const entries = eventsToLogEntries(view, events)
    expect(entries[1]?.kind).toBe('shield')
    // 单位归零是普通击杀，不标斩杀；英雄（CPU）归零才是斩杀一击
    expect(entries[2]?.kind).toBeUndefined()
    expect(entries[3]?.kind).toBe('lethal')
    expect(entries[4]?.kind).toBe('burn-out')
    expect(entries[5]?.kind).toBe('game-end')
  })

  it('传说卡入场标 legendary（content 注册后按 rarity 判定）', () => {
    ensureContentRegistered()
    const entries = eventsToLogEntries(view, [
      { type: 'TURN_START', turn: 2, playerId: 'P1', maxMana: 200, drawCount: 1 },
      { type: 'CARD_PLAYED', playerId: 'P1', uid: 'x', cardId: 'apple-m1-ultra', cost: 370, target: null },
      { type: 'CARD_PLAYED', playerId: 'P1', uid: 'y', cardId: 'demo-gt-1030', cost: 30, target: null },
    ])
    expect(entries[1]?.kind).toBe('legendary')
    expect(entries[2]?.kind).toBeUndefined()
  })

  it('groupLogByTurn：同回合条目按值归组、标题取自回合头、无标注归开局段', () => {
    const groups = groupLogByTurn([
      { id: 6, text: 'P2 打出「demo」', tone: 'info', turn: 2 },
      { id: 5, text: '—— 第 2 回合 · 对面老哥 的回合 ——', tone: 'system', turn: 2, kind: 'turn' },
      { id: 4, text: '你 回合结束', tone: 'system', turn: 1 },
      { id: 3, text: '—— 第 1 回合 · 你 的回合 ——', tone: 'system', turn: 1, kind: 'turn' },
      { id: 2, text: '遗留旧条目（无回合标注）', tone: 'info' },
      { id: 1, text: '对局开始', tone: 'system', turn: 0 },
    ])
    expect(groups.map((g) => g.turn)).toEqual([2, 1, 0])
    expect(groups.map((g) => g.entries.length)).toEqual([2, 2, 2])
    expect(groups[0]?.title).toBe('第 2 回合 · 对面老哥 的回合')
    expect(groups[2]?.title).toBe('开局')
  })

  it('groupLogByTurn：开局 log 未反转（store 现状）也只出一个回合组（回归：数组顺序不连续）', () => {
    // 数组尾部顺序 = 开局因果序：GAME_START 在前、TS(1) 在后；中间夹着动作批次的 t1 条目
    const groups = groupLogByTurn([
      { id: 4, text: '你 回合结束', tone: 'system', turn: 1 },
      { id: 3, text: '对局开始', tone: 'system', turn: 0 },
      { id: 2, text: '—— 第 1 回合 · 你 的回合 ——', tone: 'system', turn: 1, kind: 'turn' },
    ])
    expect(groups.map((g) => g.turn)).toEqual([1, 0])
    expect(groups[0]?.entries.length).toBe(2)
    expect(groups[0]?.title).toBe('第 1 回合 · 你 的回合')
    expect(groups[1]?.title).toBe('开局')
  })

  it('groupLogByTurn：空战报返回空数组；默认展开常量为 2', () => {
    expect(groupLogByTurn([])).toEqual([])
    expect(LOG_DEFAULT_OPEN_TURNS).toBe(2)
  })

  it('跨批次累积（store 同构）：每个回合只落进一个分组（回归：批次缺 TURN_START 时回合归属漂移）', () => {
    ensureContentRegistered()
    const driver = new BattleDriver('P1')
    const seed = 42
    const opening = driver.start({
      seed,
      players: [
        { id: 'P1', faction: 'neutral', heroName: '你', deck: deckOf('neutral-gt-1030') },
        { id: 'P2', faction: 'nvidia', heroName: '对面老哥', deck: deckOf('neutral-gt-1030') },
      ],
    })
    // 与 gameStore.startBattle 同构：开局 log 按因果序直接落库
    let log: LogEntry[] = [...eventsToLogEntries(opening.view, opening.openingEvents)]
    // 与 gameStore.applyReport 同构：每个动作批次 reverse 后 prepend；我方一律秒结束回合，
    // 对面走托管 bot（每 tick 一个动作 = 一个批次）——最简可复现的跨批次累积
    const bot = createBot('P2', seed)
    let guard = 0
    while (!driver.isEnded() && guard++ < 500) {
      const current = driver.view()
      if (!current) break
      const action =
        current.activePlayer === 'P1' ? ({ type: 'END_TURN', playerId: 'P1' } as const) : driver.aiActionFor('P2', bot)
      if (!action) break
      const report = driver.dispatch(action)
      const entries = eventsToLogEntries(report.view, report.events)
      log = [...[...entries].reverse(), ...log]
    }
    const groups = groupLogByTurn(log)
    const seenTurns = new Set<number>()
    for (const group of groups) {
      expect(seenTurns.has(group.turn)).toBe(false)
      seenTurns.add(group.turn)
    }
    // 回合头标题都带上"回合"语义（不存在裸 fallback 之外的重复组）
    expect(groups.length).toBeGreaterThan(1)
  })
})
