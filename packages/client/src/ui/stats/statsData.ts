/**
 * 数值面板数据层（P2-DATA1）——纯聚合函数 + 全局模拟数据装载。
 *
 * 数据源边界（任务书）：
 * - 全局：packages/client/public/data/balance-stats.json（离线预生成随包发布，
 *   只 import/只 fetch 不改）。fetch 用相对路径 './data/balance-stats.json'，
 *   GitHub Pages 子路径部署下随页面 base 解析，不吃 404；
 * - 个人：回放库（P2-INF1）的 ReplayMeta 元数据——只 import ui/replay 公开接口
 *   （replayBackend / ReplayMeta），禁止碰 ui/replay 内部实现。
 *
 * 口径（与 scripts/gen-balance-stats.mjs / M4-QA2 报告一致）：
 * - factions[].winRate = (胜 + 0.5×平) / 局数，仅预组跨卡组对局（镜像不进强度）；
 * - cards[].played = 出局数 / 所在卡组参与局数（含镜像局）；playedWinRate = 出局时胜率；
 * - 胜率/出场率均为 0~1 小数，展示层经 percentLabel 转百分比。
 * - balance-stats.json 的卡牌行不带 faction 字段，按 cardId 前缀对齐本局派系表
 *   （前缀未命中回落 neutral）——口径提示里如实说明。
 */

import type { FactionId } from '@siliconcard/core'
import { replayBackend } from '../replay/storage'
import type { ReplayMeta } from '../replay/types'

// —— 全局模拟数据（balance-stats.json） ——

export interface BalanceStatsFactionRow {
  faction: string
  deckId: string
  winRate: number
  games: number
}

export interface BalanceStatsCardRow {
  cardId: string
  name: string
  played: number
  playedWinRate: number
}

export interface BalanceStats {
  generatedAt: string
  gamesTotal: number
  factions: BalanceStatsFactionRow[]
  cards: BalanceStatsCardRow[]
}

/** 相对路径：Pages 子路径部署下随页面 base 解析（任务书钉死，勿改绝对路径） */
export const BALANCE_STATS_URL = './data/balance-stats.json'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 最小形状校验：不合格直接抛错（面板显示重试按钮，不渲染半残数据） */
export function parseBalanceStats(raw: unknown): BalanceStats {
  if (typeof raw !== 'object' || raw === null) throw new Error('数值数据格式不符')
  const data = raw as Partial<BalanceStats>
  if (typeof data.generatedAt !== 'string' || !isFiniteNumber(data.gamesTotal)) {
    throw new Error('数值数据缺少 generatedAt / gamesTotal 字段')
  }
  if (!Array.isArray(data.factions) || !Array.isArray(data.cards)) {
    throw new Error('数值数据缺少 factions / cards 列表')
  }
  return {
    generatedAt: data.generatedAt,
    gamesTotal: data.gamesTotal,
    factions: data.factions,
    cards: data.cards,
  }
}

/** fetch 可注入（单测直测装载与容错），默认走全局 fetch */
export async function fetchBalanceStats(fetchImpl: typeof fetch = fetch): Promise<BalanceStats> {
  const response = await fetchImpl(BALANCE_STATS_URL)
  if (!response.ok) throw new Error(`数值数据加载失败（HTTP ${response.status}）`)
  return parseBalanceStats(await response.json())
}

// —— 通用口径标注辅助 ——

/** 0~1 小数 → 百分比文案；非有限值（缺失/平局样本为空等）→ '—' */
export function percentLabel(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `${(value * 100).toFixed(digits)}%`
}

/** 派系展示名（ui/stats 自带七派系全表——fallbackContent 只覆盖 4 派系，不动它） */
const STATS_FACTION_NAMES: readonly FactionId[] = ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'neutral']
const STATS_FACTION_LABELS: Record<string, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  apple: 'Apple',
  qualcomm: '高通 Qualcomm',
  arm: 'ARM',
  neutral: '中立硬件',
}

export function factionLabel(faction: FactionId): string {
  return STATS_FACTION_LABELS[faction] ?? faction
}

/** 派系表排序锚点（未知派系垫底） */
function factionOrder(faction: FactionId): number {
  const index = STATS_FACTION_NAMES.indexOf(faction)
  return index === -1 ? STATS_FACTION_NAMES.length : index
}

