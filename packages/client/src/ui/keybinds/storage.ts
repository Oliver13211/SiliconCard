/**
 * 键位持久化（P2-UI5）——localStorage `siliconcard.keybinds.v1`，版本化 schema。
 *
 * 容错原则（对齐 uiPrefsStore 模式）：
 * - 存储缺失 / JSON 损坏 / 顶层不是对象 / version !== 1 → 整体回落默认键位；
 * - 单条键位格式非法、浏览器保留键、未知命令 id、scope 相交的重复 combo →
 *   该条回落默认（sanitizeBinds 净化），其余条目照常生效；
 * - 写入失败（隐私模式/配额满）静默：内存态照常生效，不打断界面。
 */

import { sanitizeBinds, type BindMap } from './bindings'

export const KEYBINDS_STORAGE_KEY = 'siliconcard.keybinds.v1'
export const KEYBINDS_SCHEMA_VERSION = 1

export interface KeybindsPayload {
  binds: BindMap
  /** 手牌槽位键位角标默认显示（plan §5：可开关） */
  hintsVisible: boolean
}

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): MinimalStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/** 读取持久化键位；任何异常一律回落默认（损坏不报错） */
export function loadKeybinds(storage: MinimalStorage | undefined = defaultStorage()): KeybindsPayload {
  const fallback: KeybindsPayload = { binds: sanitizeBinds(null), hintsVisible: true }
  if (!storage) return fallback
  try {
    const raw = storage.getItem(KEYBINDS_STORAGE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const record = parsed as { version?: unknown; binds?: unknown; hintsVisible?: unknown }
    // 版本化 schema：版本不认识的载荷整体弃用（未来 v2 自带迁移逻辑）
    if (record.version !== KEYBINDS_SCHEMA_VERSION) return fallback
    return {
      binds: sanitizeBinds((record.binds ?? null) as Partial<Record<string, string>> | null),
      hintsVisible: typeof record.hintsVisible === 'boolean' ? record.hintsVisible : true,
    }
  } catch {
    return fallback
  }
}

/** 写入持久化键位；存储不可用时静默（调用方内存态仍然生效） */
export function saveKeybinds(payload: KeybindsPayload, storage: MinimalStorage | undefined = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(
      KEYBINDS_STORAGE_KEY,
      JSON.stringify({
        version: KEYBINDS_SCHEMA_VERSION,
        binds: payload.binds,
        hintsVisible: payload.hintsVisible,
      }),
    )
  } catch {
    // 隐私模式/配额满等场景：不因偏好持久化失败打断界面
  }
}
