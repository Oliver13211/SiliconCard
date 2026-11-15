/**
 * 教程 ↔ 现有界面线的桥接层（P2-EDU1）。
 *
 * 与 gameStore/battleDriver 的关系（任务边界：只 import 既有 API，零修改）：
 * - 教程对局走「联机同款帧通道」：控制器持有引擎，产出 view + legalActions +
 *   事件帧，经 gameStore.applyRemoteFrame 落地——BattleScreen/3D/音频/战报
 *   全部复用既有渲染线，教程侧零 HUD 重复实现；
 * - 玩家动作沿用 gameStore 既有动作入口（tryPlayCard/tryAttack/…）：桥接层
 *   在教程开启期间用运行时包装器替换这些入口（zustand setState 局部替换，
 *   退出时精确还原），包装器先问白名单门控（gates.ts），拦下则出教学提示，
 *   放行才调原入口——原入口在 remoteMode 下经 bindRemoteDispatch 上行到控制器；
 * - 退出教程：controller.stop + 解绑上行口 + 还原入口 + gameStore.backToMenu
 *   （清 remoteMode），再按需 goto('setup')（关5 结业进真实对局）。
 *
 * 拦截机制说明（汇报要点）：这是"不改 gameStore 源码前提下的独立拦截实现"——
 * 替换的是 store 状态里的函数引用（BattleScreen/键位/3D 拾取全部经
 * useGameStore 选择器取用，天然走包装器），不碰任何对局事实。
 */

import { bindRemoteDispatch, useGameStore } from '../store/gameStore'
import { ensureContentRegistered } from '../game/deckLoader'
import { gateAttack, gateConcede, gateEndTurn, gateHeroPower, gatePlay, gateTarget } from './gates'
import { TutorialController } from './controller'
import { TUTORIAL_LEVELS, tutorialLevelById } from './levels'
import { useTutorialStore } from './store'
import type { Action, PlayerView, TargetRef } from '@siliconcard/core'
import type { TutorialLevel } from './types'

/** 教程控制器单例（UI 与测试共用；测试可反复 startLevel/stop） */
export const tutorialController = new TutorialController()

type GameStoreActions = {
  tryPlayCard: (uid: string) => void
  tryAttack: (attackerId: string) => void
  tryHeroPower: () => void
  endTurn: () => void
  concede: () => void
  confirmTarget: (target: TargetRef) => void
}

let installed = false
const originals: GameStoreActions = {} as GameStoreActions

/** 教程开启：内容注册 + 入口包装 + 帧通道绑定 */
export function openTutorial(): void {
  if (installed) return
  ensureContentRegistered()
  ensureControllerWired()
  const store = useGameStore
  const state = store.getState()
  originals.tryPlayCard = state.tryPlayCard
  originals.tryAttack = state.tryAttack
  originals.tryHeroPower = state.tryHeroPower
  originals.endTurn = state.endTurn
  originals.concede = state.concede
  originals.confirmTarget = state.confirmTarget

  const gateOf = () => tutorialController.currentGate()
  const viewOf = (): PlayerView | null => store.getState().view
  const block = (reason?: string) => {
    if (reason) tutorialController.pushNudge(reason)
  }

  store.setState({
    tryPlayCard: (uid: string) => {
      const view = viewOf()
      if (!view || !tutorialController.isActive) return originals.tryPlayCard?.(uid)
      const decision = gatePlay(gateOf(), view, uid)
      if (!decision.allowed) return block(decision.reason)
      originals.tryPlayCard?.(uid)
    },
    tryAttack: (attackerId: string) => {
      const view = viewOf()
      if (!view || !tutorialController.isActive) return originals.tryAttack?.(attackerId)
      const decision = gateAttack(gateOf(), view, attackerId)
      if (!decision.allowed) return block(decision.reason)
      originals.tryAttack?.(attackerId)
    },
    tryHeroPower: () => {
      if (!tutorialController.isActive) return originals.tryHeroPower?.()
      const decision = gateHeroPower(gateOf())
      if (!decision.allowed) return block(decision.reason)
      originals.tryHeroPower?.()
    },
    endTurn: () => {
      const view = viewOf()
      if (!view || !tutorialController.isActive) return originals.endTurn?.()
      const decision = gateEndTurn(gateOf(), view, tutorialController.eventsSnapshot())
      if (!decision.allowed) return block(decision.reason)
      originals.endTurn?.()
    },
    concede: () => {
      if (!tutorialController.isActive) return originals.concede?.()
      block(gateConcede().reason)
    },
    confirmTarget: (target: TargetRef) => {
      const view = viewOf()
      if (!view || !tutorialController.isActive) return originals.confirmTarget?.(target)
      const decision = gateTarget(gateOf(), view, target)
      if (!decision.allowed) return block(decision.reason)
      originals.confirmTarget?.(target)
    },
  })

  bindRemoteDispatch((action: Action) => {
    const result = tutorialController.dispatchPlayerAction(action)
    if (!result.ok && result.error) tutorialController.pushNudge(result.error)
  })

  installed = true
  useTutorialStore.getState().setOpen(true)
}

