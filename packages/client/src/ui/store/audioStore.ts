/**
 * 音频设置 store（M4-SND1）——AudioControls 的唯一状态源。
 *
 * 薄桥接层：纯逻辑（校验/钳制/持久化）在 three/audio/settings（可无头测试），
 * 引擎生效在 three/audio/director（setSettings → 总线与 BGM 门），这里只做
 * 「React 状态 ↔ 引擎 + localStorage」的同步。字段默认值来自持久化存储
 * （无 localStorage 环境自动回落默认：音效开、音量 80%、BGM 开）。
 */

import { create } from 'zustand'
import {
  clampVolume,
  DEFAULT_AUDIO_SETTINGS,
  loadAudioSettings,
  saveAudioSettings,
  type AudioSettings,
} from '../../three/audio/settings'
import { getAudioDirector } from '../../three/audio/director'

interface AudioStoreState extends AudioSettings {
  toggleMuted(): void
  setVolume(volume: number): void
  toggleBgm(): void
}

/** 任何变更都同步：引擎生效 + localStorage 持久化（存储失败静默） */
function commit(next: AudioSettings): void {
  saveAudioSettings(next)
  getAudioDirector()?.setSettings(next)
}

export const useAudioStore = create<AudioStoreState>()((set, get) => {
  const initial = loadAudioSettings()
  return {
    muted: initial.muted,
    volume: initial.volume,
    bgmEnabled: initial.bgmEnabled,

    toggleMuted: () => {
      const next: AudioSettings = { muted: !get().muted, volume: get().volume, bgmEnabled: get().bgmEnabled }
      commit(next)
      set(next)
    },

    setVolume: (volume) => {
      const next: AudioSettings = { muted: get().muted, volume: clampVolume(volume), bgmEnabled: get().bgmEnabled }
      commit(next)
      set(next)
    },

    toggleBgm: () => {
      const next: AudioSettings = { muted: get().muted, volume: get().volume, bgmEnabled: !get().bgmEnabled }
      commit(next)
      set(next)
    },
  }
})

/** 测试隔离：恢复默认值并同步引擎（不动 localStorage） */
export function resetAudioStoreForTests(): void {
  useAudioStore.setState({ ...DEFAULT_AUDIO_SETTINGS })
  getAudioDirector()?.setSettings({ ...DEFAULT_AUDIO_SETTINGS })
}
