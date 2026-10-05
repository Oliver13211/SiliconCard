/**
 * 卡组配对批量对局矩阵（M4-QA2 平衡管线核心）。
 *
 * 在 runSelfPlayGame（单局驱动器，含三重护栏）之上做两层批量：
 * 1. runDeckMatchup：两张卡组固定配对，双向对称跑分——每颗种子先 A 执 P1、
 *    再 B 执 P1 各一局，把引擎 P1 固定先手（FIRST_PLAYER）从卡组强度里对称抵消；
 * 2. runFactionBalance：全部卡组两两循环（round-robin），聚合出
 *    派系胜率表（极差 spread）、先手胜率口径、CARD_PLAYED 级别的卡牌
 *    出场率 / 胜率贡献——WF-BALANCE 第 1 步的数据源。
 *
 * 纪律：对局全程只经 runSelfPlayGame → createAiPlayer（getLegalActions +
 * viewFor 公开接口），本模块不读完整 GameState、不复刻效果语义；
 * 卡牌统计全部来自引擎事件流的 CARD_PLAYED / GAME_END。
 */

import type { DeckSpec, FactionId } from '@siliconcard/core'
import { createEngine, type Engine } from '@siliconcard/core'
import type { Difficulty } from './player'
import { runSelfPlayGame, type SelfPlayResult } from './selfplay'

/** 平衡管线维度的卡组（name 是报告里的主键，如 'nvidia-flagship-faith'） */
export interface BalanceDeck {
  name: string
  faction: FactionId
  deck: DeckSpec
}

/** 单卡出场 / 胜率贡献统计（对局粒度，同局重复打出只计一次 gamesWithPlay） */
export interface CardPlayStat {
  /** 被打出总次数（含同名两张） */
  plays: number
  /** 至少打出一次的对局数（按执方计） */
  gamesWithPlay: number
  /** 打出该卡的执方获胜的对局数（平局不计） */
  winsWithPlay: number
}

export interface DeckMatchupConfig {
  a: BalanceDeck
  b: BalanceDeck
  /** 种子基值：第 i 轮两局（A 先 / B 先）都用 seedBase + i */
  seedBase: number
  /** 单方向局数：A 执 P1 跑 n 局、B 执 P1 也跑 n 局，总 2n 局 */
  gamesPerDirection: number
  difficulty?: Difficulty
  maxActions?: number
  /** 收集 CARD_PLAYED 级卡牌统计（缺省 false） */
  collectCardStats?: boolean
}

export interface DeckMatchupResult {
  a: string
  b: string
  games: number
  aWins: number
  bWins: number
  draws: number
  /** 先手位（P1）胜场（先手偏差口径用） */
  p1Wins: number
  timeouts: number
  illegalActions: number
  anomalyGames: number
  totalTurns: number
  durationMs: number
  /** 仅 collectCardStats 时非空；键为 cardId */
  cardStats: Map<string, CardPlayStat> | null
}

export interface FactionBalanceConfig {
  decks: BalanceDeck[]
  seedBase: number
  /** 每个非镜像配对的单方向局数（总对局 = 配对数 × 2 × gamesPerDirection） */
  gamesPerDirection: number
  difficulty?: Difficulty
  maxActions?: number
  /** 镜像局（同卡组互打）单方向局数；0 = 不跑。镜像只测先手偏差与卡牌出场，不进派系强度极差 */
  mirrorGamesPerDirection?: number
}

export interface DeckOverallStat {
  name: string
  faction: FactionId
  /** 跨卡组对局数（镜像不计） */
  games: number
  wins: number
  draws: number
  /** (wins + 0.5×draws) / games */
  winRate: number
}

export interface FactionBalanceReport {
  totalGames: number
  durationMs: number
  gamesPerDirection: number
  mirrorGamesPerDirection: number
  seedBase: number
  difficulty: Difficulty
  /** 配对级明细（含镜像局，镜像局 a===b） */
  pairs: DeckMatchupResult[]
  /** 派系强度表（仅跨卡组对局，按 config.decks 顺序） */
  deckStats: DeckOverallStat[]
  /** 派系胜率极差 max-min（小数，报告里 ×100%） */
  spread: number
  /** 全部跨卡组对局的先手（P1）胜率，平局按 0.5 计 */
  firstPlayerWinRate: number
  /** 镜像局先手胜率（未跑镜像为 null） */
  mirrorFirstPlayerWinRate: number | null
  /** 全卡池卡牌统计；deckGames = 该卡所在卡组的对局参与数（镜像局参与计 2） */
  cardStats: Map<string, CardPlayStat & { deckGames: number }>
  timeouts: number
  illegalActions: number
  anomalyGames: number
}

