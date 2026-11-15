/**
 * @siliconcard/client 教程模块（P2-EDU1）对外出口 —— 主控接线约定。
 *
 * AppRoot 挂载（1 处分支，优先于 ScreenOutlet，避免教程对战时双渲染）：
 * ```tsx
 * import { TutorialScreen, useTutorialStore, openTutorial, TutorialHintLayer } from './tutorial'
 * const tutorialOpen = useTutorialStore((s) => s.open)
 * // SiliconCardApp 渲染树顶层：
 * {tutorialOpen ? <TutorialScreen /> : <既有 ScreenOutlet 路由 />}
 * // 可选：battle 分支内挂 <TutorialHintLayer />（真实对局前 3 个己方回合提示气泡）
 * ```
 * MainMenu 挂载（主菜单「新手教程」按钮）：
 * ```tsx
 * <button onClick={() => openTutorial()}>新手教程</button>
 * ```
 * Props 约定：TutorialScreen / TutorialHintLayer 均无 props（状态走
 * useTutorialStore 与 useGameStore）；openTutorial/closeTutorial 为命令式入口。
 */

export { TutorialScreen } from './TutorialScreen'
export { TutorialHintLayer } from './TutorialHintLayer'
export { useTutorialStore } from './store'
export {
  openTutorial,
  closeTutorial,
  graduateToSetup,
  startTutorialMatch,
  allTutorialLevels,
  tutorialController,
} from './bridge'
export { TUTORIAL_LEVELS, TUTORIAL_SEEDS, tutorialLevelById } from './levels'
export { loadProgress, resetProgress, TUTORIAL_STORAGE_KEY } from './progress'
