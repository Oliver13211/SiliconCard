/**
 * 演示对局（AGT3）回归：双 AI 自对弈正常终局、确定性（同 seed 输出逐行一致）、
 * 人话解说与 --json 事件流两种形态。
 */

import { describe, expect, it } from 'vitest'
import { loadContent, resolveDeckChoice } from './content'
import { runDemoMatch, type DemoResult } from './demoRun'

function run(seed: number, json: boolean, maxActions = 4000): { result: DemoResult; lines: string[] } {
  const content = loadContent()
  const lines: string[] = []
  const result = runDemoMatch({
    seed,
    difficulty: 'normal',
    p1Deck: resolveDeckChoice(undefined, 'nvidia-flagship-faith', content, 'deck'),
    p2Deck: resolveDeckChoice(undefined, 'amd-war-future', content, 'opponent-deck'),
    json,
    maxActions,
    write: (line) => lines.push(line),
  })
  return { result, lines }
}

describe('demo 自对弈观战', () => {
  it('一场完整对局自然终局，AI 零异常', () => {
    const { result, lines } = run(42, false)
    expect(['P1', 'P2', null]).toContain(result.winner)
    expect(result.anomalies).toEqual([])
    expect(result.actionsApplied).toBeGreaterThan(0)
    expect(lines.join('\n')).toMatch(/终局/)
    expect(lines.join('\n')).toMatch(/胜者：/)
  }, 30_000)

  it('同 seed 两场输出逐行一致（确定性）；换 seed 则不同', () => {
    const a = run(42, true)
    const b = run(42, true)
    expect(a.lines).toEqual(b.lines)
    expect(JSON.stringify(a.result)).toBe(JSON.stringify(b.result))
    const c = run(777, true)
    expect(c.lines).not.toEqual(a.lines)
  }, 60_000)

  it('--json 形态逐行输出事件 JSON（含 GAME_END），汇总行 DEMO_SUMMARY 收尾', () => {
    const { lines } = run(42, true)
    const events = lines.slice(0, -1).map((l) => JSON.parse(l) as { type: string })
    for (const e of events) expect(typeof e.type).toBe('string')
    expect(events.some((e) => e.type === 'GAME_END')).toBe(true)
    const summary = JSON.parse(lines[lines.length - 1]!) as { type: string; winner: string | null }
    expect(summary.type).toBe('DEMO_SUMMARY')
  }, 30_000)
})
