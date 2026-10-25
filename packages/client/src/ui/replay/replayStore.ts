/**
 * replayStore —— 回放库的页面级 zustand store（P2-INF1）。
 *
 * 职责边界：
 * - 不持有任何对局事实：回放体是 core ReplayRecording（引擎黄金回放契约），
 *   元数据全部派生自 GAME_END 事件与录制体本身；
 * - 对局录制链路：battleDriver 在 GAME_END 交付 MatchRecording →
 *   recordFinishedMatch（AppRoot 注入的 sink）静默落 IndexedDB——全程不抛、
 *   不阻塞对局、不发通知轰炸（失败仅控制台留痕）；
 * - 本 store 同时承载回放库屏（ReplayScreen）的开关：独立于 gameStore 的
 *   screen 路由（回放库只从主菜单进入，不与对局屏争抢页面状态）。
 */

import { create } from 'zustand'
import { REPLAY_SCHEMA_VERSION, type ReplayRecording } from '@siliconcard/core'
import type { MatchRecording } from '../game/battleDriver'
import {
  configureReplayBackend,
  replayBackend,
  replayIdOf,
  saveReplayWithCap,
  type ReplayStorageBackend,
} from './storage'
import { buildReplayExportText, downloadTextFile, parseReplayImport, ReplayImportError } from './exportImport'
import { distinctDates, outcomeOf, replayDateLabel, type ReplayMeta } from './types'

export type ReplayStatus = { kind: 'idle' } | { kind: 'busy'; message: string } | { kind: 'notice'; message: string } | { kind: 'error'; message: string }

interface ReplayStore {
  /** 回放库屏开关（只从主菜单进出） */
  open: boolean
  entries: ReplayMeta[]
  loaded: boolean
  dateFilter: string | null
  status: ReplayStatus
  /**
   * 播放器挂载点（P2-UI3）：非 null 时 AppRoot 渲染 ReplayPlayerScreen
   * （优先级高于本库屏）。openPlayer 从库屏行内「播放」进入，closePlayer 退出。
   */
  player: { meta: ReplayMeta; body: ReplayRecording } | null

  openLibrary: () => void
  closeLibrary: () => void
  /** 进播放器：取回放体并挂载（异步装载，体缺失即报错不挂载） */
  openPlayer: (id: string) => Promise<void>
  closePlayer: () => void
  refresh: () => Promise<void>
  setDateFilter: (date: string | null) => void
  removeReplay: (id: string) => Promise<void>
  exportReplay: (id: string) => Promise<void>
  importReplayFile: (file: File) => Promise<void>
  clearStatus: () => void
}

