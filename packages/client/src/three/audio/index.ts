/**
 * @siliconcard/client 音频线（src/three/audio）公开出口（M4-SND1）。
 *
 * 职责：Web Audio 程序化音效（17 种 GameEvent 全覆盖，与 eventAnimationMap
 * 同一事件源同层级）+ 程序化 BGM + 设置持久化。零音频资产、零外部依赖、
 * 零网络请求；不可用环境静默降级。
 *
 * 接线（AppRoot）：
 * ```tsx
 * useEffect(() => initAudio({
 *   getViewer: () => useGameStore.getState().view?.viewer ?? 'P1',
 *   subscribeEvents: onBattleEvents,
 * }), [])
 * ```
 * 对局屏（Table3DMount effect）：`getAudioDirector()?.setBattleActive(true)`，
 * 卸载时 `setBattleActive(false)` —— BGM 随对局起停。
 */

export { createAudioDirector, initAudio, getAudioDirector, resetAudioForTests } from './director'
export type { AudioDirector, AudioWiring } from './director'
export { resolveEventSound, eventSoundMap } from './soundMap'
export type { EventSound, EventSoundMap } from './soundMap'
export {
  loadAudioSettings,
  saveAudioSettings,
  loadAudioSettingsFrom,
  saveAudioSettingsTo,
  parseAudioSettings,
  clampVolume,
  DEFAULT_AUDIO_SETTINGS,
  AUDIO_SETTINGS_KEY,
} from './settings'
export type { AudioSettings, SettingsReader, SettingsWriter } from './settings'
export { Synth, MAX_VOICES } from './synth'
export type { SynthDeps, AudioContextFactory } from './synth'
export { BgmController } from './bgm'
export { tone, noise, specProblems, layerProblems } from './spec'
export type { SoundSpec, SoundLayer, ToneLayerSpec, NoiseLayerSpec, Waveform } from './spec'
