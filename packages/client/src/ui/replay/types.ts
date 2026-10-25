/**
 * 回放库类型与展示辅助（P2-INF1）。
 *
 * ReplayMeta 是 IndexedDB「元数据索引 store」的行结构（回放体另存）：
 * 列表页只扫 meta store，不动几十 KB 的动作序列。id 为内容寻址
 * （stableHash(录制体)）——同一局重复导入天然去重，符合 core 存档确定性哲学。
 */

import type { FactionId, PlayerId, ReplayRecording } from '@siliconcard/core'

/** 录制视角的胜负（列表直读，不入引擎事实——由 GAME_END.winner 推导） */
export type ReplayOutcome = 'win' | 'loss' | 'draw'

export type ReplaySource = 'local' | 'lan' | 'imported'

export interface ReplayMeta {
  /** 内容寻址 id：stableHash(ReplayRecording)（8 位 hex） */
  id: string
  /** 落库时间（epoch ms）——日期分组与 LRU 淘汰的唯一依据 */
  savedAt: number
  schemaVersion: number
  seed: number
  factions: readonly [FactionId, FactionId]
  winner: PlayerId | null
  /** 录制视角（胜负归属的参照） */
  viewer: PlayerId
  outcome: ReplayOutcome
  reason: 'health_zero' | 'concede' | null
  /** 终局回合数（引擎 state.turn） */
  turns: number
  actionCount: number
  durationMs: number
  source: ReplaySource
}

export function outcomeOf(winner: PlayerId | null, viewer: PlayerId): ReplayOutcome {
  if (winner === null) return 'draw'
  return winner === viewer ? 'win' : 'loss'
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地日期 YYYY-MM-DD（列表分组 / 文件名共用） */
export function replayDateLabel(savedAt: number): string {
  const d = new Date(savedAt)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** HH:MM（列表时间列） */
export function replayTimeLabel(savedAt: number): string {
  const d = new Date(savedAt)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 导出文件名（plan 定稿）：siliconcard-replay-<日期>-<种子>.json */
export function replayExportFileName(savedAt: number, seed: number): string {
  return `siliconcard-replay-${replayDateLabel(savedAt)}-${seed}.json`
}

/** 时长人话（列表直读）：90 秒 → 「1分30秒」 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}分${pad2(seconds)}秒` : `${seconds}秒`
}

/** 列表「没有终局信息」的判定（裸存档导入无 GAME_END 元数据） */
export function hasEndInfo(meta: ReplayMeta): boolean {
  return meta.winner !== null || meta.reason !== null
}

/** 列表筛选用的日期集合（去重 + 新→旧） */
export function distinctDates(metas: readonly ReplayMeta[]): string[] {
  const seen = new Set<string>()
  for (const meta of metas) seen.add(replayDateLabel(meta.savedAt))
  return [...seen].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
}

/** 录制体两个玩家的派系（导出与落库共用） */
export function factionsOf(recording: ReplayRecording): [FactionId, FactionId] {
  return [recording.players[0]?.faction ?? 'neutral', recording.players[1]?.faction ?? 'neutral']
}
