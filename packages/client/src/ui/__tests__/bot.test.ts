import { beforeEach, describe, expect, it } from 'vitest'
import type { Action } from '@siliconcard/core'
import { pickBotAction } from '../game/bot'
import { BattleDriver } from '../game/battleDriver'
import { ensureContentRegistered } from '../game/deckLoader'
import { deckOf } from './fixtures'

beforeEach(() => {
  ensureContentRegistered({ cards: {}, decks: {} })
})

describe('简易托管占位（bot）', () => {
  it('合法动作为空 → null', () => {
    expect(pickBotAction([])).toBeNull()
  })

  it('优先出无需目标的牌，目标牌次之', () => {
    const legal: Action[] = [
      { type: 'PLAY_CARD', playerId: 'P2', uid: 'a', target: { kind: 'hero', playerId: 'P1' } },
      { type: 'PLAY_CARD', playerId: 'P2', uid: 'b' },
    ]
    expect(pickBotAction(legal)).toMatchObject({ type: 'PLAY_CARD', uid: 'b' })
  })

  it('攻击优先猜脸（直伤 CPU）', () => {
    const legal: Action[] = [
      { type: 'ATTACK', playerId: 'P2', attackerId: 'u1', target: { kind: 'unit', instanceId: 'u2' } },
      { type: 'ATTACK', playerId: 'P2', attackerId: 'u1', target: { kind: 'hero', playerId: 'P1' } },
    ]
    expect(pickBotAction(legal)).toMatchObject({ type: 'ATTACK', target: { kind: 'hero', playerId: 'P1' } })
  })

  it('只有结束回合可用时返回 END_TURN', () => {
    const legal: Action[] = [
      { type: 'CONCEDE', playerId: 'P2' },
      { type: 'END_TURN', playerId: 'P2' },
    ]
    expect(pickBotAction(legal)).toMatchObject({ type: 'END_TURN' })
  })

  it('整回合推进可终止：重复取动作+结算，最终落在 END_TURN（引擎状态收口）', () => {
    const driver = new BattleDriver('P1')
    driver.start({
      seed: 2024,
      players: [
        { id: 'P1', faction: 'intel', heroName: '你', deck: deckOf('demo-gt-1030') },
        { id: 'P2', faction: 'nvidia', heroName: '对面老哥', deck: deckOf('demo-gt-1030') },
      ],
    })
    driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
    let steps = 0
    while (steps < 60) {
      const action = pickBotAction(driver.legalActionsFor('P2'))
      if (!action) break
      if (action.type === 'END_TURN') {
        driver.dispatch(action)
        break
      }
      driver.dispatch(action)
      steps += 1
    }
    expect(driver.view()?.activePlayer).toBe('P1')
    expect(steps).toBeLessThan(60)
  })
})
