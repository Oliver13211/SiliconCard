/**
 * 回放 JSON 导出 / 导入（P2-INF1，一等公民）。
 *
 * 导出（人类可读、可 diff、可直接喂外部 AI agent——呼应 M3 Agent 资产）：
 * - pretty-print 2 空格缩进，分区结构 `meta` / `decks` / `actions` / `checksum`；
 * - 单文件单局，命名 `siliconcard-replay-<日期>-<种子>.json`；
 * - checksum = stableHash(录制体)：对 actions/decks 的任何改动都会导致
 *   重新导入校验失败——完整性闸门。
 *
 * 导入（总闸门）：
 * 1. JSON.parse（非法即拒）；
 * 2. 双格式兼容：硅牌导出格式（kind: siliconcard-replay）或裸 ReplayRecording
 *    （serializeReplay 输出 / CLI 存档——与外部 agent 生态互通）；
 * 3. `schemaVersion` 校验（版本不符明确报错）+ core deserializeReplay 结构校验
 *    （严格未知字段拒绝，错误带 JSON 路径）；
 * 4. 导出格式额外做 `stableHash` 完整性校验——损坏/被改动的文件拒绝入库。
 *
 * 校验失败一律抛 ReplayImportError（message 即 UI 可直显的人话），不入库。
 */

import {
  REPLAY_SCHEMA_VERSION,
  canonicalJson,
  deserializeReplay,
  stableHash,
  type Action,
  type DeckSpec,
  type FactionId,
  type PlayerId,
  type ReplayRecording,
} from '@siliconcard/core'
import { factionsOf, outcomeOf, replayDateLabel, type ReplayMeta } from './types'

export const REPLAY_EXPORT_KIND = 'siliconcard-replay'

/** 导入失败的强类型错误：UI 按 message 直显（已是人话） */
export class ReplayImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReplayImportError'
  }
}

interface ExportedPlayerSetup {
  faction: FactionId
  heroName?: string
  deck: DeckSpec
}

/** 导出文档分区结构：meta（对局摘要）/ decks（双方配置）/ actions（动作序列）/ checksum（完整性） */
export interface ReplayExportDoc {
  kind: typeof REPLAY_EXPORT_KIND
  exportedAt: string
  meta: {
    schemaVersion: number
    seed: number
    /** 对局日期 YYYY-MM-DD（取落库时间） */
    date: string
    winner: PlayerId | null
    reason: 'health_zero' | 'concede' | null
    viewer: PlayerId
    turns: number
    actionCount: number
    durationMs: number
    source: string
  }
  decks: { P1: ExportedPlayerSetup; P2: ExportedPlayerSetup }
  actions: readonly Action[]
  checksum: string
}

/** 导出文档是快照：深拷贝，调用方后续改动录制体不回写文档（反之亦然） */
function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function buildReplayExportDoc(meta: ReplayMeta, body: ReplayRecording, now = Date.now()): ReplayExportDoc {
  const [p1, p2] = body.players
  return {
    kind: REPLAY_EXPORT_KIND,
    exportedAt: new Date(now).toISOString(),
    meta: {
      schemaVersion: meta.schemaVersion,
      seed: body.seed,
      date: replayDateLabel(meta.savedAt),
      winner: meta.winner,
      reason: meta.reason,
      viewer: meta.viewer,
      turns: meta.turns,
      actionCount: body.actions.length,
      durationMs: meta.durationMs,
      source: meta.source,
    },
    decks: {
      P1: { faction: p1.faction, heroName: p1.heroName, deck: cloneJson(p1.deck) },
      P2: { faction: p2.faction, heroName: p2.heroName, deck: cloneJson(p2.deck) },
    },
    actions: cloneJson(body.actions),
    checksum: stableHash(body),
  }
}

/** pretty-print：2 空格缩进（plan 定稿，人类可读可 diff） */
export function serializeReplayExportDoc(doc: ReplayExportDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}

export function replayExportDocFileName(doc: ReplayExportDoc): string {
  return `siliconcard-replay-${doc.meta.date}-${doc.meta.seed}.json`
}

export function buildReplayExportText(meta: ReplayMeta, body: ReplayRecording, now = Date.now()): { text: string; fileName: string } {
  const doc = buildReplayExportDoc(meta, body, now)
  return { text: serializeReplayExportDoc(doc), fileName: replayExportDocFileName(doc) }
}

// —— 导入 ——

export interface ParsedReplayImport {
  recording: ReplayRecording
  /** 落库用元数据（id 由调用方按 replayIdOf 补齐；source 固定 imported） */
  meta: Omit<ReplayMeta, 'id'>
}

function isExportDocShape(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === REPLAY_EXPORT_KIND
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ReplayImportError(`导出文件损坏（${path}）：应为对象`)
  }
  return value as Record<string, unknown>
}

function asPlayerId(value: unknown, fallback: PlayerId): PlayerId {
  return value === 'P1' || value === 'P2' ? value : fallback
}

function asNonNegativeInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