export const useReplayStore = create<ReplayStore>()((set, get) => ({
  open: false,
  entries: [],
  loaded: false,
  dateFilter: null,
  status: { kind: 'idle' },
  player: null,

  openLibrary: () => {
    set({ open: true, status: { kind: 'idle' } })
    void get().refresh()
  },

  closeLibrary: () => set({ open: false, status: { kind: 'idle' } }),

  openPlayer: async (id) => {
    const meta = get().entries.find((entry) => entry.id === id)
    if (!meta) {
      set({ status: { kind: 'error', message: '找不到这条回放（可能刚被淘汰或删除）' } })
      return
    }
    set({ status: { kind: 'busy', message: '装载回放…' } })
    try {
      const body = await replayBackend().getBody(id)
      if (!body) {
        set({ status: { kind: 'error', message: '回放体缺失（元数据在但录制体丢了），无法播放' } })
        return
      }
      set({ player: { meta, body }, status: { kind: 'idle' } })
    } catch (error) {
      set({ status: { kind: 'error', message: `回放装载失败：${error instanceof Error ? error.message : String(error)}` } })
    }
  },

  closePlayer: () => set({ player: null, status: { kind: 'idle' } }),

  refresh: async () => {
    try {
      const entries = await replayBackend().getAllMeta()
      entries.sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : 1))
      set({ entries, loaded: true })
    } catch (error) {
      set({
        loaded: true,
        status: { kind: 'error', message: `回放库读取失败：${error instanceof Error ? error.message : String(error)}` },
      })
    }
  },

  setDateFilter: (date) => set({ dateFilter: date }),

  removeReplay: async (id) => {
    set({ status: { kind: 'busy', message: '删除中…' } })
    try {
      await replayBackend().delete(id)
      const remaining = (await replayBackend().getAllMeta()).sort((a, b) => b.savedAt - a.savedAt)
      set((prev) => ({
        entries: remaining,
        dateFilter: prev.dateFilter !== null && !remaining.some((m) => replayDateLabel(m.savedAt) === prev.dateFilter) ? null : prev.dateFilter,
        status: { kind: 'notice', message: '已删除该局回放' },
      }))
    } catch (error) {
      set({ status: { kind: 'error', message: `删除失败：${error instanceof Error ? error.message : String(error)}` } })
    }
  },

  exportReplay: async (id) => {
    set({ status: { kind: 'busy', message: '导出中…' } })
    try {
      const meta = get().entries.find((entry) => entry.id === id)
      const body = await replayBackend().getBody(id)
      if (!meta || !body) {
        set({ status: { kind: 'error', message: '回放体缺失（元数据在但录制体丢了），无法导出' } })
        return
      }
      const { text, fileName } = buildReplayExportText(meta, body)
      downloadTextFile(fileName, text)
      set({ status: { kind: 'notice', message: `已导出 ${fileName}（JSON 可读，可喂给外部 AI 分析）` } })
    } catch (error) {
      set({ status: { kind: 'error', message: `导出失败：${error instanceof Error ? error.message : String(error)}` } })
    }
  },

  importReplayFile: async (file) => {
    set({ status: { kind: 'busy', message: `导入 ${file.name}…` } })
    try {
      const text = await file.text()
      const { recording, meta } = parseReplayImport(text)
      const entry: ReplayMeta = { ...meta, id: replayIdOf(recording) }
      await saveReplayWithCap(replayBackend(), entry, recording)
      await get().refresh()
      set({ status: { kind: 'notice', message: `已导入：${file.name}（同内容回放自动去重）` } })
    } catch (error) {
      const message =
        error instanceof ReplayImportError
          ? error.message
          : `导入失败：${error instanceof Error ? error.message : String(error)}`
      // 校验拒收不入库（plan 验收：不污染回放库），只报原因
      set({ status: { kind: 'error', message } })
    }
  },

  clearStatus: () => set({ status: { kind: 'idle' } }),
}))

// —— 录制落库链路（battleDriver sink 交付物 → IndexedDB，静默） ——

/** 测试注入点：换掉存储后端（内存实现）；传 null 恢复默认 */
export function setReplayBackendForTests(backend: ReplayStorageBackend | null): void {
  configureReplayBackend(backend)
  useReplayStore.setState({ entries: [], loaded: false, dateFilter: null, status: { kind: 'idle' } })
}

/** MatchRecording → 落库对（meta 含内容寻址 id / body）——纯函数，单测直测 */
export function metaFromMatch(match: MatchRecording, savedAt = Date.now()): { meta: ReplayMeta; body: ReplayRecording } {
  const body = match.recording
  const viewer = match.viewer
  const winner = match.winner
  return {
    body,
    meta: {
      id: replayIdOf(body),
      savedAt,
      schemaVersion: REPLAY_SCHEMA_VERSION,
      seed: body.seed,
      factions: [body.players[0]?.faction ?? 'neutral', body.players[1]?.faction ?? 'neutral'],
      winner,
      viewer,
      outcome: outcomeOf(winner, viewer),
      reason: match.reason,
      turns: match.turns,
      actionCount: body.actions.length,
      durationMs: Math.max(0, match.endedAt - match.startedAt),
      source: match.source ?? 'local',
    },
  }
}

/**
 * 对局结束的静默落库入口（AppRoot 注入给 battleDriver 的 sink 实现）。
 * 铁律：绝不抛出——回放落库失败只控制台留痕，对局与结算零感知。
 */
export async function recordFinishedMatch(match: MatchRecording): Promise<void> {
  try {
    const { meta, body } = metaFromMatch(match)
    await saveReplayWithCap(replayBackend(), meta, body)
    if (useReplayStore.getState().loaded) await useReplayStore.getState().refresh()
  } catch (error) {
    console.warn('[siliconcard-replay] 本局回放未能落库（静默处理）', error)
  }
}

// —— 列表筛选（视图辅助，供 ReplayScreen 使用） ——

export function filteredEntries(entries: readonly ReplayMeta[], dateFilter: string | null): ReplayMeta[] {
  if (dateFilter === null) return [...entries]
  return entries.filter((entry) => replayDateLabel(entry.savedAt) === dateFilter)
}

export function availableDates(entries: readonly ReplayMeta[]): string[] {
  return distinctDates(entries)
}
