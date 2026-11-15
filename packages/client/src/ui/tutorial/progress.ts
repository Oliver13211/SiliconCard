/**
 * 教程进度持久化（P2-EDU1）—— localStorage `siliconcard.tutorial.v1`，版本化 schema。
 *
 * 容错原则对齐 keybinds/storage.ts：缺失/损坏/版本不符 → 回落空进度；
 * 写入失败（隐私模式/配额满）静默。跳关解锁（任意关卡直达），重玩不破坏进度：
 * 本 store 只做"已完成"集合的并集写入，没有任何锁级/回退语义。
 */

export const TUTORIAL_STORAGE_KEY = 'siliconcard.tutorial.v1'
export const TUTORIAL_SCHEMA_VERSION = 1

export interface TutorialProgress {
  version: number
  /** 已完成关卡 id（1..5） */
  levels: Record<number, boolean>
  /** 关3 已完成分节 id（'s1'..'s7'） */
  sections: Record<string, boolean>
}

export type MinimalStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): MinimalStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

export function emptyProgress(): TutorialProgress {
  return { version: TUTORIAL_SCHEMA_VERSION, levels: {}, sections: {} }
}

function sanitize(raw: unknown): TutorialProgress {
  if (typeof raw !== 'object' || raw === null) return emptyProgress()
  const record = raw as { version?: unknown; levels?: unknown; sections?: unknown }
  if (record.version !== TUTORIAL_SCHEMA_VERSION) return emptyProgress()
  const progress = emptyProgress()
  if (typeof record.levels === 'object' && record.levels !== null) {
    for (const [key, value] of Object.entries(record.levels as Record<string, unknown>)) {
      const id = Number(key)
      if (Number.isInteger(id) && id >= 1 && id <= 5 && value === true) progress.levels[id] = true
    }
  }
  if (typeof record.sections === 'object' && record.sections !== null) {
    for (const [key, value] of Object.entries(record.sections as Record<string, unknown>)) {
      if (/^s[1-7]$/.test(key) && value === true) progress.sections[key] = true
    }
  }
  return progress
}

/** 读取进度；任何异常一律回落空进度（损坏不报错） */
export function loadProgress(storage: MinimalStorage | undefined = defaultStorage()): TutorialProgress {
  if (!storage) return emptyProgress()
  try {
    const raw = storage.getItem(TUTORIAL_STORAGE_KEY)
    if (!raw) return emptyProgress()
    return sanitize(JSON.parse(raw))
  } catch {
    return emptyProgress()
  }
}

/** 写入进度；存储不可用时静默（内存态仍然生效） */
export function saveProgress(progress: TutorialProgress, storage: MinimalStorage | undefined = defaultStorage()): void {
  if (!storage) return
  try {
    storage.setItem(TUTORIAL_STORAGE_KEY, JSON.stringify(progress))
  } catch {
    // 隐私模式/配额满：不因进度持久化失败打断教程
  }
}

/** 并集写入：完成某关（已完成的保持完成，永不回退） */
export function withLevelComplete(progress: TutorialProgress, levelId: number): TutorialProgress {
  return { ...progress, levels: { ...progress.levels, [levelId]: true } }
}

/** 并集写入：完成关3某节 */
export function withSectionComplete(progress: TutorialProgress, sectionId: string): TutorialProgress {
  return { ...progress, sections: { ...progress.sections, [sectionId]: true } }
}

export function isLevelComplete(progress: TutorialProgress, levelId: number): boolean {
  return progress.levels[levelId] === true
}

export function isSectionComplete(progress: TutorialProgress, sectionId: string): boolean {
  return progress.sections[sectionId] === true
}

/** 全部重置（关卡选择页「从头再来」用；二次确认在 UI 层） */
export function resetProgress(storage: MinimalStorage | undefined = defaultStorage()): TutorialProgress {
  const fresh = emptyProgress()
  saveProgress(fresh, storage)
  return fresh
}
