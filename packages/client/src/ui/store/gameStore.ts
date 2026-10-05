/**
 * gameStore —— 对局界面的唯一 zustand store（M1-UI1..3）。
 *
 * 硬约束（预设 + 架构铁律 3）：
 * - 对局事实只来自引擎：store 只持有 viewFor 视图 / getLegalActions 合法动作 /
 *   GameEvent 事件衍生的战报，完整 GameState 封在 BattleDriver 内，UI 不可触达；
 * - 可交互性由 getLegalActions 驱动（deriveInteractivity），非法操作禁用并给梗化原因；
 * - 本 store 同时是 3D 线的接入面：onBattleEvents 事件口 + 动作入口函数
 *   （见 src/ui/index.ts 导出），3D 拾取与动画不进 React 渲染树也能驱动对局。
 */

import { create } from 'zustand'
import {
  RuleError,
  type Action,
  type FactionId,
  type GameEvent,
  type PlayerView,
  type TargetRef,
} from '@siliconcard/core'
import { BattleDriver, type DispatchReport } from '../game/battleDriver'
import { createBot } from '../game/bot'
import type { AiPlayer } from '@siliconcard/ai'
import { eventsToLogEntries, gameEndOf, type LogEntry } from '../game/eventLog'
import {
  attackStatusOf,
  deriveInteractivity,
  handCardStatus,
  heroPowerStatus,
  targetKey,
  endTurnStatus,
  type Interactivity,
} from '../game/legal'
import {
  RANDOM_DECK_OPTION,
  buildFallbackDeck,
  deckOptions,
  ensureContentRegistered,
  resolveDeckChoice,
  type ContentReport,
} from '../game/deckLoader'
import { buildResult, type ResultData } from '../game/result'
import { synthesizeOpeningEvents } from '../game/opening'
import { FACTION_DISPLAY } from '../game/fallbackContent'

export type Screen = 'menu' | 'setup' | 'battle' | 'result' | 'rules' | 'lan'

export interface TargetingState {
  kind: 'play' | 'attack' | 'heroPower'
  uid: string | null
  attackerId: string | null
  targets: readonly TargetRef[]
}

export interface BattleConfig {
  playerFaction: FactionId
  opponentFaction: FactionId
  deckId: string
  deckLabel: string
  seed: number
}

export interface UiError {
  code: string
  message: string
}

/** 联机对局帧（M2-UI4）：lanStore 经 LanClient 从服务端帧落地（协议 docs/protocol.md §4） */
export interface RemoteFrameInput {
  view: PlayerView
  legalActions: readonly Action[]
  events: readonly GameEvent[]
  /** 对局种子（开局 sync 提供；恢复对局中盘可能为 null → 记 0 仅作展示） */
  seed: number | null
  /**
   * 是否为「大厅开局后的第一帧」（started → sync）：true 且视图处于第 1 回合时
   * 合成开局事件补齐战报/3D 演出（与本地 BattleDriver.start 同构，rules.md §2.1/§6）。
   * 断线恢复/回放续帧恒为 false，不补造历史事件。
   */
  fresh: boolean
}

interface GameStore {
  screen: Screen
  rulesReturn: Screen
  // 对局事实（引擎唯一事实源的投影）
  view: PlayerView | null
  legalActions: readonly Action[]
  interactivity: Interactivity | null
  log: readonly LogEntry[]
  targeting: TargetingState | null
  result: ResultData | null
  // 界面状态
  lastError: UiError | null
  contentNotice: string | null
  deckList: { id: string; name: string; degraded: boolean }[]
  draftFaction: FactionId
  draftDeckId: string
  draftOpponentFaction: FactionId | 'random'
  config: BattleConfig | null
  /** 联机模式（M2-UI4）：true 时对局事实来自服务端帧，动作原样上行（客户端零引擎逻辑） */
  remoteMode: boolean

