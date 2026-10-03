import { beforeEach, describe, expect, it } from 'vitest'
import { createBot } from '../game/bot'
import { BattleDriver } from '../game/battleDriver'
import { ensureContentRegistered } from '../game/deckLoader'
import { deckOf } from './fixtures'

beforeEach(() => {
  ensureContentRegistered({ cards: {}, decks: {} })
})

function startGame(seed = 2024): BattleDriver {
  const driver = new BattleDriver('P1')
  driver.start({
    seed,
    players: [
      { id: 'P1', faction: 'intel', heroName: '你', deck: deckOf('demo-gt-1030') },
      { id: 'P2', faction: 'nvidia', heroName: '对面老哥', deck: deckOf('demo-gt-1030') },
    ],
  })
  return driver
}

describe('内置人机接线（bot → @siliconcard/ai）', () => {
  it('未开局 → null；未轮到 P2 → null；轮到后才决策', () => {
    const bot = createBot('P2', 42)
    expect(new BattleDriver('P1').aiActionFor('P2', bot)).toBeNull()
    const driver = startGame()
    expect(driver.aiActionFor('P2', bot)).toBeNull() // P1 先手，还没轮到 P2
    driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
    expect(driver.aiActionFor('P2', bot)).not.toBeNull()
  })

  it('决策始终落在合法动作集内', () => {
    const bot = createBot('P2', 42)
    const driver = startGame()
    for (let i = 0; i < 30; i++) {
      const action = driver.aiActionFor('P2', bot)
      if (!action) break
      const legal = driver.legalActionsFor('P2')
      expect(legal).toContainEqual(action)
      driver.dispatch(action)
      if (action.type === 'END_TURN') break
    }
  })

  it('整回合推进可终止：重复取动作+结算，最终落在 END_TURN', () => {
    const bot = createBot('P2', 42)
    const driver = startGame()
    driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
    let steps = 0
    while (steps < 60) {
      const action = driver.aiActionFor('P2', bot)
      if (!action) break
      driver.dispatch(action)
      steps += 1
      if (action.type === 'END_TURN') break
    }
    expect(driver.view()?.activePlayer).toBe('P1')
    expect(steps).toBeLessThan(60)
  })

  it('同 seed 决策序列确定', () => {
    const run = () => {
      const bot = createBot('P2', 2024)
      const driver = startGame()
      const picked: string[] = []
      driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
      for (let i = 0; i < 20; i++) {
        const action = driver.aiActionFor('P2', bot)
        if (!action) break
        picked.push(JSON.stringify(action))
        driver.dispatch(action)
        if (action.type === 'END_TURN') break
      }
      return picked
    }
    expect(run()).toEqual(run())
  })
})
