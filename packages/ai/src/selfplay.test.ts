/**
 * M1-AI1 核心验收（docs/task-breakdown.md）：
 * 自对弈 100 局零崩溃、零非法操作；Normal 双方胜率均 > 20%（防一边倒）；
 * 附带：同 seed 重放逐字节一致（确定性）、难度梯度（Normal 压制 Easy）、
 * Hard 难度连通性冒烟。
 *
 * 性能口径：100 局须在测试超时内跑完——实测见汇报（单决策只做 1 层模拟，
 * 不做全宽度搜索；本文件实测约 0.5s 量级，timeout 拉到 10 分钟属冗余保险）。
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { createEngine, type Engine } from '@siliconcard/core'
import { registerAiCardPool } from './cardPool'
import { runSelfPlayGame, type SelfPlayResult } from './selfplay'

// vitest 运行在 Node 之上（console / performance 运行时存在）；ai 包 tsconfig
// 刻意不带 DOM/node lib（与 core 同构），此处做最小本地声明供统计输出使用。
declare const console: { info: (...args: unknown[]) => void }
declare const performance: { now: () => number }

beforeAll(() => registerAiCardPool())

const GAME_COUNT = 100
const ACCEPTANCE_TIMEOUT_MS = 600_000 // 实测远低于此值；冗余保险防 CI 抖动

interface SweepStats {
  p1Wins: number
  p2Wins: number
  draws: number
  timeouts: number
  illegalActions: number
  anomalyGames: number
  totalActions: number
  maxTurns: number
}

function sweep(engine: Engine, count: number, sides?: Parameters<typeof runSelfPlayGame>[1]['sides']): {
  results: SelfPlayResult[]
  stats: SweepStats
  durationMs: number
} {
  const results: SelfPlayResult[] = []
  const t0 = performance.now()
  for (let seed = 1; seed <= count; seed++) {
    // 未捕获异常直接外抛 = 「零崩溃」的断言机制
    results.push(runSelfPlayGame(engine, { seed, sides }))
  }
  const durationMs = performance.now() - t0
  const stats: SweepStats = {
    p1Wins: 0,
    p2Wins: 0,
    draws: 0,
    timeouts: 0,
    illegalActions: 0,
    anomalyGames: 0,
    totalActions: 0,
    maxTurns: 0,
  }
  for (const r of results) {
    if (r.winner === 'P1') stats.p1Wins += 1
    else if (r.winner === 'P2') stats.p2Wins += 1
    else stats.draws += 1
    if (r.timedOut) stats.timeouts += 1
    stats.illegalActions += r.illegalActions
    if (r.anomalies.length > 0) stats.anomalyGames += 1
    stats.totalActions += r.actionsApplied
    stats.maxTurns = Math.max(stats.maxTurns, r.turns)
  }
  return { results, stats, durationMs }
}

describe('M1-AI1 验收：Normal 自对弈', () => {
  test(`100 局零崩溃、零非法操作、零异常、双方胜率 > 20%、超时局记录`, () => {
    const engine = createEngine()
    const { results, stats, durationMs } = sweep(engine, GAME_COUNT)

    // —— 逐局硬断言：零非法操作、零异常、无死循环拖局 ——
    for (const r of results) {
      expect(r.illegalActions, `seed ${r.seed} 出现非法操作`).toBe(0)
      expect(r.anomalies, `seed ${r.seed} 出现异常`).toEqual([])
    }

    // —— 收敛性：几乎全部对局正常分出胜负 ——
    expect(stats.draws).toBeLessThanOrEqual(5) // 少数打满上限判平可接受，比例要记录
    expect(stats.timeouts).toBe(stats.draws) // 平局只能来自超时（health_zero/concede 之外无平局源）

    // —— 双方胜率都 > 20%（防一边倒；新手「有来有回」的底线） ——
    expect(stats.p1Wins).toBeGreaterThan(GAME_COUNT * 0.2)
    expect(stats.p2Wins).toBeGreaterThan(GAME_COUNT * 0.2)

    // —— 汇总输出（供人工复核与后续平衡管线参考） ——
    console.info(
      `[M1-AI1] Normal 自对弈 ${GAME_COUNT} 局：P1 ${stats.p1Wins} 胜 / P2 ${stats.p2Wins} 胜 / 平 ${stats.draws}` +
        `（超时 ${stats.timeouts}），非法操作 ${stats.illegalActions}，异常局 ${stats.anomalyGames}` +
        `，平均动作 ${Math.round(stats.totalActions / GAME_COUNT)}，最长 ${stats.maxTurns} 回合` +
        `，总耗时 ${Math.round(durationMs)}ms（约 ${(durationMs / GAME_COUNT).toFixed(1)}ms/局）`,
    )
  }, ACCEPTANCE_TIMEOUT_MS)

  test('确定性：同 seed 重放 → 胜负与逐动作序列完全一致', () => {
    const engine = createEngine()
    const a = runSelfPlayGame(engine, { seed: 20261003 })
    const b = runSelfPlayGame(engine, { seed: 20261003 })
    expect(b.winner).toBe(a.winner)
    expect(b.actionLog).toEqual(a.actionLog)
    expect(b.actionsApplied).toBe(a.actionsApplied)
    expect(b.turns).toBe(a.turns)
  })

  test('镜像对局的行动序列与 seed 相关（异 seed 异对局）', () => {
    const engine = createEngine()
    const a = runSelfPlayGame(engine, { seed: 1 })
    const b = runSelfPlayGame(engine, { seed: 2 })
    expect(b.actionLog).not.toEqual(a.actionLog)
  })
})

describe('难度分级', () => {
  test('Normal 双向压制 Easy（评估精度差异真实生效）', () => {
    const engine = createEngine()
    // 双向打（消除先手优势混淆）：Normal 执 P1 与执 P2 各 40 局
    const normalAsP1 = sweep(engine, 40, { P1: { difficulty: 'normal' }, P2: { difficulty: 'easy' } })
    const normalAsP2 = sweep(engine, 40, { P1: { difficulty: 'easy' }, P2: { difficulty: 'normal' } })
    const normalWins = normalAsP1.stats.p1Wins + normalAsP2.stats.p2Wins
    const easyWins = normalAsP1.stats.p2Wins + normalAsP2.stats.p1Wins
    expect(normalAsP1.stats.illegalActions + normalAsP2.stats.illegalActions).toBe(0)
    expect(normalWins).toBeGreaterThan(easyWins)
    console.info(
      `[M1-AI1] Normal vs Easy（双向 80 局）：Normal ${normalWins} 胜 / Easy ${easyWins} 胜` +
        `，耗时 ${Math.round(normalAsP1.durationMs + normalAsP2.durationMs)}ms`,
    )
  }, ACCEPTANCE_TIMEOUT_MS)

  test('Hard 连通性冒烟：与 Normal 互打 20 局全程干净（不强断言强度）', () => {
    const engine = createEngine()
    const { stats } = sweep(engine, 20, { P1: { difficulty: 'hard' }, P2: { difficulty: 'normal' } })
    expect(stats.illegalActions).toBe(0)
    expect(stats.anomalyGames).toBe(0)
    console.info(
      `[M1-AI1] Hard vs Normal（20 局）：Hard ${stats.p1Wins} 胜 / Normal ${stats.p2Wins} 胜 / 平 ${stats.draws}`,
    )
  }, ACCEPTANCE_TIMEOUT_MS)
})
