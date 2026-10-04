/**
 * demo 对局循环（M3-AGT3）——双 AI 自对弈 + 事件流逐行输出。
 * 与入口 demo.ts 分离：本文件被 vitest 直接 import 做确定性回归。
 */

import { createAiPlayer, deriveAiSeed, type AiPlayer, type Difficulty } from '@siliconcard/ai'
import type { Action, DeckSpec, EngineResult, PlayerId } from '@siliconcard/core'
import { createEngine } from '@siliconcard/core'
import type { DeckChoice } from './content'
import { describeAction, eventToLine } from './describe'

export interface DemoConfig {
  seed: number
  difficulty: Difficulty
  p1Deck: DeckChoice
  p2Deck: DeckChoice
  /** true=逐行输出引擎原始事件 JSON；false=人话解说（默认） */
  json?: boolean
  /** 动作数上限护栏（防理论死循环拖垮观战） */
  maxActions?: number
  write: (line: string) => void
}

export interface DemoResult {
  seed: number
  winner: PlayerId | null
  endReason: 'health_zero' | 'concede' | null
  turns: number
  actionsApplied: number
  anomalies: string[]
}

/**
 * 跑一场双 AI 演示对局并流式输出事件。护栏与 ai 包 selfplay 同构：
 * AI 空返回/越权/被拒 → 记入 anomalies 并以 END_TURN 兜底，绝不无声吞错。
 */
export function runDemoMatch(config: DemoConfig): DemoResult {
  const engine = createEngine()
  const write = config.write
  let state = engine.initGame({
    seed: config.seed,
    players: [
      { id: 'P1', faction: config.p1Deck.faction, deck: config.p1Deck.spec as DeckSpec },
      { id: 'P2', faction: config.p2Deck.faction, deck: config.p2Deck.spec as DeckSpec },
    ],
  })
  const ais: Record<PlayerId, AiPlayer> = {
    P1: createAiPlayer({ playerId: 'P1', difficulty: config.difficulty, seed: deriveAiSeed(config.seed, 'P1') }),
    P2: createAiPlayer({ playerId: 'P2', difficulty: config.difficulty, seed: deriveAiSeed(config.seed, 'P2') }),
  }
  const sideNames: Readonly<Record<PlayerId, string>> = { P1: 'P1', P2: 'P2' }
  const maxActions = config.maxActions ?? 4000
  const anomalies: string[] = []
  let actionsApplied = 0
  let timedOut = false

  while (state.phase !== 'ended') {
    if (actionsApplied >= maxActions) {
      timedOut = true
      anomalies.push(`动作数达到上限 ${maxActions}，强制收束（如实报告：本场未自然终局）`)
      break
    }
    const who: PlayerId = state.activePlayer
    const legal = engine.getLegalActions(state, who)
    if (legal.length === 0) {
      anomalies.push(`回合 ${state.turn}：${who} 无合法动作却未终局（引擎不变量破口，如实报告）`)
      break
    }
    const action: Action | null = ais[who]?.decideNextAction(engine, state) ?? null
    if (!action) {
      anomalies.push(`回合 ${state.turn}：${who} 的 AI 返回 null，以 END_TURN 兜底`)
      state = applyFallback(engine, state, who)
      actionsApplied += 1
      continue
    }
    // 描述必须在结算前生成（结算后牌已离手，视图里查不到）
    const actorView = engine.viewFor(state, who)
    const actionText = describeAction(actorView, action)
    let result: EngineResult
    try {
      result = engine.applyAction(state, action)
    } catch (error) {
      anomalies.push(`回合 ${state.turn}：${who} 的动作被引擎拒绝（${String(error)}），以 END_TURN 兜底`)
      state = applyFallback(engine, state, who)
      actionsApplied += 1
      continue
    }
    state = result.state
    actionsApplied += 1
    if (config.json) {
      for (const event of result.events) write(JSON.stringify(event))
    } else {
      write(`>> ${who}: ${actionText}`)
      for (const event of result.events) write(`   ${eventToLine(actorView, event, sideNames)}`)
    }
  }

  const summary: DemoResult = {
    seed: config.seed,
    winner: state.winner,
    endReason: state.endReason,
    turns: state.turn,
    actionsApplied,
    anomalies,
  }
  if (config.json) {
    write(JSON.stringify({ type: 'DEMO_SUMMARY', ...summary }))
  } else {
    write('========== 终局 ==========')
    write(
      `胜者：${summary.winner ?? '平局'}（${summary.endReason ?? (timedOut ? '动作数上限' : '-')}）· 共 ${summary.turns} 回合 · ${summary.actionsApplied} 个动作 · seed=${summary.seed}`,
    )
    for (const line of anomalies) write(`异常：${line}`)
  }
  return summary
}

function applyFallback(engine: ReturnType<typeof createEngine>, state: Parameters<ReturnType<typeof createEngine>['applyAction']>[0], who: PlayerId): ReturnType<ReturnType<typeof createEngine>['initGame']> {
  const legal = engine.getLegalActions(state, who)
  const endTurn = legal.find((a): a is Extract<Action, { type: 'END_TURN' }> => a.type === 'END_TURN')
  return engine.applyAction(state, endTurn ?? { type: 'CONCEDE', playerId: who }).state
}