  goto: (screen: Screen) => void
  openRules: () => void
  closeRules: () => void
  setDraftFaction: (faction: FactionId) => void
  setDraftDeck: (deckId: string) => void
  setDraftOpponentFaction: (faction: FactionId | 'random') => void
  startBattle: (options?: { seed?: number }) => void
  tryPlayCard: (uid: string) => void
  tryAttack: (attackerId: string) => void
  tryHeroPower: () => void
  endTurn: () => void
  concede: () => void
  confirmTarget: (target: TargetRef) => void
  cancelTargeting: () => void
  botTick: () => void
  rematch: () => void
  backToMenu: () => void
  clearError: () => void
  /** 联机对局帧落地（M2-UI4）：lanStore 经 LanClient 调用；首帧自动进入 battle 屏 */
  applyRemoteFrame: (frame: RemoteFrameInput) => void
  /** 测试隔离：清空全部状态与驱动（非 UI 语义） */
  _resetForTests: () => void
}

const driver = new BattleDriver('P1')
// 对面 AI 实例：一局一个（内部有决策 RNG 游标），startBattle 时重建
let bot: AiPlayer | null = null

/**
 * 联机上行口（M2-UI4）：remoteMode 下 runAction 经此把动作原样发往服务端
 * （协议硬约束：上行仅 {type:'action'}，客户端零引擎逻辑）。由 lanStore 绑定，
 * gameStore 不反向依赖联机模块（避免环）。
 */
let remoteDispatch: ((action: Action) => void) | null = null

/** lanStore 在会话建立/销毁时绑定与解绑联机上行口 */
export function bindRemoteDispatch(dispatch: ((action: Action) => void) | null): void {
  remoteDispatch = dispatch
}

const eventListeners = new Set<(events: readonly GameEvent[]) => void>()

function notifyEvents(events: readonly GameEvent[]): void {
  for (const listener of eventListeners) listener(events)
}

/** RuleError → 玩家可读文案：剥错误码前缀 + 统一"供电不够"口吻（§3 功耗梗） */
function friendlyRuleError(error: RuleError): UiError {
  const bare = error.message.replace(/^\[[A-Z_]+\]\s*/, '')
  return { code: error.code, message: bare.replaceAll('供电不足', '供电不够') }
}

function sameTarget(a: TargetRef, b: TargetRef): boolean {
  return targetKey(a) === targetKey(b)
}

type StoreData = Pick<
  GameStore,
  | 'screen'
  | 'rulesReturn'
  | 'view'
  | 'legalActions'
  | 'interactivity'
  | 'log'
  | 'targeting'
  | 'result'
  | 'lastError'
  | 'contentNotice'
  | 'deckList'
  | 'draftFaction'
  | 'draftDeckId'
  | 'draftOpponentFaction'
  | 'config'
  | 'remoteMode'
>

// —— 集成接线：content/decks 预组卡组已落地（4 套×30 张）——
// 有预组卡组时默认选中第一套（不再默认「随机降级」项；随机项仍保留在下拉里可手选）
const initialDeckList = deckOptions()
const initialDeckId = initialDeckList.find((d) => !d.degraded)?.id ?? RANDOM_DECK_OPTION.id

const initialState: StoreData = {
  screen: 'menu',
  rulesReturn: 'menu',
  view: null,
  legalActions: [] as readonly Action[],
  interactivity: null,
  log: [] as readonly LogEntry[],
  targeting: null,
  result: null,
  lastError: null,
  contentNotice: null,
  deckList: initialDeckList,
  draftFaction: FACTION_DISPLAY[0]?.id ?? 'neutral',
  draftDeckId: initialDeckId,
  draftOpponentFaction: 'random' as FactionId | 'random',
  config: null,
  remoteMode: false,
}

const LOG_CAP = 300

function pickSeeded<T>(items: readonly T[], seed: number): T {
  return items[seed % items.length] as T
}

