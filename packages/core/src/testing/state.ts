/**
 * 测试支撑：构造最小合法 GameState / PlayerState / BoardUnit 与对局配置的工具。
 * 仅供 core 内部测试使用，不属于对外导出 API。
 *
 * 模块加载即注册默认测试卡（M1-ENG2 起 initGame 校验卡组内 cardId 必须已注册且
 * 定义合法）：smoke-gpu（makeDeckSpec 缺省卡）与 card-0..29（makeDistinctDeckSpec）。
 * 测试专属卡牌在各测试文件内另行 registerCardDefinitions（vitest 文件间隔离）。
 */

import { DECK_SIZE, HERO_MAX_HEALTH } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { BoardUnit } from '../types/state'
import type { DeckSpec, GameSetup, GameState, PlayerId, PlayerState } from '../types/state'
import { RuleError } from '../engine'
import { registerCardDefinitions } from '../engine/registry'

export const TEST_SEED = 20261001

/** makeDeckSpec 的缺省测试卡（手牌测试惯用 cost 100 与其保持一致） */
export const SMOKE_GPU: CardDefinition = {
  id: 'smoke-gpu',
  name: '烟雾测试卡',
  faction: 'neutral',
  type: 'gpu',
  cost: 100,
  attack: 1,
  health: 1,
  rarity: 'starter',
}

const DISTINCT_TEST_CARDS: CardDefinition[] = Array.from({ length: DECK_SIZE }, (_, i) => ({
  id: `card-${i}`,
  name: `洗牌测试卡 ${i}`,
  faction: 'neutral',
  type: 'gpu',
  cost: 1,
  attack: 1,
  health: 1,
}))

registerCardDefinitions([SMOKE_GPU, ...DISTINCT_TEST_CARDS])

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
