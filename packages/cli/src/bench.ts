/**
 * bench 入口（M4-QA2 平衡管线）——预组卡组批量自对弈跑分（WF-BALANCE 第 1 步）。
 *
 *   yarn workspace @siliconcard/cli bench
 *   yarn workspace @siliconcard/cli bench --games 150 --mirror 50 --json /tmp/balance.json
 *
 * 规模与口径（与 docs/balance 报告一致）：
 * - N 套预组卡组两两循环（含镜像局可关），每配对每方向各 games 局：同一颗种子
 *   A 执 P1 一局 + B 执 P1 一局——引擎 P1 固定先手（FIRST_PLAYER）在配对内
 *   对称抵消，派系胜率不被先手污染；
 * - 派系胜率 = (胜 + 0.5×平) / 局数，仅统计跨卡组对局；镜像局只用于直测
 *   先手偏差与卡牌出场统计，不进强度极差；
 * - 卡牌出场率 / 胜率贡献全部来自引擎公开事件流的 CARD_PLAYED / GAME_END，
 *   双方 AI 只经 createAiPlayer 公开接口决策（runSelfPlayGame 同款护栏）。
 *
 * 输出：stdout 人读表格；--json 指定路径时另写机器可读 JSON（供报告与迭代）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Difficulty } from '@siliconcard/ai'
import { createBalanceEngine, runFactionBalance } from '@siliconcard/ai'
import { loadContent, UsageError, defaultContentDir } from './content'

const BENCH_USAGE = `硅牌 SiliconCard · 预组卡组批量自对弈跑分（M4-QA2 / WF-BALANCE）

用法：
  yarn workspace @siliconcard/cli bench [参数]

参数：
  --games <n>         每配对每方向局数（默认 150；总对局 = 配对数 × 2 × n）
  --mirror <n>        镜像局每方向局数（默认 50；0 = 不跑镜像）
  --difficulty <档>   双方 AI 难度：easy | normal | hard（默认 normal）
  --seed <n>          种子基值（默认 20261006；配对间自动分段隔离）
  --json <路径>       另写机器可读 JSON 到该路径（目录不存在自动创建）
  --help / -h         本帮助
`

interface BenchArgs {
  games: number
  mirror: number
  difficulty: Difficulty
  seed: number
  json?: string
  help: boolean
}

function parseArgs(argv: string[]): BenchArgs {
  const args: BenchArgs = { games: 150, mirror: 50, difficulty: 'normal', seed: 20261006, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new UsageError(`参数 ${arg} 缺少值\n${BENCH_USAGE}`)
      i += 1
      return value
    }
    switch (arg) {
      case '--games':
        args.games = Number(next())
        break
      case '--mirror':
        args.mirror = Number(next())
        break
      case '--difficulty':
        args.difficulty = next() as Difficulty
        break
      case '--seed':
        args.seed = Number(next())
        break
      case '--json':
        args.json = next()
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new UsageError(`未知参数：${arg}\n${BENCH_USAGE}`)
    }
  }
  if (!Number.isInteger(args.games) || args.games <= 0) {
    throw new UsageError(`--games 必须为正整数（收到 ${args.games}）`)
  }
  if (!Number.isInteger(args.mirror) || args.mirror < 0) {
    throw new UsageError(`--mirror 必须为非负整数（收到 ${args.mirror}）`)
  }
  if (!Number.isInteger(args.seed)) throw new UsageError(`--seed 必须为整数（收到 ${args.seed}）`)
  return args
}

const pct = (rate: number): string => `${(rate * 100).toFixed(1)}%`

function main(argv: string[]): void {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(BENCH_USAGE)
    return
  }

  const content = loadContent(defaultContentDir())
  if (content.invalidCards.length > 0) {
    process.stderr.write(`[bench] content 有 ${content.invalidCards.length} 张卡未过结构校验被跳过：${content.invalidCards.map((c) => c.cardId).join('、')}\n`)
  }
  if (content.decks.length < 2) {
    throw new UsageError(`content 预组卡组不足 2 套（实际 ${content.decks.length}），无法两两循环`)
  }

  const decks = content.decks.map((file) => ({
    name: file.id,
    faction: file.faction,
    deck: { cards: file.cards.map((c) => ({ ...c })) },
  }))

  const engine = createBalanceEngine()
  const report = runFactionBalance(engine, {
    decks,
    seedBase: args.seed,
    gamesPerDirection: args.games,
    mirrorGamesPerDirection: args.mirror,
    difficulty: args.difficulty,
  })

  // —— 人读表格（stdout） ——
  const out: string[] = []
  out.push(`硅牌平衡跑分 · ${report.totalGames} 局 · ${Math.round(report.durationMs / 1000)}s · 难度 ${report.difficulty} · 每配对每方向 ${report.gamesPerDirection} 局（镜像 ${report.mirrorGamesPerDirection}） · seedBase ${report.seedBase}`)
  out.push('')
  out.push('派系胜率表（跨卡组对局，先手对称抵消；胜率 = (胜+0.5平)/局）')
  out.push('  卡组                          派系        局数    胜    平    胜率')
  const sorted = [...report.deckStats].sort((x, y) => y.winRate - x.winRate)
  for (const s of sorted) {
    out.push(`  ${s.name.padEnd(28)} ${s.faction.padEnd(10)} ${String(s.games).padStart(5)} ${String(s.wins).padStart(5)} ${String(s.draws).padStart(5)}   ${pct(s.winRate)}`)
  }
  out.push(`  派系胜率极差：${pct(report.spread)}（验收线 <10.0%）`)
  out.push('')
  out.push(`先手（P1）胜率：跨卡组 ${pct(report.firstPlayerWinRate)}；镜像局 ${report.mirrorFirstPlayerWinRate === null ? '未跑' : pct(report.mirrorFirstPlayerWinRate)}`)
  out.push(`健康度：超时 ${report.timeouts} · 非法操作 ${report.illegalActions} · 异常局 ${report.anomalyGames}（要求全 0）`)
  out.push('')
  out.push('配对矩阵（行视角胜率，D=平局率；镜像局不列）')
  const header = '  ' + ' '.padEnd(22) + report.deckStats.map((s) => s.faction.slice(0, 6).padStart(7)).join('')
  out.push(header)
  for (const row of report.deckStats) {
    const cells = report.deckStats.map((col) => {
      if (col.name === row.name) return '     —'
      const pair = report.pairs.find(
        (p) => (p.a === row.name && p.b === col.name) || (p.a === col.name && p.b === row.name),
      )
      if (!pair) return '     ?'
      const mine = pair.a === row.name ? pair.aWins : pair.bWins
      const rate = (mine + 0.5 * pair.draws) / Math.max(pair.games, 1)
      return pct(rate).padStart(7)
    })
    out.push('  ' + row.faction.slice(0, 6).padEnd(22) + cells.join(''))
  }
  out.push('')
  out.push('卡牌出场 / 胜率贡献（playRate = 出局数/所在卡组参与局数；贡献 = 出局时胜率）')
  const cardRows = [...report.cardStats.entries()]
    .map(([cardId, s]) => ({
      cardId,
      playRate: s.deckGames > 0 ? s.gamesWithPlay / s.deckGames : 0,
      winRateWhenPlayed: s.gamesWithPlay > 0 ? s.winsWithPlay / s.gamesWithPlay : 0,
      ...s,
    }))
    .sort((x, y) => y.playRate - x.playRate)
  for (const c of cardRows.slice(0, 15)) {
    out.push(`  高出场  ${c.cardId.padEnd(32)} playRate ${pct(c.playRate).padStart(6)} · playedWin ${pct(c.winRateWhenPlayed).padStart(6)} · plays ${c.plays}`)
  }
  for (const c of cardRows.slice().reverse().slice(0, 10)) {
    out.push(`  低出场  ${c.cardId.padEnd(32)} playRate ${pct(c.playRate).padStart(6)} · playedWin ${pct(c.winRateWhenPlayed).padStart(6)} · plays ${c.plays}`)
  }
  process.stdout.write(out.join('\n') + '\n')

  // —— 机器可读 JSON ——
  if (args.json) {
    const path = resolve(args.json)
    const payload = {
      meta: {
        generatedAt: new Date().toISOString(),
        totalGames: report.totalGames,
        durationMs: report.durationMs,
        gamesPerDirection: report.gamesPerDirection,
        mirrorGamesPerDirection: report.mirrorGamesPerDirection,
        seedBase: report.seedBase,
        difficulty: report.difficulty,
        deckCount: decks.length,
        cardCount: content.cards.length,
      },
      spread: report.spread,
      firstPlayerWinRate: report.firstPlayerWinRate,
      mirrorFirstPlayerWinRate: report.mirrorFirstPlayerWinRate,
      deckStats: report.deckStats,
      pairs: report.pairs.map((p) => ({
        a: p.a,
        b: p.b,
        games: p.games,
        aWins: p.aWins,
        bWins: p.bWins,
        draws: p.draws,
        p1Wins: p.p1Wins,
        timeouts: p.timeouts,
      })),
      cards: cardRows,
      health: {
        timeouts: report.timeouts,
        illegalActions: report.illegalActions,
        anomalyGames: report.anomalyGames,
      },
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(payload, null, 2))
    process.stdout.write(`\nJSON 已写入：${path}\n`)
  }
}

try {
  main(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`[用法错误] ${error.message}\n`)
    process.exit(2)
  }
  process.stderr.write(`[运行错误] ${String(error instanceof Error ? error.stack : error)}\n`)
  process.exit(1)
}
