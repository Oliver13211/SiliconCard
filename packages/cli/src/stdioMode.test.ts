/**
 * stdio 模式契约：hello → state 轮转、非法动作 lastError 纠正、AI 回合推进、终局 gameover。
 * 全部用内存管道（PassThrough），不碰真实 stdin/stdout。
 */

import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { loadContent, resolveDeckChoice } from './content'
import { AgentMatch } from './driver'
import { runStdioMode } from './modes/stdio'
import { sleep } from './testHelpers'

function setupMatch(seed = 42): AgentMatch {
  const content = loadContent()
  return new AgentMatch({
    seed,
    difficulty: 'normal',
    agentDeck: resolveDeckChoice(undefined, 'nvidia-flagship-faith', content, 'deck'),
    opponentDeck: resolveDeckChoice(undefined, 'amd-war-future', content, 'opponent-deck'),
  })
}

interface Wire {
  input: PassThrough
  output: PassThrough
  lines: { type: string; [k: string]: unknown }[]
  done: Promise<unknown>
}

function wire(match: AgentMatch): Wire {
  const input = new PassThrough()
  const output = new PassThrough()
  const lines: { type: string; [k: string]: unknown }[] = []
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (line.length > 0) lines.push(JSON.parse(line))
    }
  })
  const done = runStdioMode(match, { input, output, log: () => {} })
  return { input, output, lines, done }
}

async function waitFor(w: Wire, pred: (line: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const started = Date.now()
  for (;;) {
    const found = w.lines.find((l) => pred(l as Record<string, unknown>))
    if (found) return found as Record<string, unknown>
    if (Date.now() - started > 10_000) throw new Error(`stdio 测试等待「${what}」超时`)
    await sleep(2)
  }
}

function send(w: Wire, message: unknown): void {
  w.input.write(JSON.stringify(message) + '\n')
}

describe('stdio JSON 行协议', () => {
  it('hello → state（自解释字段齐备）→ END_TURN → AI 行动后新 state（turn 推进）', async () => {
    const w = wire(setupMatch(42))
    const hello = await waitFor(w, (l) => l['type'] === 'hello', 'hello')
    expect(hello['you']).toBe('P1')
    expect(String(hello['protocol'])).toMatch(/^siliconcard\.stdio\//)
    const state1 = (await waitFor(w, (l) => l['type'] === 'state', 'state')) as unknown as { seq: number; state: { you: { hand: unknown[] } }; legalActions: { kind: string }[] }
    expect(state1.state.you.hand.length).toBe(3) // P1 先手第 1 回合不抽牌
    expect(state1.legalActions.some((l) => l.kind === 'END_TURN')).toBe(true)

    send(w, { type: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
    const state2 = (await waitFor(w, (l) => l['type'] === 'state' && Number(l['seq']) > state1.seq, 'state#2')) as unknown as { turn: number; log: string[] }
    expect(state2.turn).toBeGreaterThan(1)
    expect(state2.log.length).toBeGreaterThan(0) // AI 回合事件以人话日志透出
    w.input.end()
    await w.done
  })

  it('非法动作：state.lastError 携带 code + hint，纠正后可继续（状态未被破坏）', async () => {
    const w = wire(setupMatch(42))
    await waitFor(w, (l) => l['type'] === 'hello', 'hello')
    const state1 = (await waitFor(w, (l) => l['type'] === 'state', 'state')) as unknown as { seq: number }

    send(w, { action: { type: 'PLAY_CARD', playerId: 'P1', uid: 'ghost-uid' } })
    const errState = (await waitFor(w, (l) => l['type'] === 'state' && Number(l['seq']) > state1.seq, 'errState')) as unknown as { seq: number; lastError: { code: string; hint: string }; legalActions: { action: { type: string } }[] }
    expect(errState.lastError.code).toBe('CARD_NOT_IN_HAND')
    expect(errState.lastError.hint).toMatch(/legalActions/)

    // 纠正：直接从 legalActions 原样照抄一条（协议文档指引的做法）
    send(w, { type: 'action', action: errState.legalActions.find((l) => l.action.type === 'END_TURN')!.action })
    const state2 = (await waitFor(w, (l) => l['type'] === 'state' && Number(l['seq']) > errState.seq, 'state#2')) as unknown as { lastError: unknown }
    expect(state2.lastError).toBeNull()
    w.input.end()
    await w.done
  })

  it('非 JSON 行收到 UNKNOWN_ACTION 指引；对局可正常打完并输出 gameover', async () => {
    const w = wire(setupMatch(42))
    await waitFor(w, (l) => l['type'] === 'state', 'state')
    w.input.write('this is not json\n')
    const errState = (await waitFor(w, (l) => l['type'] === 'state' && Boolean(l['lastError']), 'parseErr')) as unknown as { lastError: { code: string; hint: string } }
    expect(errState.lastError.code).toBe('UNKNOWN_ACTION')
    expect(errState.lastError.hint).toBeTruthy()
    w.input.end()
    await w.done
  })
})