/** 降级提示：demo 池兜底 / 正式卡池随机组卡（预组卡组未就位） */
function buildContentNotice(report: ContentReport): string | null {
  if (report.source === 'fallback') {
    return 'content 卡池尚未就位：本局使用随机 demo 牌组（降级模式，正式卡池稍后接入）'
  }
  if (!report.decksAvailable) {
    return `预组卡组尚未就位：从已注册的 ${report.registeredCards} 张正式卡池随机组卡${report.invalidCards.length > 0 ? `（另有 ${report.invalidCards.length} 张定义未过校验被跳过，见控制台）` : ''}`
  }
  return null
}

export const useGameStore = create<GameStore>()((set, get) => {
  /** 引擎报告落地：刷新视图/合法动作/战报，终局则切结算画面（§9 收口） */
  function applyReport(report: DispatchReport): void {
    const entries = eventsToLogEntries(report.view, report.events)
    set((prev) => ({
      view: report.view,
      legalActions: report.legalActions,
      interactivity: deriveInteractivity(report.view, report.legalActions),
      log: [...[...entries].reverse(), ...prev.log].slice(0, LOG_CAP),
      targeting: null,
    }))
    notifyEvents(report.events)
    const end = gameEndOf(report.events)
    if (end) {
      set({ result: buildResult(report.view, end), screen: 'result' })
    }
  }

  function runAction(action: Action): boolean {
    // 联机模式：动作原样上行（结算全在服务端），报告经服务端 events 帧异步落地；
    // 上行失败（连接未就绪）立刻提示，规则违规由服务端 error 帧异步反馈（lanStore 转发）。
    if (get().remoteMode) {
      if (!remoteDispatch) {
        set({ lastError: { code: 'NET', message: '联机连接尚未建立，动作发不出去' } })
        return false
      }
      try {
        remoteDispatch(action)
        return true
      } catch (error) {
        set({
          lastError: {
            code: 'NET',
            message: error instanceof Error ? error.message : '动作上行失败（连接可能已断开）',
          },
        })
        return false
      }
    }
    try {
      applyReport(driver.dispatch(action))
      return true
    } catch (error) {
      if (error instanceof RuleError) {
        set({ lastError: friendlyRuleError(error) })
        return false
      }
      // 非 RuleError 属引擎/内容层缺陷（如效果引用未注册 handler）：不让 UI 裸崩，
      // 提示条展示 + 控制台留痕，状态保持原样（引擎入口先深拷贝，失败不改状态）
      console.error('[siliconcard-ui] 动作结算异常', action, error)
      set({
        lastError: {
          code: 'ENGINE',
          message: `结算出错（内容或引擎缺陷，已拦截）：${error instanceof Error ? error.message : String(error)}`,
        },
      })
      return false
    }
  }

  return {
    ...initialState,

    goto: (screen) => set({ screen }),
    openRules: () => set({ rulesReturn: get().screen, screen: 'rules' }),
    closeRules: () => set({ screen: get().rulesReturn }),
    setDraftFaction: (faction) => set({ draftFaction: faction }),
    setDraftDeck: (deckId) => set({ draftDeckId: deckId }),
    setDraftOpponentFaction: (faction) => set({ draftOpponentFaction: faction }),

    startBattle: (options) => {
      const seed = (options?.seed ?? Math.floor(Math.random() * 0x7fffffff)) >>> 0
      let report: ContentReport
      try {
        report = ensureContentRegistered()
      } catch (error) {
        set({ lastError: { code: 'CONTENT', message: `内容注册失败：${String(error)}` } })
        return
      }
      const state = get()
      const contentNotice = buildContentNotice(report)
      const choice = resolveDeckChoice(state.draftDeckId, (seed ^ 0x51ab7d3) >>> 0, report)
      const oppSeed = (seed ^ 0x9e3779b9) >>> 0
      const opponentFaction =
        state.draftOpponentFaction === 'random'
          ? pickSeeded(FACTION_DISPLAY, oppSeed).id
          : state.draftOpponentFaction
      const oppDeckChoice =
        report.contentDecks.length > 0
          ? resolveDeckChoice(pickSeeded(report.contentDecks, oppSeed).id, oppSeed, report)
          : { spec: buildFallbackDeck(oppSeed), label: RANDOM_DECK_OPTION.name }

      driver.reset()
      bot = createBot('P2', seed)
      try {
        const opening = driver.start({
          seed,
          players: [
            { id: 'P1', faction: state.draftFaction, heroName: '你', deck: choice.spec },
            { id: 'P2', faction: opponentFaction, heroName: '对面老哥', deck: oppDeckChoice.spec },
          ],
        })
        set({
          screen: 'battle',
          view: opening.view,
          legalActions: opening.legalActions,
          interactivity: deriveInteractivity(opening.view, opening.legalActions),
          log: eventsToLogEntries(opening.view, opening.openingEvents),
          targeting: null,
          result: null,
          lastError: null,
          contentNotice,
          config: {
            playerFaction: state.draftFaction,
            opponentFaction,
            deckId: state.draftDeckId,
            deckLabel: choice.label,
            seed,
          },
        })
        notifyEvents(opening.openingEvents)
      } catch (error) {
        if (error instanceof RuleError) {
          set({ lastError: friendlyRuleError(error) })
          return
        }
        throw error
      }
    },

    tryPlayCard: (uid) => {
      const { view, interactivity } = get()
      if (!view || !interactivity) return
      const targets = interactivity.playsByUid.get(uid)
      if (!targets) {
        const card = view.you.hand.find((c) => c.uid === uid)
        const status = card
          ? handCardStatus(view, interactivity, card)
          : { available: false, reason: '这张牌已经不在手上了' }
        set({ lastError: { code: 'UI', message: status.reason ?? '这张牌现在打不出' } })
        return
      }
      if (targets.length === 0) {
        runAction({ type: 'PLAY_CARD', playerId: view.viewer, uid })
        return
      }
      set({ targeting: { kind: 'play', uid, attackerId: null, targets } })
    },

    tryAttack: (attackerId) => {
      const { view, interactivity } = get()
      if (!view || !interactivity) return
      const targets = interactivity.attacksByAttacker.get(attackerId)
      if (!targets) {
        const unit = view.board.find((u) => u.instanceId === attackerId)
        const status = unit
          ? attackStatusOf(view, interactivity, unit)
          : { available: false, reason: '这台显卡已经不在场上了' }
        set({ lastError: { code: 'UI', message: status.reason ?? '这台显卡现在不能攻击' } })
        return
      }
      set({ targeting: { kind: 'attack', uid: null, attackerId, targets } })
    },

    tryHeroPower: () => {
      const { view, interactivity } = get()
      if (!view || !interactivity) return
      const targets = interactivity.heroPowerTargets
      if (targets === null) {
        const status = heroPowerStatus(view, interactivity)
        set({ lastError: { code: 'UI', message: status.reason ?? '技能现在用不了' } })
        return
      }
      if (targets.length === 0) {
        runAction({ type: 'USE_HERO_POWER', playerId: view.viewer })
        return
      }
      set({ targeting: { kind: 'heroPower', uid: null, attackerId: null, targets } })
    },

    endTurn: () => {
      const { view, interactivity } = get()
      if (!view || !interactivity) return
      const status = endTurnStatus(interactivity)
      if (!status.available) {
        set({ lastError: { code: 'UI', message: status.reason ?? '现在不能结束回合' } })
        return
      }
      runAction({ type: 'END_TURN', playerId: view.viewer })
    },

    concede: () => {
      const { view } = get()
      if (!view) return
      if (view.phase === 'ended') {
        set({ lastError: { code: 'UI', message: '对局已经结束了' } })
        return
      }
      runAction({ type: 'CONCEDE', playerId: view.viewer })
    },

    confirmTarget: (target) => {
      const { targeting, view } = get()
      if (!targeting || !view) return
      if (!targeting.targets.some((candidate) => sameTarget(candidate, target))) {
        set({ lastError: { code: 'UI', message: '这个目标不在本次候选里（潜行或保护的目标点不了）' } })
        return
      }
      switch (targeting.kind) {
        case 'play':
          runAction({ type: 'PLAY_CARD', playerId: view.viewer, uid: targeting.uid as string, target })
          break
        case 'attack':
          runAction({ type: 'ATTACK', playerId: view.viewer, attackerId: targeting.attackerId as string, target })
          break
        case 'heroPower':
          runAction({ type: 'USE_HERO_POWER', playerId: view.viewer, target })
          break
      }
    },

    cancelTargeting: () => set({ targeting: null }),

    botTick: () => {
      if (get().remoteMode) return // 联机：对面动作由服务端 events 帧推送，无本地托管
      if (driver.isEnded()) return
      const { view } = get()
      if (!view || view.phase === 'ended') return
      if (view.activePlayer === driver.viewer) return
      if (!bot) return
      const action = driver.aiActionFor('P2', bot)
      if (!action) return
      runAction(action)
    },

    rematch: () => {
      if (get().remoteMode) {
        set({ lastError: { code: 'NET', message: '联机对局在服务端，回房间重开（本地再来一局不适用）' } })
        return
      }
      get().startBattle()
    },

    backToMenu: () => {
      driver.reset()
      set({
        screen: 'menu',
        view: null,
        legalActions: [],
        interactivity: null,
        log: [],
        targeting: null,
        result: null,
        lastError: null,
        contentNotice: null,
        config: null,
        deckList: initialDeckList,
        remoteMode: false,
      })
    },

    clearError: () => set({ lastError: null }),

    /**
     * 联机对局帧落地（M2-UI4）。与本地 applyReport 同构：
     * 视图/合法动作/可交互性替换 + 事件流进战报与 3D 演出口 + 终局收口（§9）。
     * 首帧（本端尚无对局视图）自动进入 battle 屏并写入 config。
     */
    applyRemoteFrame: (frame) => {
      const { view, legalActions, events, seed, fresh } = frame
      const prev = get()
      const firstFrame = !prev.remoteMode || prev.view === null

      // 开局事件合成：仅大厅开局首帧且视图在第 1 回合（恢复/回放中盘不补造历史，见 opening.ts）
      const opening = fresh ? synthesizeOpeningEvents(view, seed ?? 0) : []
      const openingEntries = eventsToLogEntries(view, opening)
      const entries = eventsToLogEntries(view, events)

      // 终局收口：events 帧按 GAME_END（§9 保证最后一条且恰好一次）；
      // sync 帧无事件——恢复时若直接落终局视图（如刷新后恢复到已结束的对局），按视图 winner 兜底
      const end = gameEndOf(events)
      const syncEnded = end === null && view.phase === 'ended' && prev.result === null
      const result = end
        ? buildResult(view, end)
        : syncEnded
          ? buildResult(view, { winner: view.winner, reason: 'health_zero' })
          : prev.result

      set({
        remoteMode: true,
        // 终局收口优先（§9）：恢复时直接落终局视图也要进 result 屏，而非 battle
        screen: end || syncEnded ? 'result' : firstFrame ? 'battle' : prev.screen,
        view,
        legalActions,
        interactivity: deriveInteractivity(view, legalActions),
        log: [...[...openingEntries, ...entries].reverse(), ...prev.log].slice(0, LOG_CAP),
        targeting: null,
        result,
        lastError: firstFrame ? null : prev.lastError,
        config: firstFrame
          ? {
              playerFaction: view.you.faction,
              opponentFaction: view.opponent.faction,
              deckId: 'lan',
              deckLabel: '联机卡组',
              seed: seed ?? 0,
            }
          : prev.config,
      })
      const batch = [...opening, ...events]
      if (batch.length > 0) notifyEvents(batch)
    },

    _resetForTests: () => {
      driver.reset()
      set({ ...initialState })
    },
  }
})

/** 3D 线事件口：订阅每批引擎事件（开局事件与每次 applyAction 产出），返回退订函数 */
export function onBattleEvents(listener: (events: readonly GameEvent[]) => void): () => void {
  eventListeners.add(listener)
  return () => {
    eventListeners.delete(listener)
  }
}