/** 教程关闭：停控制器 + 解绑上行口 + 还原入口 + 清 gameStore 对局面 */
export function closeTutorial(): void {
  if (!installed) {
    useTutorialStore.getState().setOpen(false)
    return
  }
  tutorialController.stop()
  useGameStore.setState({ ...originals })
  bindRemoteDispatch(null)
  installed = false
  useTutorialStore.getState().setOpen(false)
  useGameStore.getState().backToMenu()
}

/**
 * 关5 结业：退教程并进入真实对局的设置界面（过关判定 = SetupScreen 可达）。
 * closeTutorial 已 backToMenu（清 remoteMode / 对局事实），goto 即真实主路径。
 */
export function graduateToSetup(): void {
  closeTutorial()
  useTutorialStore.getState().markLevelComplete(5)
  useGameStore.getState().goto('setup')
}

/** 开一节教程对局（关卡选择/简报页进入） */
export function startTutorialMatch(levelId: number, sectionId: string | null, faction?: string): void {
  const level = tutorialLevelById(levelId)
  if (!level) return
  const section = sectionId ? (level.sections?.find((item) => item.id === sectionId) ?? null) : null
  if (level.graduation) return // 关5 没有教程对局，走 graduateToSetup
  openTutorial()
  // 教程连开多关共用同一个 gameStore：先 backToMenu 清上一局战报/对局面
  // （remoteMode/视图/战报全部归零），再落新对局的首帧
  useGameStore.getState().backToMenu()
  const resolvedFaction = faction ?? useTutorialStore.getState().draftFaction
  tutorialController.startLevel(level, section, resolvedFaction)
  useTutorialStore.getState().showBattle(levelId, sectionId)
}

/** 重试当前关/节（清场 + 同配置重开；进度永不回退） */
export function retryTutorialMatch(): void {
  if (!tutorialController.isActive) return
  useGameStore.getState().backToMenu()
  tutorialController.retry()
}

// —— 控制器 → store / gameStore 接线（openTutorial 时挂一次）——

function wireController(): void {
  tutorialController.onFrame((frame) => {
    useGameStore.getState().applyRemoteFrame({
      view: frame.view,
      legalActions: frame.legalActions,
      events: frame.events,
      seed: frame.seed,
      fresh: false, // 开局演出事件由控制器自带（与 BattleDriver.start 同构），无需再合成
    })
  })

  tutorialController.onStatus((status) => {
    const store = useTutorialStore.getState()
    store.syncStatus(status)
    if (status.phase === 'passed') {
      if (status.sectionId) store.markSectionComplete(status.sectionId)
      if (status.levelId !== null && !status.sectionId) store.markLevelComplete(status.levelId)
      // 关3 的整关完成度由七节并集决定，在 UI 层判定（见 TutorialScreen）
    }
  })
}

let wired = false
export function ensureControllerWired(): void {
  if (wired) return
  wireController()
  wired = true
}

/** 全部关卡数据（关卡选择页用） */
export function allTutorialLevels(): readonly TutorialLevel[] {
  return TUTORIAL_LEVELS
}

/** 关3 是否七节全部完成（整关 ✓ 判定） */
export function isLevel3Complete(): boolean {
  const level = tutorialLevelById(3)
  if (!level?.sections) return false
  const progress = useTutorialStore.getState().progress
  return level.sections.every((section) => progress.sections[section.id] === true)
}
