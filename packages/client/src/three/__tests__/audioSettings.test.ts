/**
 * M4-SND1 无头测试：音频设置状态机（主音量/静音 + BGM 开关 + localStorage 持久化）。
 * 覆盖：默认值、往返读写、损坏数据降级、越界钳制、存储抛异常不崩。
 */

import { describe, expect, it } from 'vitest'
import {
  AUDIO_SETTINGS_KEY,
  DEFAULT_AUDIO_SETTINGS,
  clampVolume,
  loadAudioSettingsFrom,
  parseAudioSettings,
  saveAudioSettingsTo,
} from '../audio/settings'
import type { SettingsReader, SettingsWriter } from '../audio/settings'

/** 内存存储（模拟 localStorage 语义） */
function memoryStorage() {
  const map = new Map<string, string>()
  const read: SettingsReader = (key) => map.get(key) ?? null
  const write: SettingsWriter = (key, value) => void map.set(key, value)
  return { map, read, write }
}

describe('parseAudioSettings（JSON → 设置）', () => {
  it('null / 空串 / 非 JSON / 非对象 → 完整默认值', () => {
    for (const raw of [null, '', '   ', '{broken', '"str"', '42', '[]']) {
      expect(parseAudioSettings(raw), `raw=${String(raw)}`).toEqual(DEFAULT_AUDIO_SETTINGS)
    }
  })

  it('完整 JSON 往返', () => {
    const raw = JSON.stringify({ muted: true, volume: 0.35, bgmEnabled: false })
    expect(parseAudioSettings(raw)).toEqual({ muted: true, volume: 0.35, bgmEnabled: false })
  })

  it('缺字段逐项回落默认，类型不符的字段回落、合法字段保留', () => {
    expect(parseAudioSettings('{}')).toEqual(DEFAULT_AUDIO_SETTINGS)
    expect(parseAudioSettings(JSON.stringify({ muted: true }))).toEqual({
      ...DEFAULT_AUDIO_SETTINGS,
      muted: true,
    })
    expect(parseAudioSettings(JSON.stringify({ volume: 'loud', bgmEnabled: false }))).toEqual({
      ...DEFAULT_AUDIO_SETTINGS,
      bgmEnabled: false,
    })
  })

  it('音量越界钳制到 [0,1]，非法音量回落默认', () => {
    expect(parseAudioSettings(JSON.stringify({ volume: 2 })).volume).toBe(1)
    expect(parseAudioSettings(JSON.stringify({ volume: -1 })).volume).toBe(0)
    expect(parseAudioSettings(JSON.stringify({ volume: Number.NaN })).volume).toBe(
      DEFAULT_AUDIO_SETTINGS.volume,
    )
    expect(parseAudioSettings(JSON.stringify({ volume: 'x' })).volume).toBe(DEFAULT_AUDIO_SETTINGS.volume)
  })
})

describe('clampVolume', () => {
  it('数值钳制 / 非数值默认', () => {
    expect(clampVolume(0.5)).toBe(0.5)
    expect(clampVolume(5)).toBe(1)
    expect(clampVolume(-3)).toBe(0)
    expect(clampVolume(undefined)).toBe(DEFAULT_AUDIO_SETTINGS.volume)
    expect(clampVolume('x')).toBe(DEFAULT_AUDIO_SETTINGS.volume)
  })
})

describe('load/save（注入存储）', () => {
  it('往返：save 后 load 得到等值设置', () => {
    const store = memoryStorage()
    const settings = { muted: true, volume: 0.4, bgmEnabled: false }
    saveAudioSettingsTo(settings, store.write)
    expect(store.map.has(AUDIO_SETTINGS_KEY)).toBe(true)
    expect(loadAudioSettingsFrom(store.read)).toEqual(settings)
  })

  it('键缺失 → 默认值', () => {
    const store = memoryStorage()
    expect(loadAudioSettingsFrom(store.read)).toEqual(DEFAULT_AUDIO_SETTINGS)
  })

  it('读取抛异常 → 默认值（守卫降级不崩）', () => {
    const read: SettingsReader = () => {
      throw new Error('storage blocked')
    }
    expect(loadAudioSettingsFrom(read)).toEqual(DEFAULT_AUDIO_SETTINGS)
  })

  it('写入抛异常 → 静默（设置仍在会话内可用）', () => {
    const write: SettingsWriter = () => {
      throw new Error('quota exceeded')
    }
    expect(() => saveAudioSettingsTo({ muted: true, volume: 0.2, bgmEnabled: true }, write)).not.toThrow()
  })

  it('save 写入前钳制非法字段（持久化值总是干净）', () => {
    const store = memoryStorage()
    saveAudioSettingsTo({ muted: true, volume: 7, bgmEnabled: true }, store.write)
    expect(loadAudioSettingsFrom(store.read).volume).toBe(1)
  })
})
