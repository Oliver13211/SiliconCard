/**
 * 回放导出/导入定向单测（P2-INF1）：
 * - 导出：分区结构（meta/decks/actions/checksum）+ 2 空格 pretty-print + 文件名定稿；
 * - 导入：正常回环（重新导入后 stableHash 一致）、schemaVersion 校验、
 *   stableHash 完整性校验、损坏/未知字段/裸存档兼容与明确拒收。
 */

import { describe, expect, it } from 'vitest'
import { REPLAY_SCHEMA_VERSION, serializeReplay, stableHash } from '@siliconcard/core'
import { buildReplayExportDoc, buildReplayExportText, parseReplayImport, ReplayImportError, REPLAY_EXPORT_KIND } from '../exportImport'
import { replayIdOf } from '../storage'
import { replayDateLabel, type ReplayMeta } from '../types'
import { deckOf } from '../../__tests__/fixtures'
import type { ReplayRecording } from '@siliconcard/core'

const RECORDING: ReplayRecording = {
  seed: 777,
  players: [
    { id: 'P1', faction: 'neutral', heroName: '你', deck: deckOf('demo-gt-1030') },
    { id: 'P2', faction: 'nvidia', heroName: '对面老哥', deck: deckOf('demo-gt-1030') },
  ],
  actions: [
    { type: 'PLAY_CARD', playerId: 'P1', uid: 'hand-1', target: { kind: 'hero', playerId: 'P2' } },
    { type: 'END_TURN', playerId: 'P1' },
    { type: 'CONCEDE', playerId: 'P2' },
  ],
}

/** 本地 2026-10-23 中午（任意时区日期标签一致） */
const MATCH_TIME = new Date(2026, 9, 23, 12, 34).getTime()

function metaOf(body: ReplayRecording): ReplayMeta {
  return {
    id: replayIdOf(body),
    savedAt: MATCH_TIME,
    schemaVersion: REPLAY_SCHEMA_VERSION,
    seed: body.seed,
    factions: ['neutral', 'nvidia'],
    winner: 'P1',
    viewer: 'P1',
    outcome: 'win',
    reason: 'concede',
    turns: 3,
    actionCount: body.actions.length,
    durationMs: 65_000,
    source: 'local',
  }
}

function expectImportError(fn: () => unknown, pattern: RegExp): ReplayImportError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ReplayImportError)
    const typed = error as ReplayImportError
    expect(typed.message).toMatch(pattern)
    return typed
  }
  throw new Error(`预期导入失败（${pattern}），但成功解析了`)
}

