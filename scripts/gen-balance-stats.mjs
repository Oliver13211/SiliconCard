/**
 * P2-DATA1 全局数值数据生产脚本（qa-balance 维护）。
 *
 * 一行再生成（仓库根执行，幂等可重跑，约 2~4 分钟视机器负载）：
 *
 *   node scripts/gen-balance-stats.mjs
 *
 * 做什么：
 * 1. 调用现成跑分管线 `yarn workspace @siliconcard/cli bench` 做预组自对弈大样本跑分；
 * 2. 把 bench 原始 JSON 聚合成玩家向紧凑统计，写入两份同内容快照：
 *    - packages/client/public/data/balance-stats.json（vite 默认 publicDir，随包发布给数值面板）
 *    - docs/balance/data/p2-data1-seed<seed>.json（文档留档，格式对齐既有 M4-QA2 快照命名）
 *
 * 口径（与 docs/balance/M4-QA2 报告一致）：
 * - 7 套预组两两循环：每配对每方向 150 局（每配对共 300 局，远超 ≥100 局口径；
 *   总量 7000 局，与 M4-QA2 收口快照同规模；重载机器实测仍守住 5 分钟预算），
 *   同种子双向对打，引擎 P1 固定先手在配对内对称抵消；
 * - 镜像局每方向 50 局，只用于卡牌出场统计与先手直测，不进派系强度；
 * - factions[].winRate = (胜 + 0.5×平) / 局数，仅跨卡组对局；
 * - cards[].played = 出局数 / 所在卡组参与局数（含镜像局），cards[].playedWinRate = 出局时胜率；
 * - 胜率/出场率均为 0~1 小数，展示层自行转百分比；
 * - 派系列表来自 packages/content/decks/ 现有 7 预组；卡名从 packages/content/cards/ JSON 读取。
 *
 * 确定性：seed + 参数固定，重复执行统计结果逐位一致（仅 generatedAt / durationMs 刷新）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..')
const CONTENT_DIR = join(REPO_ROOT, 'packages', 'content')
const DECKS_DIR = join(CONTENT_DIR, 'decks')
const CARDS_DIR = join(CONTENT_DIR, 'cards')
const CLIENT_OUT = join(REPO_ROOT, 'packages', 'client', 'public', 'data', 'balance-stats.json')
const DOCS_OUT_DIR = join(REPO_ROOT, 'docs', 'balance', 'data')

// —— 跑分参数（固定值 = 可复现快照；改动即出新快照，需更新文档口径） ——
const SEED = 20261023
const GAMES_PER_DIRECTION = 150 // 每配对每方向局数；每配对合计 300 局（对齐 M4-QA2 快照口径）
const MIRROR_PER_DIRECTION = 50 // 镜像局每方向局数
const DIFFICULTY = 'normal'
const BENCH_TIMEOUT_MS = 8 * 60 * 1000

function fail(message) {
  process.stderr.write(`[gen-balance-stats] ${message}\n`)
  process.exit(1)
}

function listJsonFiles(dir) {
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f))
}

/** 派系预组：id / faction 来自 packages/content/decks/*.json */
function loadDecks() {
  return listJsonFiles(DECKS_DIR).map((path) => {
    const j = JSON.parse(readFileSync(path, 'utf8'))
    return { deckId: j.id, faction: j.faction }
  })
}

/** 卡名映射：cardId → name（卡 JSON 的 id 字段优先，缺失回退文件名） */
function loadCardNames() {
  const names = new Map()
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.json')) {
        const j = JSON.parse(readFileSync(path, 'utf8'))
        const cardId = typeof j.id === 'string' ? j.id : entry.name.replace(/\.json$/, '')
        if (typeof j.name === 'string') names.set(cardId, j.name)
      }
    }
  }
  walk(CARDS_DIR)
  return names
}

/** 跑 bench：原始 JSON 写系统临时目录，仓库零写入 */
function runBench() {
  const rawPath = join(tmpdir(), `siliconcard-bench-p2data1-seed${SEED}.json`)
  const cmd = `yarn workspace @siliconcard/cli bench --games ${GAMES_PER_DIRECTION} --mirror ${MIRROR_PER_DIRECTION} --seed ${SEED} --difficulty ${DIFFICULTY} --json ${JSON.stringify(rawPath)}`
  process.stdout.write(`[gen-balance-stats] 跑分中（预计 2~4 分钟，视机器负载）…\n  ${cmd}\n`)
  const res = spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: BENCH_TIMEOUT_MS })
  if (res.error) fail(`bench 启动失败：${res.error.message}`)
  if (res.status !== 0) fail(`bench 非零退出（code=${res.status}）\n${res.stderr ?? ''}`)
  if (!existsSync(rawPath)) fail(`bench 未产出 JSON：${rawPath}\n${res.stdout ?? ''}`)
  return { raw: JSON.parse(readFileSync(rawPath, 'utf8')), rawPath }
}