/** Date.now 而非 performance.now：ai 包 tsconfig 无 node/DOM lib（与 selfplay.test 本地声明同因） */
const now = (): number => Date.now()

function emptyStat(): CardPlayStat {
  return { plays: 0, gamesWithPlay: 0, winsWithPlay: 0 }
}

/**
 * 从单局结果聚合卡牌统计：CARD_PLAYED 按 playerId 归到对应卡组，
 * 同局同卡去重计 gamesWithPlay，执方获胜才计 winsWithPlay。
 */
function tallyCardStats(
  result: SelfPlayResult,
  cardStats: Map<string, CardPlayStat>,
  winnerIsPlayer: (playerId: 'P1' | 'P2') => boolean,
): void {
  if (!result.events) return
  const playsByPlayer: Record<'P1' | 'P2', Map<string, number>> = {
    P1: new Map(),
    P2: new Map(),
  }
  for (const event of result.events) {
    if (event.type !== 'CARD_PLAYED') continue
    if (event.playerId !== 'P1' && event.playerId !== 'P2') continue
    const perPlayer = playsByPlayer[event.playerId]
    perPlayer.set(event.cardId, (perPlayer.get(event.cardId) ?? 0) + 1)
  }
  for (const playerId of ['P1', 'P2'] as const) {
    const won = winnerIsPlayer(playerId)
    for (const [cardId, plays] of playsByPlayer[playerId]) {
      let stat = cardStats.get(cardId)
      if (!stat) {
        stat = emptyStat()
        cardStats.set(cardId, stat)
      }
      stat.plays += plays
      stat.gamesWithPlay += 1
      if (won) stat.winsWithPlay += 1
    }
  }
}

/** 两张卡组双向对称对跑：每颗种子 A 先手一局 + B 先手一局 */
export function runDeckMatchup(engine: Engine, config: DeckMatchupConfig): DeckMatchupResult {
  const { a, b } = config
  const collectCardStats = config.collectCardStats ?? false
  const t0 = now()

  const result: DeckMatchupResult = {
    a: a.name,
    b: b.name,
    games: 0,
    aWins: 0,
    bWins: 0,
    draws: 0,
    p1Wins: 0,
    timeouts: 0,
    illegalActions: 0,
    anomalyGames: 0,
    totalTurns: 0,
    durationMs: 0,
    cardStats: collectCardStats ? new Map() : null,
  }

  const playOne = (seed: number, first: BalanceDeck, second: BalanceDeck): SelfPlayResult =>
    runSelfPlayGame(engine, {
      seed,
      maxActions: config.maxActions,
      collectEvents: collectCardStats,
      sides: {
        P1: { faction: first.faction, deck: first.deck, difficulty: config.difficulty },
        P2: { faction: second.faction, deck: second.deck, difficulty: config.difficulty },
      },
    })

  const tally = (game: SelfPlayResult, first: BalanceDeck, second: BalanceDeck): void => {
    result.games += 1
    if (game.winner === 'P1') result.p1Wins += 1
    if (game.winner === 'P1' || game.winner === 'P2') {
      const winnerDeck = game.winner === 'P1' ? first : second
      if (winnerDeck === a) result.aWins += 1
      else result.bWins += 1
    } else {
      result.draws += 1
    }
    if (game.timedOut) result.timeouts += 1
    result.illegalActions += game.illegalActions
    if (game.anomalies.length > 0) result.anomalyGames += 1
    result.totalTurns += game.turns
    if (result.cardStats) {
      tallyCardStats(game, result.cardStats, (p) => game.winner === p)
    }
  }

  for (let i = 0; i < config.gamesPerDirection; i++) {
    const seed = config.seedBase + i
    tally(playOne(seed, a, b), a, b) // A 执先手
    tally(playOne(seed, b, a), b, a) // B 执先手（对称抵消 FIRST_PLAYER 偏差）
  }

  result.durationMs = now() - t0
  return result
}