describe('replay exportImport（导出 / 导入双校验）', () => {
  it('导出：分区结构齐全 + 2 空格 pretty-print + 文件名 siliconcard-replay-<日期>-<种子>.json', () => {
    const { text, fileName } = buildReplayExportText(metaOf(RECORDING), RECORDING)
    expect(fileName).toBe(`siliconcard-replay-${replayDateLabel(MATCH_TIME)}-777.json`)
    expect(text).toContain('"kind": "siliconcard-replay"')
    // 分区结构（顶层四个分区 + exportedAt）
    expect(text).toMatch(/\n  "meta": \{/)
    expect(text).toMatch(/\n  "decks": \{/)
    expect(text).toMatch(/\n  "actions": \[/)
    expect(text).toMatch(/\n  "checksum": "/)
    // 人类可读：换行与缩进确实存在（不是单行 canonical JSON）
    expect(text.split('\n').length).toBeGreaterThan(30)
    // checksum 与录制体 stableHash 一致
    const doc = JSON.parse(text)
    expect(doc.checksum).toBe(stableHash(RECORDING))
    expect(doc.meta.schemaVersion).toBe(REPLAY_SCHEMA_VERSION)
    expect(doc.meta.date).toBe(replayDateLabel(MATCH_TIME))
    expect(doc.decks.P1.faction).toBe('neutral')
    expect(doc.decks.P2.deck).toEqual(deckOf('demo-gt-1030'))
  })

  it('导出→导入回环：录制体逐字段一致，stableHash 不变', () => {
    const { text } = buildReplayExportText(metaOf(RECORDING), RECORDING)
    const parsed = parseReplayImport(text, MATCH_TIME + 5)
    expect(parsed.recording).toEqual(RECORDING)
    expect(stableHash(parsed.recording)).toBe(stableHash(RECORDING))
    expect(replayIdOf(parsed.recording)).toBe(replayIdOf(RECORDING))
    // 摘要元数据随文档恢复（胜方/理由/回合/时长），source 标记 imported
    expect(parsed.meta.winner).toBe('P1')
    expect(parsed.meta.reason).toBe('concede')
    expect(parsed.meta.turns).toBe(3)
    expect(parsed.meta.durationMs).toBe(65_000)
    expect(parsed.meta.source).toBe('imported')
    expect(parsed.meta.outcome).toBe('win')
    expect(parsed.meta.actionCount).toBe(RECORDING.actions.length)
  })

  it('兼容裸 ReplayRecording（serializeReplay 输出 / CLI 存档）', () => {
    const parsed = parseReplayImport(serializeReplay(RECORDING), MATCH_TIME)
    expect(parsed.recording).toEqual(RECORDING)
    // 裸存档无终局信息：winner/reason 为空，UI 按「—」展示
    expect(parsed.meta.winner).toBeNull()
    expect(parsed.meta.reason).toBeNull()
    expect(parsed.meta.source).toBe('imported')
  })

  it('拒收：非法 JSON，报错说明原因', () => {
    expectImportError(() => parseReplayImport('{oops'), /不是合法 JSON/)
  })

  it('拒收：既非导出格式也非合法裸存档', () => {
    expectImportError(() => parseReplayImport(JSON.stringify({ hello: 'world' })), /无法识别的回放文件/)
  })

  it('拒收：schemaVersion 版本不符（明确提示版本号）', () => {
    const { text } = buildReplayExportText(metaOf(RECORDING), RECORDING)
    const doc = JSON.parse(text)
    const wrongVersion = REPLAY_SCHEMA_VERSION + 99
    doc.meta.schemaVersion = wrongVersion
    expectImportError(() => parseReplayImport(JSON.stringify(doc, null, 2)), new RegExp(`版本不符.*${wrongVersion}`))
  })

  it('拒收：actions 被改动 → checksum 完整性校验失败', () => {
    const { text } = buildReplayExportText(metaOf(RECORDING), RECORDING)
    const doc = JSON.parse(text)
    doc.actions.push({ type: 'CONCEDE', playerId: 'P1' })
    expectImportError(() => parseReplayImport(JSON.stringify(doc, null, 2)), /完整性校验失败/)
  })

  it('拒收：decks 被改动 → checksum 完整性校验失败', () => {
    const doc = buildReplayExportDoc(metaOf(RECORDING), RECORDING)
    const firstCard = doc.decks.P1.deck.cards[0]
    if (firstCard) firstCard.count = 29
    expectImportError(() => parseReplayImport(JSON.stringify(doc, null, 2)), /完整性校验失败/)
  })

  it('拒收：动作携带未知字段（结构校验在 checksum 之前拦截）', () => {
    const doc = buildReplayExportDoc(metaOf(RECORDING), RECORDING)
    ;(doc.actions[1] as Record<string, unknown>).cheat = true
    // 重算 checksum 让完整性闸门放行 → 结构校验必须独立兜底（未知字段显式报错）
    doc.checksum = stableHash({
      seed: doc.meta.seed,
      players: [
        { id: 'P1', faction: doc.decks.P1.faction, heroName: doc.decks.P1.heroName, deck: doc.decks.P1.deck },
        { id: 'P2', faction: doc.decks.P2.faction, heroName: doc.decks.P2.heroName, deck: doc.decks.P2.deck },
      ],
      actions: doc.actions,
    })
    expectImportError(() => parseReplayImport(JSON.stringify(doc, null, 2)), /未知字段「cheat」/)
  })

  it('拒收：损坏的分区结构（decks 缺失）给出可读路径', () => {
    const doc = buildReplayExportDoc(metaOf(RECORDING), RECORDING)
    delete (doc as unknown as Record<string, unknown>).decks
    expectImportError(() => parseReplayImport(JSON.stringify(doc, null, 2)), /decks/)
  })

  it('kind 标记不是硅牌导出但内部结构合法的文档按裸存档处理', () => {
    // serializeReplay 输出恰好含 schemaVersion/seed/players/actions——无 kind 字段
    const bare = JSON.parse(serializeReplay(RECORDING))
    expect(bare.kind).toBeUndefined()
    expect(REPLAY_EXPORT_KIND).toBe('siliconcard-replay')
    const parsed = parseReplayImport(serializeReplay(RECORDING))
    expect(parsed.recording.seed).toBe(777)
  })
})
