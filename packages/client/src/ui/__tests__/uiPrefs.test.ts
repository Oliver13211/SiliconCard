/**
 * uiPrefsStore 单测（UI 现代化）：动效偏好解析 / 持久化 / 容错。
 * 不触碰真实 localStorage（全部经注入的内存 fake storage）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  MOTION_PREFS,
  UI_PREFS_STORAGE_KEY,
  loadUiPrefs,
  parseMotionPref,
  resetUiPrefsForTests,
  saveUiPrefs,
  useUiPrefs,
  type MotionPref,
} from '../store/uiPrefsStore'

/** 最小内存版 storage（实现 Storage 的 getItem/setItem 子集） */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  let failWrites = false
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error('quota exceeded')
      map.set(key, value)
    },
    /** 测试辅助：让写入抛错（隐私模式/配额满） */
    failWrites() {
      failWrites = true
    },
    dump: () => Object.fromEntries(map.entries()),
  }
}

describe('parseMotionPref', () => {
  it('接受合法三档值', () => {
    expect(parseMotionPref('auto')).toBe('auto')
    expect(parseMotionPref('on')).toBe('on')
    expect(parseMotionPref('off')).toBe('off')
  })

  it('非法/缺失值一律回落 auto', () => {
    expect(parseMotionPref('full')).toBe('auto')
    expect(parseMotionPref(42)).toBe('auto')
    expect(parseMotionPref(null)).toBe('auto')
    expect(parseMotionPref(undefined)).toBe('auto')
    expect(parseMotionPref({ motion: 'on' })).toBe('auto')
  })
})

describe('loadUiPrefs', () => {
  it('无存储或无记录时回落默认 { motion: auto }', () => {
    expect(loadUiPrefs(undefined)).toEqual({ motion: 'auto' })
    expect(loadUiPrefs(fakeStorage())).toEqual({ motion: 'auto' })
  })

  it('读取合法持久化 JSON', () => {
    const storage = fakeStorage({ [UI_PREFS_STORAGE_KEY]: JSON.stringify({ motion: 'off' }) })
    expect(loadUiPrefs(storage)).toEqual({ motion: 'off' })
  })

  it('JSON 损坏 / 字段非法 / 非对象载荷都回落 auto', () => {
    const broken = fakeStorage({ [UI_PREFS_STORAGE_KEY]: '{not-json' })
    expect(loadUiPrefs(broken)).toEqual({ motion: 'auto' })

    const invalid = fakeStorage({ [UI_PREFS_STORAGE_KEY]: JSON.stringify({ motion: 'warp' }) })
    expect(loadUiPrefs(invalid)).toEqual({ motion: 'auto' })

    const notObject = fakeStorage({ [UI_PREFS_STORAGE_KEY]: JSON.stringify('off') })
    expect(loadUiPrefs(notObject)).toEqual({ motion: 'auto' })
  })
})

describe('saveUiPrefs / useUiPrefs', () => {
  beforeEach(() => {
    resetUiPrefsForTests()
  })

  it('写入可被 loadUiPrefs 读回（roundtrip）', () => {
    const storage = fakeStorage()
    MOTION_PREFS.forEach((motion: MotionPref) => {
      saveUiPrefs({ motion }, storage)
      expect(loadUiPrefs(storage)).toEqual({ motion })
    })
  })

  it('写入失败静默（不抛错）', () => {
    const storage = fakeStorage()
    storage.failWrites()
    expect(() => saveUiPrefs({ motion: 'on' }, storage)).not.toThrow()
    expect(loadUiPrefs(storage)).toEqual({ motion: 'auto' })
  })

  it('setMotion 更新 store 并持久化', () => {
    const storage = fakeStorage()
    useUiPrefs.getState().setMotion('off')
    expect(useUiPrefs.getState().motion).toBe('off')
    saveUiPrefs({ motion: useUiPrefs.getState().motion }, storage)
    expect(loadUiPrefs(storage)).toEqual({ motion: 'off' })
  })

  it('setMotion 对非法输入防御性回落 auto', () => {
    // 运行时类型注解为 MotionPref，但对外部输入保持容错（与 parseMotionPref 一致）
    useUiPrefs.getState().setMotion('warp' as MotionPref)
    expect(useUiPrefs.getState().motion).toBe('auto')
  })
})