/** 全卡组两两循环跑分并聚合（WF-BALANCE 第 1 步：平衡报告数据源） */
export function runFactionBalance(engine: Engine, config: FactionBalanceConfig): FactionBalanceReport {
  const t0 = now()
  const mirrorGamesPerDirection = config.mirrorGamesPerDirection ?? 0
  const collectCardStats = true
  const pairs: DeckMatchupResult[] = []

  const gamesOfDeck = new Map<string, number>() // 各卡组对局参与数（跨卡组各 1/局；镜像局 +2/局）
  const aggregate = new Map<string, CardPlayStat & { deckGames: number }>()
  const deckStats = new Map<string, DeckOverallStat>()
  for (const d of config.decks) {
    deckStats.set(d.name, { name: d.name, faction: d.faction, games: 0, wins: 0, draws: 0, winRate: 0 })
  }

  const absorb = (pair: DeckMatchupResult): void => {
    pairs.push(pair)
    const isMirror = pair.a === pair.b
    const statOf = (name: string): DeckOverallStat | undefined => deckStats.get(name)
    const mergeCards = (from: Map<string, CardPlayStat>): void => {
      for (const [cardId, stat] of from) {
        let dst = aggregate.get(cardId)
        if (!dst) {
          dst = { ...stat, deckGames: 0 }
          aggregate.set(cardId, dst)
        } else {
          dst.plays += stat.plays
          dst.gamesWithPlay += stat.gamesWithPlay
          dst.winsWithPlay += stat.winsWithPlay
        }
      }
    }
    for (const name of new Set([pair.a, pair.b])) {
      gamesOfDeck.set(name, (gamesOfDeck.get(name) ?? 0) + (isMirror ? 2 : 1) * pair.games)
    }
    if (!isMirror) {
      const sa = statOf(pair.a)
      const sb = statOf(pair.b)
      if (sa) {
        sa.games += pair.games
        sa.wins += pair.aWins
        sa.draws += pair.draws
      }
      if (sb) {
        sb.games += pair.games
        sb.wins += pair.bWins
        sb.draws += pair.draws
      }
    }
    mergeCards(pair.cardStats ?? new Map())
  }

  let crossGames = 0
  let crossP1Wins = 0 // 胜负局中先手取胜数（平局各计 0.5，见累计口径）
  let crossDraws = 0
  let mirrorGames = 0
  let mirrorP1Wins = 0
  let mirrorDraws = 0
  let timeouts = 0
  let illegalActions = 0
  let anomalyGames = 0

  for (let i = 0; i < config.decks.length; i++) {
    for (let j = i; j < config.decks.length; j++) {
      const isMirror = i === j
      const perDirection = isMirror ? mirrorGamesPerDirection : config.gamesPerDirection
      if (perDirection <= 0) continue
      const a = config.decks[i]
      const b = config.decks[j]
      if (!a || !b) continue
      // 配对间种子段隔离：i*8+j 保证 uint32 内互异（decks ≤ 8、每段 ≤ 10^6 + 局数）
      const pairSeedBase = config.seedBase + (i * 8 + j) * 1_000_000
      const pair = runDeckMatchup(engine, {
        a,
        b,
        seedBase: pairSeedBase,
        gamesPerDirection: perDirection,
        difficulty: config.difficulty,
        maxActions: config.maxActions,
        collectCardStats,
      })
      absorb(pair)
      if (isMirror) {
        mirrorGames += pair.games
        mirrorP1Wins += pair.p1Wins
        mirrorDraws += pair.draws
      } else {
        crossGames += pair.games
        crossP1Wins += pair.p1Wins
        crossDraws += pair.draws
      }
      timeouts += pair.timeouts
      illegalActions += pair.illegalActions
      anomalyGames += pair.anomalyGames
    }
  }

  for (const stat of deckStats.values()) {
    stat.winRate = stat.games > 0 ? (stat.wins + 0.5 * stat.draws) / stat.games : 0
  }
  for (const [cardId, stat] of aggregate) {
    const decksContainingCard = config.decks.filter((d) =>
      d.deck.cards.some((entry) => entry.cardId === cardId),
    )
    stat.deckGames = decksContainingCard.reduce((sum, d) => sum + (gamesOfDeck.get(d.name) ?? 0), 0)
    if (decksContainingCard.length === 0 && stat.plays > 0) stat.deckGames = crossGames // 兜底：token 等场外来源
  }

  const rates = [...deckStats.values()].filter((s) => s.games > 0).map((s) => s.winRate)
  const deckList = [...deckStats.values()]

  return {
    totalGames: pairs.reduce((sum, p) => sum + p.games, 0),
    durationMs: now() - t0,
    gamesPerDirection: config.gamesPerDirection,
    mirrorGamesPerDirection,
    seedBase: config.seedBase,
    difficulty: config.difficulty ?? 'normal',
    pairs,
    deckStats: deckList,
    spread: rates.length > 0 ? Math.max(...rates) - Math.min(...rates) : 0,
    firstPlayerWinRate: crossGames > 0 ? (crossP1Wins + 0.5 * crossDraws) / crossGames : 0,
    mirrorFirstPlayerWinRate: mirrorGames > 0 ? (mirrorP1Wins + 0.5 * mirrorDraws) / mirrorGames : null,
    cardStats: aggregate,
    timeouts,
    illegalActions,
    anomalyGames,
  }
}

/** 平衡跑分默认引擎工厂（宿主负责先 registerCardDefinitions 注入卡池） */
export function createBalanceEngine(): Engine {
  return createEngine()
}
