/**
 * 数值面板数据层定向单测（P2-DATA1）：聚合纯函数（胜负/胜率、派系分布、最近 N 局、
 * 卡牌派系归类与列排序）、空态容错（回放库空 → 全零 + 胜率 '—'）、
 * 全局数据装载容错（HTTP 失败 / 形状不符 → 抛错由 UI 层转重试按钮）。
 */

import { describe, expect, it } from 'vitest'
import type { ReplayMeta } from '../../replay/types'
import {
  fetchBalanceStats,
  factionUsage,
  parseBalanceStats,
  percentLabel,
  recentMetas,
  sortCardRows,
  summarizeHistory,
  viewerFactionOf,
  withCardFaction,
  type BalanceStats,
} from '../statsData'

function metaOf(overrides: Partial<ReplayMeta>): ReplayMeta {
  return {
    id: overrides.id ?? 'hash-1',
    savedAt: overrides.savedAt ?? 1_000,
    schemaVersion: 1,
    seed: 1,
    factions: overrides.factions ?? ['nvidia', 'amd'],
    winner: overrides.winner ?? 'P1',
    viewer: overrides.viewer ?? 'P1',
    outcome: overrides.outcome ?? 'win',
    reason: 'health_zero',
    turns: 10,
    actionCount: 20,
    durationMs: 60_000,
    source: 'local',
  }
}

const SAMPLE_STATS: BalanceStats = {
  generatedAt: '2026-10-23T13:46:42.334Z',
  gamesTotal: 27300,
  factions: [
    { faction: 'nvidia', deckId: 'nvidia-flagship-faith', winRate: 0.543, games: 7200 },
    { faction: 'neutral', deckId: 'neutral-system-builder', winRate: 0.47, games: 7200 },
  ],
  cards: [
    { cardId: 'nvidia-rtx-5090', name: 'RTX 5090', played: 0.148, playedWinRate: 0.755 },
    { cardId: 'neutral-g502-hero', name: '罗技 G502 HERO', played: 0.4, playedWinRate: 0.527 },
    { cardId: 'apple-m1-ultra', name: 'M1 Ultra', played: 0.64, playedWinRate: 0.564 },
  ],
}

describe('summarizeHistory（个人胜负聚合 + 空态容错）', () => {
  it('空回放库：全零 + 胜率 null（显示 —，不给 0% 假口径）', () => {
    expect(summarizeHistory([])).toEqual({ total: 0, wins: 0, losses: 0, draws: 0, winRate: null })
  })

  it('胜负平混合：(胜 + 0.5×平) / 总场次', () => {
    const metas = [
      metaOf({ id: 'a', outcome: 'win' }),
      metaOf({ id: 'b', outcome: 'win' }),
      metaOf({ id: 'c', outcome: 'loss' }),
      metaOf({ id: 'd', outcome: 'draw' }),
    ]
    expect(summarizeHistory(metas)).toEqual({ total: 4, wins: 2, losses: 1, draws: 1, winRate: 0.625 })
  })
})

describe('factionUsage（本人派系分布）', () => {
  it('只按录制视角本人用的派系计数，多→少排序；空库空分布', () => {
    const metas = [
      metaOf({ id: 'a', factions: ['nvidia', 'amd'], viewer: 'P1', outcome: 'win' }),
      metaOf({ id: 'b', factions: ['nvidia', 'amd'], viewer: 'P1', outcome: 'win' }),
      metaOf({ id: 'c', factions: ['nvidia', 'amd'], viewer: 'P2', outcome: 'win' }), // 本人是 amd
      metaOf({ id: 'd', factions: ['arm', 'intel'], viewer: 'P2', outcome: 'loss' }), // 本人是 intel
      metaOf({ id: 'e', factions: ['intel', 'arm'], viewer: 'P1', outcome: 'loss' }),
    ]
    expect(factionUsage([])).toEqual([])
    expect(factionUsage(metas)).toEqual([
      { faction: 'nvidia', games: 2, wins: 2, winRate: 1 },
      { faction: 'intel', games: 2, wins: 0, winRate: 0 },
      { faction: 'amd', games: 1, wins: 1, winRate: 1 },
    ])
  })

  it('viewerFactionOf：P2 视角取 factions[1]', () => {
    expect(viewerFactionOf(metaOf({ viewer: 'P1', factions: ['nvidia', 'amd'] }))).toBe('nvidia')
    expect(viewerFactionOf(metaOf({ viewer: 'P2', factions: ['nvidia', 'amd'] }))).toBe('amd')
  })
})

