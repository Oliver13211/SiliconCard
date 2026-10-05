/**
 * M4-QA2 平衡管线单测 —— matchup 模块（runDeckMatchup / runFactionBalance）。
 *
 * 验收口径：
 * - 双向对称：同配对 A 先 / B 先各半，先手位胜负在配对内对称抵消——
 *   对称卡组（同一 DeckSpec）的镜像对局两侧胜率应相等；
 * - 聚合正确性：runFactionBalance 的配对矩阵 / 卡组胜率 / spread / 先手口径
 *   与配对明细一致（守恒断言）；
 * - 卡牌统计：CARD_PLAYED 事件归因到执方，出场数与对局数守恒；
 * - 健康度：AI 只走公开接口，零非法操作、零异常。
 *
 * 性能口径：合成卡池 ~4-6ms/局，本文件 ≤ 150 局，秒级完成。
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { createEngine, type Engine } from '@siliconcard/core'
import { AI_CARD_POOL, makeAiDeckSpec, registerAiCardPool } from './cardPool'
import { runDeckMatchup, runFactionBalance, type BalanceDeck } from './matchup'

beforeAll(() => registerAiCardPool())

const GAMES_PER_DIRECTION = 8

function makeEngine(): Engine {
  registerAiCardPool() // 幂等
  return createEngine()
}

const syntheticDeck = (): BalanceDeck => ({
  name: 'synthetic',
  faction: 'neutral',
  deck: makeAiDeckSpec(),
})

describe('runDeckMatchup 双向对称', () => {
  test('镜像对局（同卡组互打）先手位胜率两侧守恒、零非法零异常', () => {
    const engine = makeEngine()
    const deck = syntheticDeck()
    const result = runDeckMatchup(engine, {
      a: deck,
      b: { ...deck, name: 'synthetic-mirror' },
      seedBase: 9_000_001,
      gamesPerDirection: GAMES_PER_DIRECTION,
    })

    // 总局数 = 每方向局数 × 2（A 先 + B 先）
    expect(result.games).toBe(GAMES_PER_DIRECTION * 2)
    // 镜像卡组完全相同 → 两侧总胜场必相等（先手优势被双向各半抵消）
    expect(result.aWins).toBe(result.bWins)
    expect(result.aWins + result.bWins + result.draws).toBe(result.games)
    expect(result.illegalActions).toBe(0)
    expect(result.anomalyGames).toBe(0)
    expect(result.timeouts).toBe(0)
    expect(result.durationMs).toBeGreaterThan(0)
  })
})

describe('runFactionBalance 聚合', () => {
  test('三卡组循环：胜率守恒、spread 与明细一致、卡牌统计归因正确', () => {
    const engine = makeEngine()
    const cardIds = AI_CARD_POOL.filter((card) => card.id !== 'ai-scrap').map((card) => card.id)
    const deckOf = (name: string, faction: 'nvidia' | 'amd' | 'intel'): BalanceDeck => ({
      name,
      faction,
      deck: { cards: cardIds.map((cardId) => ({ cardId, count: 2 })) },
    })
    const decks = [deckOf('nvidia', 'nvidia'), deckOf('amd', 'amd'), deckOf('intel', 'intel')]

    const report = runFactionBalance(engine, {
      decks,
      seedBase: 9_100_001,
      gamesPerDirection: GAMES_PER_DIRECTION,
      mirrorGamesPerDirection: 2,
    })

    // 局数守恒：3 跨卡组配对 × 2 方向 × n + 3 镜像配对 × 2 方向 × m
    const crossGames = 3 * 2 * GAMES_PER_DIRECTION
    const mirrorGames = 3 * 2 * 2
    expect(report.totalGames).toBe(crossGames + mirrorGames)
    expect(report.pairs).toHaveLength(6)

    // 每卡组跨卡组局数 = 2 配对 × 2 方向 × n；胜负平与配对明细守恒
    for (const stat of report.deckStats) {
      expect(stat.games).toBe(2 * 2 * GAMES_PER_DIRECTION)
      const detail = report.pairs
        .filter((pair) => pair.a !== pair.b && (pair.a === stat.name || pair.b === stat.name))
        .map((pair) => (pair.a === stat.name ? pair.aWins : pair.bWins))
        .reduce((sum, wins) => sum + wins, 0)
      expect(stat.wins).toBe(detail)
      expect(stat.winRate).toBeCloseTo((stat.wins + 0.5 * stat.draws) / stat.games, 10)
    }

    // spread = 最大 − 最小胜率
    const rates = report.deckStats.map((stat) => stat.winRate)
    expect(report.spread).toBeCloseTo(Math.max(...rates) - Math.min(...rates), 10)

    // 先手口径：跨卡组先手胜率 ∈ [0, 1]，镜像先手胜率已测（m > 0）
    expect(report.firstPlayerWinRate).toBeGreaterThanOrEqual(0)
    expect(report.firstPlayerWinRate).toBeLessThanOrEqual(1)
    expect(report.mirrorFirstPlayerWinRate).not.toBeNull()

    // 卡牌统计：合成卡组 30 张全同 → 每张卡 deckGames = 全部卡组参与局数
    for (const [cardId, stat] of report.cardStats) {
      expect(stat.plays).toBeGreaterThan(0)
      expect(stat.gamesWithPlay).toBeLessThanOrEqual(stat.deckGames)
      expect(stat.winsWithPlay).toBeLessThanOrEqual(stat.gamesWithPlay)
      void cardId
    }

    // 健康度：AI 只走公开接口，零非法、零异常
    expect(report.illegalActions).toBe(0)
    expect(report.anomalyGames).toBe(0)
  })

  test('镜像局不计入派系强度（deckStats.games 只含跨卡组对局）', () => {
    const engine = makeEngine()
    const deck = syntheticDeck()
    const report = runFactionBalance(engine, {
      decks: [deck, { ...deck, name: 'copy' }],
      seedBase: 9_200_001,
      gamesPerDirection: GAMES_PER_DIRECTION,
      mirrorGamesPerDirection: 3,
    })
    const stats = report.deckStats.filter((stat) => stat.games > 0)
    expect(stats).toHaveLength(2)
    for (const stat of stats) {
      expect(stat.games).toBe(2 * GAMES_PER_DIRECTION) // 仅跨卡组对局
    }
  })
})
