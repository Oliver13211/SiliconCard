/**
 * uiPrefsStore —— UI 偏好（纯界面层，非对局事实）的唯一 zustand store。
 *
 * 目前承载：动效偏好 motion（'auto' 跟随系统 prefers-reduced-motion / 'on' 强制全开 /
 * 'off' 强制关闭），localStorage 持久化（key: siliconcard.ui-prefs.v1，解析容错，
 * 存储不可用/写入失败静默回落默认）。AppRoot 读取后落到 .sc-app[data-motion]，
 * motion.css 按三档接管动效开关。
 */

import { create } from 'zustand'

export type MotionPref = 'auto' | 'on' | 'off'

export interface UiPrefs {
  motion: MotionPref
}

export const UI_PREFS_STORAGE_KEY = 'siliconcard.ui-prefs.v1'
export const MOTION_PREFS: readonly MotionPref[] = ['auto', 'on', 'off']

/** 容错解析：非法值一律回落 'auto' */
export function parseMotionPref(raw: unknown): MotionPref {
  return raw === 'on' || raw === 'off' ? raw : 'auto'
}

type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): MinimalStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

/** 读取持久化偏好；存储缺失/JSON 损坏/字段非法一律回落默认（{ motion: 'auto' }） */
export function loadUiPrefs(storage: MinimalStorage | undefined = defaultStorage()): UiPrefs {
  if (!storage) return { motion: 'auto' }
  try {
    const raw = storage.getItem(UI_PREFS_STORAGE_KEY)
    if (!raw) return { motion: 'auto' }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { motion: 'auto' }
    return { motion: parseMotionPref((parsed as { motion?: unknown }).motion) }
  } catch {
    return { motion: 'auto' }
  }
}

/** 写入持久化偏好；存储不可用时静默（内存态仍然生效） */
export function saveUiPrefs(prefs: UiPrefs, storage: MinimalStorage | undefined = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 隐私模式/配额满等场景：不因偏好持久化失败打断界面
  }
}

interface UiPrefsState extends UiPrefs {
  setMotion: (motion: MotionPref) => void
}

export const useUiPrefs = create<UiPrefsState>()((set) => ({
  ...loadUiPrefs(),

  setMotion: (motion) => {
    saveUiPrefs({ motion })
    set({ motion: parseMotionPref(motion) })
  },
}))

/** 测试隔离：恢复默认值（不动 localStorage） */
export function resetUiPrefsForTests(): void {
  useUiPrefs.setState({ motion: 'auto' })
}
