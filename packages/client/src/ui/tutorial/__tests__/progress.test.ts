/**
 * 教程进度存取单测（P2-EDU1 定向测试）—— 注入式 storage，容错与并集语义。
 */

import { describe, expect, it } from 'vitest'
import {
  emptyProgress,
  isLevelComplete,
  isSectionComplete,
  loadProgress,
  resetProgress,
  saveProgress,
  withLevelComplete,
  withSectionComplete,
  type MinimalStorage,
} from '../progress'

function fakeStorage(): MinimalStorage & { dump: () => string | null } {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    dump: () => map.get('siliconcard.tutorial.v1') ?? null,
  }
}

describe('进度读取', () => {
  it('空存储 → 空进度（跳关解锁：无锁级概念）', () => {
    expect(loadProgress(fakeStorage())).toEqual(emptyProgress())
  })

  it('存储缺失（SSR/隐私）→ 空进度', () => {
    expect(loadProgress(undefined)).toEqual(emptyProgress())
  })

  it('JSON 损坏 → 回落空进度不抛错', () => {
    const storage = fakeStorage()
    storage.setItem('siliconcard.tutorial.v1', '{{{not-json')
    expect(loadProgress(storage)).toEqual(emptyProgress())
  })

  it('版本不符 → 整体弃用', () => {
    const storage = fakeStorage()
    storage.setItem('siliconcard.tutorial.v1', JSON.stringify({ version: 99, levels: { 1: true } }))
    expect(loadProgress(storage)).toEqual(emptyProgress())
  })

  it('非法条目过滤：levels 只认 1..5，sections 只认 s1..s7', () => {
    const storage = fakeStorage()
    storage.setItem(
      'siliconcard.tutorial.v1',
      JSON.stringify({ version: 1, levels: { 1: true, 9: true, x: true, 2: 'yes' }, sections: { s3: true, s99: true } }),
    )
    const progress = loadProgress(storage)
    expect(progress.levels).toEqual({ 1: true })
    expect(progress.sections).toEqual({ s3: true })
  })
})

describe('进度写入与并集语义', () => {
  it('完成关卡：写入并落盘', () => {
    const storage = fakeStorage()
    const progress = withLevelComplete(emptyProgress(), 2)
    saveProgress(progress, storage)
    const reloaded = loadProgress(storage)
    expect(isLevelComplete(reloaded, 2)).toBe(true)
    expect(isLevelComplete(reloaded, 1)).toBe(false)
  })

  it('完成分节：写入并落盘', () => {
    const storage = fakeStorage()
    saveProgress(withSectionComplete(withLevelComplete(emptyProgress(), 3), 's5'), storage)
    const reloaded = loadProgress(storage)
    expect(isSectionComplete(reloaded, 's5')).toBe(true)
  })

  it('重玩不破坏进度：重复完成/其他关完成互不影响（纯并集）', () => {
    let progress = withLevelComplete(emptyProgress(), 1)
    progress = withLevelComplete(progress, 1) // 重玩 = 重复标记
    progress = withSectionComplete(progress, 's1')
    progress = withLevelComplete(progress, 4)
    expect(progress.levels).toEqual({ 1: true, 4: true })
    expect(progress.sections).toEqual({ s1: true })
  })

  it('写失败（异常 storage）静默不抛', () => {
    const broken: MinimalStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    }
    expect(() => saveProgress(withLevelComplete(emptyProgress(), 1), broken)).not.toThrow()
  })
})

describe('重置', () => {
  it('resetProgress 清空并落盘', () => {
    const storage = fakeStorage()
    saveProgress(withLevelComplete(emptyProgress(), 5), storage)
    const fresh = resetProgress(storage)
    expect(fresh).toEqual(emptyProgress())
    expect(loadProgress(storage)).toEqual(emptyProgress())
  })
})
