/**
 * 教程 UI 状态（P2-EDU1）—— 界面态 + 进度镜像，与对局事实分离。
 *
 * 对局事实一律来自 controller 推送的 TutorialStatus / 帧（gameStore 视图），
 * 本 store 不自行推导任何对局状态（架构铁律 3）。进度是唯一的本地持久化面
 * （localStorage，见 progress.ts），且只有"已完成"并集语义。
 */

import { create } from 'zustand'
import {
  emptyProgress,
  loadProgress,
  resetProgress,
  saveProgress,
  withLevelComplete,
  withSectionComplete,
  type TutorialProgress,
} from './progress'
import type { TutorialStatus } from './types'

export type TutorialScreen = 'levels' | 'brief' | 'battle'

interface TutorialStore {
  open: boolean
  screen: TutorialScreen
  /** 当前简报/对局的关卡与分节（关3 分节制） */
  levelId: number | null
  sectionId: string | null
  /** 关4 玩家自选派系（简报页选择，开局时交给 controller） */
  draftFaction: string
  /** 控制器状态快照（气泡/步骤/目标/拦截提示/phase） */
  status: TutorialStatus | null
  progress: TutorialProgress

  setOpen: (open: boolean) => void
  showLevels: () => void
  showBrief: (levelId: number) => void
  showBattle: (levelId: number, sectionId: string | null) => void
  setDraftFaction: (faction: string) => void
  syncStatus: (status: TutorialStatus) => void
  markLevelComplete: (levelId: number) => void
  markSectionComplete: (sectionId: string) => void
  resetAll: () => void
}

const idleStatus: TutorialStatus = {
  phase: 'idle',
  levelId: null,
  sectionId: null,
  stepIndex: 0,
  bubble: null,
  objectiveLabel: '',
  objectiveProgress: null,
  nudge: null,
}

export const useTutorialStore = create<TutorialStore>()((set) => ({
  open: false,
  screen: 'levels',
  levelId: null,
  sectionId: null,
  draftFaction: 'neutral',
  status: idleStatus,
  progress: loadProgress(),

  setOpen: (open) => set({ open }),
  showLevels: () => set({ screen: 'levels' }),
  showBrief: (levelId) => set({ screen: 'brief', levelId, sectionId: null }),
  showBattle: (levelId, sectionId) => set({ screen: 'battle', levelId, sectionId }),
  setDraftFaction: (faction) => set({ draftFaction: faction }),
  syncStatus: (status) => set({ status }),

  markLevelComplete: (levelId) =>
    set((prev) => {
      const progress = withLevelComplete(prev.progress, levelId)
      saveProgress(progress)
      return { progress }
    }),

  markSectionComplete: (sectionId) =>
    set((prev) => {
      const progress = withSectionComplete(prev.progress, sectionId)
      saveProgress(progress)
      return { progress }
    }),

  resetAll: () => set({ progress: resetProgress() }),
}))

/** 关卡选择页兜底：进度对象缺字段时回落空进度（防御手改存储） */
export function safeProgress(progress: TutorialProgress | undefined): TutorialProgress {
  return progress ?? emptyProgress()
}