// —— 个人历史（回放库聚合，纯函数） ——

export interface HistorySummary {
  total: number
  wins: number
  losses: number
  draws: number
  /** (胜 + 0.5×平) / 总场次；零场次为 null（显示 '—'，不给 0% 假口径） */
  winRate: number | null
}

/** 回放库空的容错出口：全零 + winRate null */
export function summarizeHistory(metas: readonly ReplayMeta[]): HistorySummary {
  let wins = 0
  let losses = 0
  let draws = 0
  for (const meta of metas) {
    if (meta.outcome === 'win') wins += 1
    else if (meta.outcome === 'loss') losses += 1
    else draws += 1
  }
  const total = metas.length
  return {
    total,
    wins,
    losses,
    draws,
    winRate: total > 0 ? (wins + 0.5 * draws) / total : null,
  }
}

/** 录制视角本人用的派系（factions[0] 属 P1、factions[1] 属 P2） */
export function viewerFactionOf(meta: ReplayMeta): FactionId {
  return meta.viewer === 'P2' ? (meta.factions[1] ?? 'neutral') : (meta.factions[0] ?? 'neutral')
}

export interface FactionUsageRow {
  faction: FactionId
  games: number
  wins: number
  winRate: number | null
}

/** 按派系分布：只统计本人使用的派系，按场次新→旧无关、多→少排序 */
export function factionUsage(metas: readonly ReplayMeta[]): FactionUsageRow[] {
  const byFaction = new Map<FactionId, { games: number; wins: number }>()
  for (const meta of metas) {
    const faction = viewerFactionOf(meta)
    const bucket = byFaction.get(faction) ?? { games: 0, wins: 0 }
    bucket.games += 1
    if (meta.outcome === 'win') bucket.wins += 1
    byFaction.set(faction, bucket)
  }
  return [...byFaction.entries()]
    .map(([faction, { games, wins }]) => ({
      faction,
      games,
      wins,
      winRate: games > 0 ? wins / games : null,
    }))
    .sort((a, b) => b.games - a.games || factionOrder(a.faction) - factionOrder(b.faction))
}

/** 最近 N 局（默认 10）：savedAt 新→旧，同刻按 id 兜底全序 */
export function recentMetas(metas: readonly ReplayMeta[], count = 10): ReplayMeta[] {
  return [...metas]
    .sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, count))
}

// —— 卡牌表（派系筛选 + 列排序，纯函数） ——

export interface CardRowView extends BalanceStatsCardRow {
  /** cardId 前缀对齐派系表（前缀未命中回落 neutral，口径见模块注释） */
  faction: FactionId
}

export function withCardFaction(stats: BalanceStats): CardRowView[] {
  // 锚定已知 7 派系注册表（与展示名同表），不锚 stats.factions——payload 派系列表
  // 只含强度口径覆盖到的派系，最小快照缺行时卡牌归类不该跟着漂。
  const known = new Set<string>(STATS_FACTION_NAMES)
  return stats.cards.map((row) => {
    const prefix = row.cardId.split('-', 1)[0] ?? ''
    return { ...row, faction: known.has(prefix) ? (prefix as FactionId) : 'neutral' }
  })
}

export type CardSortKey = 'played' | 'playedWinRate' | 'name'
export type SortDir = 'asc' | 'desc'

/** 数值列按数字比、名称列按 localeCompare；稳定全序（同值按 cardId 兜底） */
export function sortCardRows(rows: readonly CardRowView[], key: CardSortKey, dir: SortDir): CardRowView[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (key === 'name') {
      const byName = sign * a.name.localeCompare(b.name, 'zh-Hans-CN')
      if (byName !== 0) return byName
    } else {
      const byValue = sign * ((a[key] as number) - (b[key] as number))
      if (byValue !== 0) return byValue
    }
    return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0
  })
}

// —— 个人历史装载（回放库公开接口，只 import 不改） ——

export type LocalHistory =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: ReplayMeta[] }

/** 读回放库元数据聚合个人历史；IndexedDB 不可用时库自身降级内存实现 → 自然空态 */
export async function loadLocalHistory(): Promise<LocalHistory> {
  try {
    const entries = await replayBackend().getAllMeta()
    return { kind: 'ready', entries }
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}