/** 从导出文档重建录制体（不校验——校验统一走 deserializeReplay 总闸门） */
function recordingFromExportDoc(doc: Record<string, unknown>): ReplayRecording {
  const meta = asObject(doc.meta, 'meta')
  const decks = asObject(doc.decks, 'decks')
  const p1 = asObject(decks.P1, 'decks.P1')
  const p2 = asObject(decks.P2, 'decks.P2')
  const seed = meta.seed
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0) {
    throw new ReplayImportError('导出文件损坏（meta.seed）：必须为非负整数')
  }
  if (!Array.isArray(doc.actions)) {
    throw new ReplayImportError('导出文件损坏（actions）：必须为数组')
  }
  const heroNameOf = (player: Record<string, unknown>): string | undefined =>
    typeof player.heroName === 'string' && player.heroName !== '' ? player.heroName : undefined
  return {
    seed,
    players: [
      { id: 'P1', faction: p1.faction as FactionId, heroName: heroNameOf(p1), deck: p1.deck as DeckSpec },
      { id: 'P2', faction: p2.faction as FactionId, heroName: heroNameOf(p2), deck: p2.deck as DeckSpec },
    ],
    actions: doc.actions as Action[],
  }
}

/** 裸存档（无导出信封）的元数据：无终局信息（winner/reason 空，列表显示 —） */
function bareRecordingMeta(recording: ReplayRecording, savedAt: number): Omit<ReplayMeta, 'id'> {
  return {
    savedAt,
    schemaVersion: REPLAY_SCHEMA_VERSION,
    seed: recording.seed,
    factions: factionsOf(recording),
    winner: null,
    viewer: 'P1',
    outcome: outcomeOf(null, 'P1'),
    reason: null,
    turns: 0,
    actionCount: recording.actions.length,
    durationMs: 0,
    source: 'imported',
  }
}

/** 元数据摘要清洗：summary 字段任一损坏都不致命（不影响回放），回退安全默认 */
function metaFromExportDoc(doc: Record<string, unknown>, recording: ReplayRecording, savedAt: number): Omit<ReplayMeta, 'id'> {
  const meta = asObject(doc.meta, 'meta')
  const winner = meta.winner === 'P1' || meta.winner === 'P2' ? meta.winner : null
  const reason = meta.reason === 'health_zero' || meta.reason === 'concede' ? meta.reason : null
  const viewer = asPlayerId(meta.viewer, 'P1')
  return {
    savedAt,
    schemaVersion: REPLAY_SCHEMA_VERSION,
    seed: recording.seed,
    factions: factionsOf(recording),
    winner,
    viewer,
    outcome: outcomeOf(winner, viewer),
    reason,
    turns: asNonNegativeInt(meta.turns, 0),
    actionCount: recording.actions.length,
    durationMs: asNonNegativeInt(meta.durationMs, 0),
    source: 'imported',
  }
}

/**
 * 导入解析与双校验（schemaVersion + stableHash）。
 * 任何失败抛 ReplayImportError，消息可直接展示给玩家。
 */
export function parseReplayImport(text: string, savedAt = Date.now()): ParsedReplayImport {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ReplayImportError(`文件不是合法 JSON（${error instanceof Error ? error.message : String(error)}），已拒绝导入`)
  }

  if (!isExportDocShape(raw)) {
    // 兼容裸 ReplayRecording（serializeReplay 输出 / CLI 存档）：直接走 core 总闸门
    try {
      const recording = deserializeReplay(text)
      return { recording, meta: bareRecordingMeta(recording, savedAt) }
    } catch (error) {
      throw new ReplayImportError(
        `无法识别的回放文件：缺少硅牌导出标记（kind: ${REPLAY_EXPORT_KIND}），且结构校验未通过（${error instanceof Error ? error.message : String(error)}）`,
      )
    }
  }

  const doc = raw as Record<string, unknown>
  const meta = asObject(doc.meta, 'meta')
  const fileVersion = meta.schemaVersion
  if (fileVersion !== REPLAY_SCHEMA_VERSION) {
    throw new ReplayImportError(
      `存档版本不符：文件 schemaVersion 为 ${String(fileVersion)}，当前支持 ${REPLAY_SCHEMA_VERSION}——请升级游戏版本后再导入`,
    )
  }

  const reconstructed = recordingFromExportDoc(doc)
  // 结构校验总闸门：canonicalJson 绕过二次解析，逐字段严格校验（含未知字段拒绝）。
  // schemaVersion 由本函数提前按 doc.meta 校验过（版本不符已拒），此处补齐满足
  // core 存档根结构（录制体本身不含该字段——它属于存档信封而非对局事实）。
  let recording: ReplayRecording
  try {
    recording = deserializeReplay(canonicalJson({ schemaVersion: REPLAY_SCHEMA_VERSION, ...reconstructed }))
  } catch (error) {
    throw new ReplayImportError(`存档结构校验失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const checksum = stableHash(recording)
  if (doc.checksum !== checksum) {
    throw new ReplayImportError(
      `完整性校验失败（checksum ${String(doc.checksum)} ≠ ${checksum}）：文件已损坏或被改动，已拒绝入库`,
    )
  }
  return { recording, meta: metaFromExportDoc(doc, recording, savedAt) }
}

// —— 浏览器下载辅助（纯 DOM，无头测试不触达） ——

export function downloadTextFile(fileName: string, text: string): void {
  if (typeof document === 'undefined') return
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
