/**
 * 测试支撑：构造最小合法 GameState / PlayerState / BoardUnit 与对局配置的工具。
 * 仅供 core 内部测试使用，不属于对外导出 API。
 */

import { DECK_SIZE, HERO_MAX_HEALTH } from '../constants'
import type { BoardUnit } from '../types/state'
import type { DeckSpec, GameSetup, GameState, PlayerId, PlayerState } from '../types/state'
import { RuleError } from '../engine'

export const TEST_SEED = 20261001

export function makePlayer(id: PlayerId, over: Partial<PlayerState> = {}): PlayerState {
  return {
    id,
    faction: 'neutral',
    heroName: 'test-cpu',
    health: HERO_MAX_HEALTH,
    maxHealth: HERO_MAX_HEALTH,
    armor: 0,
    mana: 0,
    maxMana: 0,
    lockedMana: 0,
    deck: [],
    hand: [],
    graveyard: [],
    fatigue: 0,
    heroPowerUsed: false,
    ...over,
  }
}

export function makeGameState(over: Partial<GameState> = {}): GameState {
  return {
    turn: 1,
    activePlayer: 'P1',
    phase: 'main',
    players: { P1: makePlayer('P1'), P2: makePlayer('P2') },
    board: [],
    nextInstanceId: 1,
    rng: { state: TEST_SEED },
    winner: null,
    endReason: null,
    ...over,
  }
}

let unitCounter = 0

export function makeUnit(
  over: Partial<BoardUnit> & { ownerId: PlayerId; instanceId?: string },
): BoardUnit {
  unitCounter += 1
  return {
    instanceId: over.instanceId ?? `test-u${unitCounter}`,
    cardId: 'test-gpu',
    attack: 1,
    health: 1,
    maxHealth: 1,
    keywords: [],
    summonedOnTurn: 1,
    attacksRemaining: 1,
    attackedThisTurn: false,
    ...over,
  }
}

export function makeDeckSpec(cardId = 'smoke-gpu', count = DECK_SIZE): DeckSpec {
  return { cards: [{ cardId, count }] }
}

/** 30 张互不相同的卡：让洗牌结果可观测（同 seed 同序、异 seed 异序） */
export function makeDistinctDeckSpec(count = DECK_SIZE): DeckSpec {
  return { cards: Array.from({ length: count }, (_, i) => ({ cardId: `card-${i}`, count: 1 })) }
}

export function makeSetup(seed = TEST_SEED, deck: DeckSpec = makeDeckSpec()): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck },
      { id: 'P2', faction: 'amd', deck },
    ],
  }
}

/** 断言式捕获 RuleError，便于对错误码做精确断言 */
export function catchRuleError(fn: () => unknown): RuleError {
  try {
    fn()
  } catch (error) {
    if (error instanceof RuleError) return error
    throw error
  }
  throw new Error('期望抛出 RuleError，但函数正常返回')
}
