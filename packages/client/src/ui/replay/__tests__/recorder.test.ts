/**
 * 回放录制链路定向单测（P2-INF1）：
 * battleDriver 静默录制（sink 注入）→ GAME_END 交付 → metaFromMatch 落库 →
 * 导出 JSON → 重新导入 → 引擎重放 stableHash 一致（plan 验收主路径）。
 * 同时覆盖：sink 异常吞掉、无 sink 零感知、非法动作不进录制体、中途弃局不落库。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createEngine, runReplay } from '@siliconcard/core'
import { BattleDriver, setMatchRecordingSink, type MatchRecording } from '../../game/battleDriver'
import { ensureContentRegistered } from '../../game/deckLoader'
import { deckOf } from '../../__tests__/fixtures'
import { metaFromMatch, recordFinishedMatch, setReplayBackendForTests } from '../replayStore'
import { buildReplayExportText, parseReplayImport } from '../exportImport'
import { createMemoryBackend, replayBackend, replayIdOf } from '../storage'
import { hasEndInfo, replayDateLabel } from '../types'

beforeEach(() => {
  // demo 卡池注册（隔离真实 content 落地进度）+ 干净的 sink / 后端 / store
  ensureContentRegistered({ cards: {}, decks: {} })
  setMatchRecordingSink(null)
  setReplayBackendForTests(createMemoryBackend())
})

function newDriver(): BattleDriver {
  const driver = new BattleDriver('P1')
  driver.start({
    seed: 777,
    players: [
      { id: 'P1', faction: 'neutral', heroName: '你', deck: deckOf('demo-gt-1030') },
      { id: 'P2', faction: 'nvidia', heroName: '对面老哥', deck: deckOf('demo-gt-1030') },
    ],
  })
  return driver
}

function playToEnd(driver: BattleDriver): void {
  driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
  driver.dispatch({ type: 'CONCEDE', playerId: 'P2' })
}

describe('battleDriver 回放录制钩子', () => {
  it('完整对局：GAME_END 交付一次，录制体 = seed + 双方卡组 + 动作序列 + 终局元数据', () => {
    const saved: MatchRecording[] = []
    setMatchRecordingSink((match) => saved.push(match))
    const driver = newDriver()
    expect(saved).toHaveLength(0) // 开局不交付
    playToEnd(driver)
    expect(saved).toHaveLength(1)
    const match = saved[0] as MatchRecording
    expect(match.recording.seed).toBe(777)
    expect(match.recording.players.map((p) => p.faction)).toEqual(['neutral', 'nvidia'])
    expect(match.recording.actions).toEqual([
      { type: 'END_TURN', playerId: 'P1' },
      { type: 'CONCEDE', playerId: 'P2' },
    ])
    expect(match.winner).toBe('P1')
    expect(match.reason).toBe('concede')
    expect(match.viewer).toBe('P1')
    expect(match.turns).toBeGreaterThanOrEqual(2)
    expect(match.startedAt).toBeLessThanOrEqual(match.endedAt)
  })

  it('非法动作抛 RuleError 且不进录制体；后续合法动作照常录制', () => {
    const saved: MatchRecording[] = []
    setMatchRecordingSink((match) => saved.push(match))
    const driver = newDriver()
    expect(() => driver.dispatch({ type: 'PLAY_CARD', playerId: 'P1', uid: 'nope' })).toThrowError()
    playToEnd(driver)
    expect(saved).toHaveLength(1)
    expect((saved[0] as MatchRecording).recording.actions).toHaveLength(2)
  })

  it('sink 抛异常被静默吞掉：dispatch 正常返回，录制正常关闭', () => {
    setMatchRecordingSink(() => {
      throw new Error('IndexedDB 炸了')
    })
    const driver = newDriver()
    expect(() => playToEnd(driver)).not.toThrow()
    expect(driver.isEnded()).toBe(true)
  })

  it('未注册 sink：对局零感知（对局中不录制不落盘）', () => {
    const driver = newDriver()
    expect(() => playToEnd(driver)).not.toThrow()
    expect(driver.isEnded()).toBe(true)
  })

  it('中途弃局（reset）不交付录制——只录制打完的对局', () => {
    const saved: MatchRecording[] = []
    setMatchRecordingSink((match) => saved.push(match))
    const driver = newDriver()
    driver.dispatch({ type: 'END_TURN', playerId: 'P1' })
    driver.reset()
    playToEnd(newDriver()) // 新一局与上一局互不污染
    expect(saved).toHaveLength(1)
  })
})

describe('录制落库 + 导出/导入回环（plan 验收主路径）', () => {
  it('recordFinishedMatch 落库：元数据齐全， outcome/时长/回合派生正确', async () => {
    const saved: MatchRecording[] = []
    setMatchRecordingSink((match) => saved.push(match))
    playToEnd(newDriver())
    await recordFinishedMatch(saved[0] as MatchRecording)

    const metas = await replayBackend().getAllMeta()
    expect(metas).toHaveLength(1)
    const meta = metas[0] as NonNullable<(typeof metas)[number]>
    expect(meta.seed).toBe(777)
    expect(meta.outcome).toBe('win')
    expect(meta.source).toBe('local')
    expect(meta.schemaVersion).toBe(1)
    expect(hasEndInfo(meta)).toBe(true)
    const body = await replayBackend().getBody(replayIdOf((saved[0] as MatchRecording).recording))
    expect(body?.actions).toEqual((saved[0] as MatchRecording).recording.actions)
  })

  it('落库失败绝不冒泡：存储抛错只 console 留痕（对局侧零感知）', async () => {
    setReplayBackendForTests({
      getAllMeta: () => Promise.reject(new Error('boom')),
      getBody: () => Promise.reject(new Error('boom')),
      put: () => Promise.reject(new Error('quota exceeded')),
      delete: () => Promise.reject(new Error('boom')),
    })
    await expect(recordFinishedMatch({
      recording: {
        seed: 1,
        players: [
          { id: 'P1', faction: 'neutral', deck: deckOf('demo-gt-1030') },
          { id: 'P2', faction: 'nvidia', deck: deckOf('demo-gt-1030') },
        ],
        actions: [],
      },
      viewer: 'P1',
      winner: 'P1',
      reason: 'concede',
      turns: 1,
      startedAt: 0,
      endedAt: 10,
    })).resolves.toBeUndefined()
  })

  it('端到端：录制 → 落库 → 导出 JSON → 重新导入 → 引擎重放 stableHash 一致', async () => {
    const saved: MatchRecording[] = []
    setMatchRecordingSink((match) => saved.push(match))
    playToEnd(newDriver())
    const original = (saved[0] as MatchRecording).recording

    const savedAt = new Date(2026, 9, 23, 20, 0).getTime()
    const { meta, body } = metaFromMatch(saved[0] as MatchRecording, savedAt)
    expect(replayDateLabel(meta.savedAt)).toBe('2026-10-23')
    expect(meta.durationMs).toBeGreaterThanOrEqual(0)

    const backend = createMemoryBackend()
    await backend.put(meta, body)

    const { text, fileName } = buildReplayExportText(meta, body, savedAt)
    expect(fileName).toBe('siliconcard-replay-2026-10-23-777.json')

    const parsed = parseReplayImport(text, savedAt + 1000)
    expect(parsed.recording).toEqual(original)

    // 确定性引擎：同录制重放两次 → 终局状态哈希一致（可完整回放的直接证据）
    const hashOf = (recording: typeof original) => runReplay(createEngine(), recording).stateHash
    expect(hashOf(parsed.recording)).toBe(hashOf(original))
  })

  it('metaFromMatch：负时长防御（endedAt < startedAt 时钳到 0）', () => {
    const { meta } = metaFromMatch({
      recording: {
        seed: 2,
        players: [
          { id: 'P1', faction: 'neutral', deck: deckOf('demo-gt-1030') },
          { id: 'P2', faction: 'nvidia', deck: deckOf('demo-gt-1030') },
        ],
        actions: [],
      },
      viewer: 'P2',
      winner: 'P1',
      reason: 'health_zero',
      turns: 4,
      startedAt: 1000,
      endedAt: 500,
    })
    expect(meta.durationMs).toBe(0)
    expect(meta.outcome).toBe('loss')
  })
})
