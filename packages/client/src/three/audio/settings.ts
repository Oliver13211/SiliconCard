/**
 * 音频设置状态机（M4-SND1）——主音量/静音 + BGM 开关，localStorage 持久化。
 *
 * 纯逻辑与 IO 分离：load/save 接受注入的读写函数，默认绑定守卫后的
 * localStorage（无 window / 被禁用 / 抛异常时静默降级为「不读写」，
 * 设置回落默认值——无头测试与隐私模式绝不崩）。默认：音效开、音量 0.8、
 * BGM 开（首次出声需用户手势解锁是浏览器自动播放策略，非遗漏）。
 */

export interface AudioSettings {
  /** 主音量静音（同时作用于事件音与 BGM） */
  muted: boolean
  /** 主音量 0..1 */
  volume: number
  /** BGM 独立开关（对局内循环；关掉后只剩事件音） */
  bgmEnabled: boolean
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = { muted: false, volume: 0.8, bgmEnabled: true }

/** localStorage 键（版本化：结构变更时换 v2，旧值自然废弃） */
export const AUDIO_SETTINGS_KEY = 'siliconcard.audio.v1'

/** JSON 串 → 设置（缺字段/越界/类型错逐字段兜底，永不抛） */
export function parseAudioSettings(raw: string | null): AudioSettings {
  if (raw === null || raw.trim() === '') return { ...DEFAULT_AUDIO_SETTINGS }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS } // 损坏数据 → 默认值，不崩
  }
  if (typeof data !== 'object' || data === null) return { ...DEFAULT_AUDIO_SETTINGS }
  const obj = data as Record<string, unknown>
  return {
    muted: typeof obj.muted === 'boolean' ? obj.muted : DEFAULT_AUDIO_SETTINGS.muted,
    volume: clampVolume(obj.volume),
    bgmEnabled: typeof obj.bgmEnabled === 'boolean' ? obj.bgmEnabled : DEFAULT_AUDIO_SETTINGS.bgmEnabled,
  }
}

/** 音量钳制：非数值 → 默认；越界 → 边界值 */
export function clampVolume(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return DEFAULT_AUDIO_SETTINGS.volume
  return Math.min(1, Math.max(0, value))
}

export type SettingsReader = (key: string) => string | null
export type SettingsWriter = (key: string, value: string) => void

/** 从注入存储读设置（读取抛异常按缺失处理） */
export function loadAudioSettingsFrom(read: SettingsReader): AudioSettings {
  try {
    return parseAudioSettings(read(AUDIO_SETTINGS_KEY))
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS }
  }
}

/** 写设置到注入存储（写入抛异常静默——存储满/禁用不影响对局） */
export function saveAudioSettingsTo(settings: AudioSettings, write: SettingsWriter): void {
  const safe: AudioSettings = {
    muted: settings.muted === true,
    volume: clampVolume(settings.volume),
    bgmEnabled: settings.bgmEnabled === true,
  }
  try {
    write(AUDIO_SETTINGS_KEY, JSON.stringify(safe))
  } catch {
    // 存储不可用：设置仍在本会话内生效，只是不持久化
  }
}

// —— 默认 localStorage 绑定（浏览器守卫：无 window（node/无头）或存储被禁用时静默降级） ——

/** 仅浏览器环境启用默认读写（node 22+ 的实验性 localStorage 全局会告警，一并排除） */
function inBrowser(): boolean {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined'
}

function localStorageReader(): SettingsReader {
  return (key) => {
    if (!inBrowser()) return null
    return localStorage.getItem(key)
  }
}

function localStorageWriter(): SettingsWriter {
  return (key, value) => {
    if (!inBrowser()) return
    localStorage.setItem(key, value)
  }
}

export function loadAudioSettings(): AudioSettings {
  return loadAudioSettingsFrom(localStorageReader())
}

export function saveAudioSettings(settings: AudioSettings): void {
  saveAudioSettingsTo(settings, localStorageWriter())
}
