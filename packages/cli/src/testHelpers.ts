/**
 * 测试共享工具——一个「只看协议消息」的脚本化外部 agent：
 * 与真实外部 agent 同视角（只消费 StateMessage / 写 action），绝不触碰引擎 state。
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { StateMessage } from './protocol'
import type { LegalActionEntry } from './describe'
import { loadContent, resolveDeckChoice, type ContentData } from './content'
import { AgentMatch, type AgentMatchOptions } from './driver'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 脚本化策略：前期铺场（第一个 PLAY_CARD）→ 有兵就攻击 → 结束回合；
 * 第 25 回合起只 END_TURN（进入疲劳赛跑）；第 60 回合兜底 CONCEDE 保证终局。
 */
export function chooseScriptedAction(msg: StateMessage): LegalActionEntry | undefined {
  const { legalActions, turn } = msg
  if (turn >= 60) return legalActions.find((l) => l.kind === 'CONCEDE')
  if (turn >= 25) return legalActions.find((l) => l.kind === 'END_TURN')
  return (
    legalActions.find((l) => l.kind === 'PLAY_CARD') ??
    legalActions.find((l) => l.kind === 'ATTACK') ??
    legalActions.find((l) => l.kind === 'USE_HERO_POWER') ??
    legalActions.find((l) => l.kind === 'END_TURN')
  )
}

export function makeMatch(seed = 42, difficulty: AgentMatchOptions['difficulty'] = 'normal', content?: ContentData): AgentMatch {
  const data = content ?? loadContent()
  return new AgentMatch({
    seed,
    difficulty,
    agentDeck: resolveDeckChoice(undefined, 'nvidia-flagship-faith', data, 'deck'),
    opponentDeck: resolveDeckChoice(undefined, 'amd-war-future', data, 'opponent-deck'),
  })
}

export interface ActorReport {
  stateMessages: StateMessage[]
  lastErrorCodes: string[]
  gameover: { winner: string | null; endReason: string | null; turns: number; totalEvents: number }
}

/**
 * 文件模式的并发外部 agent：轮询 turn.json（按 seq 去重）→ 写 action.json，
 * 直到 gameover.json 出现。返回全程收集的状态消息与终局摘要。
 */
export async function runFileActor(
  dir: string,
  opts: { pollMs?: number; choose?: (msg: StateMessage) => LegalActionEntry | undefined; maxWaitMs?: number } = {},
): Promise<ActorReport> {
  const dirAbs = resolve(dir)
  const pollMs = opts.pollMs ?? 2
  const choose = opts.choose ?? chooseScriptedAction
  const started = Date.now()
  const maxWaitMs = opts.maxWaitMs ?? 60_000
  const messages: StateMessage[] = []
  const lastErrorCodes: string[] = []
  let seenSeq = -1

  for (;;) {
    if (Date.now() - started > maxWaitMs) throw new Error(`外部 agent 等待超时（${maxWaitMs}ms）：对局未终局`)
    const overPath = resolve(dirAbs, 'gameover.json')
    if (existsSync(overPath)) {
      const over = JSON.parse(readFileSync(overPath, 'utf8'))
      return { stateMessages: messages, lastErrorCodes, gameover: { winner: over.winner, endReason: over.endReason, turns: over.turns, totalEvents: over.totalEvents } }
    }
    const turnPath = resolve(dirAbs, 'turn.json')
    if (!existsSync(turnPath)) {
      await sleep(pollMs)
      continue
    }
    const msg = JSON.parse(readFileSync(turnPath, 'utf8')) as StateMessage
    if (msg.seq === seenSeq || msg.phase === 'ended') {
      await sleep(pollMs)
      continue
    }
    seenSeq = msg.seq
    messages.push(msg)
    if (msg.lastError) lastErrorCodes.push(msg.lastError.code)
    const chosen = choose(msg)
    if (!chosen) throw new Error(`脚本 agent 在 seq=${msg.seq} 找不到可执行动作`)
    rmSync(turnPath, { force: true }) // 模拟 agent 已消费本回合（防止重读旧局面）
    writeFileSync(resolve(dirAbs, 'action.json'), JSON.stringify({ action: chosen.action }), 'utf8')
  }
}