describe('recentMetas（最近 N 局）', () => {
  it('savedAt 新→旧取前 N 条；不足 N 条全取；空库为空数组', () => {
    const metas = [
      metaOf({ id: 'old', savedAt: 1_000 }),
      metaOf({ id: 'mid', savedAt: 2_000 }),
      metaOf({ id: 'new', savedAt: 3_000 }),
    ]
    expect(recentMetas(metas, 10).map((meta) => meta.id)).toEqual(['new', 'mid', 'old'])
    expect(recentMetas(metas, 2).map((meta) => meta.id)).toEqual(['new', 'mid'])
    expect(recentMetas([], 10)).toEqual([])
  })
})

describe('卡牌表：派系归类与列排序', () => {
  it('cardId 前缀对齐派系表；前缀未命中回落 neutral', () => {
    const rows = withCardFaction(SAMPLE_STATS)
    expect(rows.map((row) => row.faction)).toEqual(['nvidia', 'neutral', 'apple'])
  })

  it('按出场率降序为默认；升序反转；同名值按 cardId 兜底全序', () => {
    const rows = withCardFaction(SAMPLE_STATS)
    expect(sortCardRows(rows, 'played', 'desc').map((row) => row.cardId)).toEqual([
      'apple-m1-ultra',
      'neutral-g502-hero',
      'nvidia-rtx-5090',
    ])
    expect(sortCardRows(rows, 'played', 'asc')[0]?.cardId).toBe('nvidia-rtx-5090')
    expect(sortCardRows(rows, 'playedWinRate', 'desc')[0]?.cardId).toBe('nvidia-rtx-5090')
    // zh 拼音序：罗技(luo) < M1(m) < RTX(r)
    expect(sortCardRows(rows, 'name', 'asc')[0]?.name).toBe('罗技 G502 HERO')
    expect(sortCardRows(rows, 'name', 'desc')[0]?.name).toBe('RTX 5090')
  })
})

describe('percentLabel（口径展示）', () => {
  it('0~1 小数转百分比；null/NaN/缺失显示 —', () => {
    expect(percentLabel(0.5430555)).toBe('54.3%')
    expect(percentLabel(0)).toBe('0.0%')
    expect(percentLabel(null)).toBe('—')
    expect(percentLabel(undefined)).toBe('—')
    expect(percentLabel(Number.NaN)).toBe('—')
  })
})

describe('全局数据装载容错', () => {
  it('形状不符直接抛错（UI 层转重试按钮）', () => {
    expect(() => parseBalanceStats({})).toThrow()
    expect(() => parseBalanceStats({ generatedAt: 'x', gamesTotal: 'x', factions: [], cards: [] })).toThrow()
    expect(() => parseBalanceStats(null)).toThrow()
  })

  it('parseBalanceStats 通过合法形状', () => {
    expect(parseBalanceStats(SAMPLE_STATS).gamesTotal).toBe(27300)
  })

  it('HTTP 失败抛错；fetch 注入生效', async () => {
    const failing = (async () => new Response('服务器打盹', { status: 500 })) as unknown as typeof fetch
    await expect(fetchBalanceStats(failing)).rejects.toThrow('HTTP 500')

    const ok = (async () =>
      new Response(JSON.stringify(SAMPLE_STATS), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await expect(fetchBalanceStats(ok)).resolves.toMatchObject({ gamesTotal: 27300 })
  })
})