/** bench 原始 JSON → 玩家向紧凑统计 */
function aggregate(raw, decks, cardNames) {
  const meta = raw.meta
  const health = raw.health
  if (health.timeouts !== 0 || health.illegalActions !== 0 || health.anomalyGames !== 0) {
    fail(`bench 健康度不达标（要求全 0）：${JSON.stringify(health)}`)
  }

  const winRateByDeck = new Map(raw.deckStats.map((s) => [s.name, s]))
  const factions = decks
    .map(({ deckId, faction }) => {
      const s = winRateByDeck.get(deckId)
      if (!s) fail(`bench 结果缺预组统计：${deckId}`)
      if (s.faction !== faction) fail(`派系不一致：decks/ 说 ${deckId}=${faction}，bench 说 ${s.faction}`)
      return { faction, deckId, winRate: s.winRate, games: s.games }
    })
    .sort((a, b) => b.winRate - a.winRate)

  const cards = raw.cards
    .map((c) => {
      const name = cardNames.get(c.cardId)
      if (!name) fail(`卡名缺失：bench 出现 ${c.cardId} 但 content 卡 JSON 中找不到`)
      return { cardId: c.cardId, name, played: c.playRate, playedWinRate: c.winRateWhenPlayed }
    })
    .sort((a, b) => b.played - a.played)

  return {
    generatedAt: meta.generatedAt,
    gamesTotal: meta.totalGames,
    seed: meta.seedBase,
    difficulty: meta.difficulty,
    gamesPerDirection: meta.gamesPerDirection,
    mirrorGamesPerDirection: meta.mirrorGamesPerDirection,
    spread: raw.spread,
    firstPlayerWinRate: raw.firstPlayerWinRate,
    durationMs: meta.durationMs,
    factions,
    cards,
  }
}

function assertShape(stats) {
  const need = (cond, msg) => { if (!cond) fail(`产物断言失败：${msg}`) }
  need(Number.isInteger(stats.gamesTotal) && stats.gamesTotal > 0, 'gamesTotal 为正整数')
  need(Number.isInteger(stats.seed), 'seed 为整数')
  need(typeof stats.generatedAt === 'string' && !Number.isNaN(Date.parse(stats.generatedAt)), 'generatedAt 为 ISO 时间')
  need(Array.isArray(stats.factions) && stats.factions.length === 7, 'factions 为 7 预组')
  for (const f of stats.factions) {
    need(typeof f.faction === 'string' && typeof f.deckId === 'string', `faction 条目字段齐全（${f.deckId ?? '?'}）`)
    need(typeof f.winRate === 'number' && f.winRate >= 0 && f.winRate <= 1, `winRate 在 [0,1]（${f.deckId}）`)
  }
  need(Array.isArray(stats.cards) && stats.cards.length >= 80, `cards 覆盖预组卡池（实际 ${stats.cards?.length ?? 0}）`)
  for (const c of stats.cards) {
    need(typeof c.cardId === 'string' && typeof c.name === 'string' && c.name.length > 0, `card 条目字段齐全（${c.cardId ?? '?'}）`)
    need(typeof c.played === 'number' && typeof c.playedWinRate === 'number', `played/playedWinRate 为数值（${c.cardId}）`)
  }
}

function writeJson(path, data) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
  process.stdout.write(`[gen-balance-stats] 已写入 ${path}\n`)
}

// —— 主流程 ——
const decks = loadDecks()
if (decks.length < 2) fail(`decks/ 预组不足 2 套（实际 ${decks.length}）`)
const cardNames = loadCardNames()
const { raw, rawPath } = runBench()
const stats = aggregate(raw, decks, cardNames)
assertShape(stats)
writeJson(CLIENT_OUT, stats)
writeJson(join(DOCS_OUT_DIR, `p2-data1-seed${SEED}.json`), stats)
process.stdout.write(`[gen-balance-stats] 完成：${stats.gamesTotal} 局 · ${stats.factions.length} 预组 · ${stats.cards.length} 张卡 · 极差 ${(stats.spread * 100).toFixed(1)}pp · bench 原始数据 ${rawPath}\n`)
