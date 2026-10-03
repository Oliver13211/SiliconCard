import { beforeEach, describe, expect, it } from 'vitest'
import { RuleError } from '@siliconcard/core'
import { BattleDriver } from '../game/battleDriver'
import { ensureContentRegistered } from '../game/deckLoader'
import { deckOf } from './fixtures'

// demo 卡池注册（隔离真实 content 卡池落地进度；demo 与正式池同注册表共存）
beforeEach(() => {
  ensureContentRegistered({ cards: {}, decks: {} })
})

/** 固定 30×GT1030：turn1 满供电 100W 必可出两张，行为完全确定 */
function newDriver(): BattleDriver {
  const driver = new BattleDriver('P1')
  driver.start({
    seed: 777,
    players: [
      { id: 'P1', faction: 'neutral', heroName: '你', deck: deckOf('demo-gt-1030') },
      { id: 'P2', faction: 'nvidia', heroName: '对面老哥', deck: deckOf('demo-gt-1030') },
    ],
  })
  return driver
}

describe('BattleDriver（引擎唯一事实源封装）', () => {
  it('开局：viewFor 视角正确，开局事件按 §2.1/§6 合成（GAME_START + TURN_START）', () => {
    const driver = new BattleDriver('P1')
    const opening = driver.start({
      seed: 42,
      players: [
        { id: 'P1', faction: 'neutral', heroName: '你', deck: deckOf('demo-gt-1030') },
        { id: 'P2', faction: 'neutral', heroName: '对面老哥', deck: deckOf('demo-gt-1030') },
      ],
    })
    expect(opening.view.viewer).toBe('P1')
    expect(opening.view.turn).toBe(1)
    expect(opening.view.you.hand).toHaveLength(3)
    expect(opening.openingEvents[0]?.type).toBe('GAME_START')
    expect(opening.openingEvents[1]).toMatchObject({ type: 'TURN_START', turn: 1, playerId: 'P1', drawCount: 0 })
    // 合法动作只属于当前行动玩家，且含 END_TURN
    expect(opening.legalActions.every((a) => a.playerId === 'P1')).toBe(true)
    expect(opening.legalActions.some((a) => a.type === 'END_TURN')).toBe(true)
  })

  it('合法出牌：扣功耗 → 单位入场（视图同步）', () => {
    const driver = newDriver()
    const before = driver.view()
    const uid = before?.you.hand[0]?.uid
    expect(uid).toBeDefined()
    const report = driver.dispatch({ type: 'PLAY_CARD', playerId: 'P1', uid: uid as string })
    expect(report.view.you.mana).toBe(70)
    expect(report.view.board).toHaveLength(1)
    expect(report.view.board[0]?.ownerId).toBe('P1')
    expect(report.events.some((e) => e.type === 'CARD_PLAYED')).toBe(true)
    expect(report.events.some((e) => e.type === 'MINION_SUMMONED')).toBe(true)
  })

  it('非法动作抛 RuleError 且状态不变（CARD_NOT_IN_HAND）', () => {
    const driver = newDriver()
    const manaBefore = driver.view()?.you.mana
    expect(() => driver.dispatch({ type: 'PLAY_CARD', playerId: 'P1', uid: 'nope' })).toThrowError(RuleError)
    expect(driver.view()?.you.mana).toBe(manaBefore)
    try {
      driver.dispatch({ type: 'PLAY_CARD', playerId: 'P1', uid: 'nope' })
    } catch (error) {
      expect((error as RuleError).code).toBe('CARD_NOT_IN_HAND')
    }
  })

  it('END_TURN 轮转：activePlayer 切到 P2，P1 合法动作集清空', () => {
    const driver = newDriver()
    const report = driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
    expect(report.events[0]?.type).toBe('TURN_END')
    expect(report.view.activePlayer).toBe('P2')
    expect(report.legalActions).toEqual([])
    expect(driver.legalActionsFor('P1')).toEqual([])
    // P2 的合法动作集非空（含 END_TURN / CONCEDE）
    const p2 = driver.legalActionsFor('P2')
    expect(p2.some((a) => a.type === 'END_TURN')).toBe(true)
    expect(p2.some((a) => a.type === 'CONCEDE')).toBe(true)
  })

  it('认输收口：GAME_END 为事件流最后一个事件，之后一切动作抛 GAME_ENDED', () => {
    const driver = newDriver()
    driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
    const report = driver.dispatch({ type: 'CONCEDE', playerId: 'P2' })
    const last = report.events.at(-1)
    expect(last).toMatchObject({ type: 'GAME_END', winner: 'P1', reason: 'concede' })
    expect(driver.isEnded()).toBe(true)
    expect(() => driver.dispatch({ type: 'END_TURN', playerId: 'P1' })).toThrowError(RuleError)
  })
})
