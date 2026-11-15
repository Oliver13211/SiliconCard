/**
 * TutorialController —— 教程对局控制器（P2-EDU1）。
 *
 * 职责（与 BattleDriver 同一架构层：对局驱动方）：
 * - 持有引擎实例与完整 GameState（createEngine 四函数接口，引擎零改动铁律）；
 * - 玩家动作（经 bridge 白名单过滤后）结算进引擎，事件流落地；
 * - P1 结束回合后按关卡行为档案编排脚本对手（resolveP2Turn，确定性轻规则，
 *   动作逐条 650ms 落地给 3D 演出呼吸感）；
 * - 消费真实事件流驱动步骤机（气泡推进）与过关判定（objectives.ts 纯函数）；
 * - 状态快照（TutorialStatus）推给 UI 绑定层；不直接触碰 gameStore（解耦可测）。
 *
 * 玩家侧 HUD 依旧只看 viewFor 视图与 getLegalActions 收窄结果；
 * 完整 state 仅在本类与脚本解析（scripted.ts）内流转，不下发 UI。
 */

import {
  RuleError,
  createEngine,
  type Action,
  type Engine,
  type GameEvent,
  type GameSetup,
  type GameState,
  type PlayerView,
} from '@siliconcard/core'
import { ensureContentRegistered, resolveDeckChoice } from '../game/deckLoader'
import { synthesizeOpeningEvents } from '../game/opening'
import { narrowActionTargets } from './gates'
import { resolveP2Turn } from './scripted'
import type {
  FrameListener,
  P2Profile,
  StepGate,
  TutorialLevel,
  TutorialSection,
  TutorialStatus,
  TutorialStep,
} from './types'

/** 脚本动作间隔（给 3D 演出留呼吸感；测试里可经 timers 立即推进） */
export const SCRIPT_STEP_MS = 650
/** 教学提示自动消隐时长 */
export const NUDGE_TTL_MS = 4000

type Phase = 'idle' | 'running' | 'passed' | 'failed'

interface MatchContext {
  seed: number
  playerDeckId: string
  playerFaction?: string
  scriptDeckId: string
  p2Profile: P2Profile
  steps: readonly TutorialStep[]
  objective: (events: readonly GameEvent[]) => boolean | null
  objectiveLabel: string
  objectiveProgress?: (events: readonly GameEvent[]) => { done: number; total: number }
}

export class TutorialController {
  private readonly engine: Engine = createEngine()
  private state: GameState | null = null
  private level: TutorialLevel | null = null
  private section: TutorialSection | null = null
  private playerFaction: string | undefined
  private stepIndex = 0
  private events: GameEvent[] = []
  private phase: Phase = 'idle'
  /** 过关已触发（dismiss 后不重复触发；L4 可继续打完） */
  private passFired = false
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly frameListeners = new Set<FrameListener>()
  private readonly statusListeners = new Set<(status: TutorialStatus) => void>()
  private nudge: string | null = null
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null

  // —— 订阅 ——

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener)
    return () => this.frameListeners.delete(listener)
  }

  onStatus(listener: (status: TutorialStatus) => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  get isActive(): boolean {
    return this.phase !== 'idle'
  }

  /** 本局事件流只读快照（bridge 的 endTurn 门控谓词需要"是否已打出"语义） */
  eventsSnapshot(): readonly GameEvent[] {
    return this.events
  }

  /** 当前步骤白名单（bridge 入口包装器每动作询问） */
  currentGate(): StepGate | undefined {
    return this.ctx()?.steps[this.stepIndex]?.gate
  }

  status(): TutorialStatus {
    const ctx = this.ctx()
    return {
      phase: this.phase,
      levelId: this.level?.id ?? null,
      sectionId: this.section?.id ?? null,
      stepIndex: this.stepIndex,
      bubble: ctx ? (ctx.steps[this.stepIndex]?.bubble ?? null) : null,
      objectiveLabel: ctx?.objectiveLabel ?? '',
      objectiveProgress: ctx?.objectiveProgress?.(this.events) ?? null,
      nudge: this.nudge,
    }
  }

  // —— 对局生命周期 ——

  startLevel(level: TutorialLevel, section: TutorialSection | null = null, playerFaction?: string): void {
    this.clearTimers()
    this.level = level
    this.section = section
    this.playerFaction = playerFaction
    this.stepIndex = 0
    this.events = []
    this.phase = 'running'
    this.passFired = false
    this.nudge = null

    const report = ensureContentRegistered()
    const ctx = this.ctx()
    if (!ctx) return
    const seed = ctx.seed >>> 0
    const playerChoice = resolveDeckChoice(ctx.playerDeckId, seed, report)
    const scriptChoice = resolveDeckChoice(ctx.scriptDeckId, (seed ^ 0x9e3779b9) >>> 0, report)
    const setup: GameSetup = {
      seed,
      players: [
        {
          id: 'P1',
          faction: playerFaction ?? ctx.playerFaction ?? 'neutral',
          heroName: '你',
          deck: playerChoice.spec,
        },
        { id: 'P2', faction: 'neutral', heroName: '教学靶机', deck: scriptChoice.spec },
      ],
    }
    this.state = this.engine.initGame(setup)
    const opening = synthesizeOpeningEvents(this.view(), seed)
    this.events.push(...opening)
    this.pushFrame(opening)
    this.emitStatus()
  }

  /** 玩家动作结算（bridge 已做白名单过滤；引擎层非法动作返回可读错误不落地） */
  dispatchPlayerAction(action: Action): { ok: boolean; error?: string } {
    if (this.phase !== 'running' || !this.state) return { ok: false, error: '教程对局不在进行中' }
    return this.apply(action)
  }

  /** 过关后继续（L4：dismiss 结业条继续打完；有关卡已终局则无效） */
  dismissPass(): void {
    if (this.phase !== 'passed' || !this.state) return
    if (this.state.phase === 'ended') return
    this.phase = 'running'
    this.emitStatus()
  }

  /** 重试本关/本节（进度永不回退，见 progress.ts） */
  retry(): void {
    if (!this.level) return
    this.startLevel(this.level, this.section, this.playerFaction)
  }

  stop(): void {
    this.clearTimers()
    this.level = null
    this.section = null
    this.state = null
    this.events = []
    this.phase = 'idle'
    this.passFired = false
    this.nudge = null
    this.emitStatus()
  }

  /** 教学提示（白名单拦截文案），自动消隐 */
  pushNudge(copy: string): void {
    this.nudge = copy
    this.emitStatus()
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer)
    this.nudgeTimer = setTimeout(() => {
      this.nudge = null
      this.emitStatus()
    }, NUDGE_TTL_MS)
    this.timers.add(this.nudgeTimer)
  }

  // —— 内部 ——

  private ctx(): MatchContext | null {
    const source = this.section ?? this.level
    if (!source) return null
    return {
      seed: source.seed,
      playerDeckId: source.playerDeckId,
      playerFaction: this.playerFaction ?? ('playerFaction' in source ? source.playerFaction : undefined),
      scriptDeckId: source.scriptDeckId,
      p2Profile: source.p2Profile,
      steps: source.steps ?? [],
      objective: source.objective,
      objectiveLabel: source.objectiveLabel,
      objectiveProgress: 'objectiveProgress' in source ? source.objectiveProgress : undefined,
    }
  }

  private view(): PlayerView {
    return this.engine.viewFor(this.state as GameState, 'P1')
  }

  private apply(action: Action): { ok: boolean; error?: string } {
    try {
      const result = this.engine.applyAction(this.state as GameState, action)
      this.state = result.state
      this.events.push(...result.events)
      this.evaluate(result.events)
      this.pushFrame(result.events)
      this.emitStatus()
      if (action.type === 'END_TURN' && this.phase === 'running') this.scheduleScriptedTurn()
      return { ok: true }
    } catch (error) {
      if (error instanceof RuleError) {
        return { ok: false, error: error.message.replace(/^\[[A-Z_]+\]\s*/, '').replaceAll('供电不足', '供电不够') }
      }
      throw error
    }
  }

  /** 事件落地 → 步骤机推进 + 过关/终局判定（全部消费真实事件流） */
  private evaluate(batch: readonly GameEvent[]): void {
    const ctx = this.ctx()
    if (ctx) {
      for (const event of batch) {
        const step = ctx.steps[this.stepIndex]
        if (step?.advanceOn?.(event)) this.stepIndex += 1
      }
    }
    const end = batch.find((event) => event.type === 'GAME_END')
    if (end && end.type === 'GAME_END') {
      if (this.phase === 'running') this.phase = end.winner === 'P1' ? 'passed' : 'failed'
      this.passFired = true
      return
    }
    if (this.phase === 'running' && !this.passFired && ctx) {
      if (ctx.objective(this.events) === true) {
        this.phase = 'passed'
        this.passFired = true
      }
    }
  }

  /** P1 收工 → 脚本对手按行为档案编排整回合（逐动作 650ms 落地） */
  private scheduleScriptedTurn(): void {
    if (!this.state || this.phase !== 'running') return
    const actions = resolveP2Turn(this.ctx()?.p2Profile ?? { kind: 'passer' }, this.state)
    actions.forEach((action, index) => {
      const timer = setTimeout(() => this.dispatchScriptedAction(action), SCRIPT_STEP_MS * (index + 1))
      this.timers.add(timer)
    })
  }

  private dispatchScriptedAction(action: Action): void {
    if (!this.state || this.phase === 'idle' || this.phase === 'failed') return
    try {
      const result = this.engine.applyAction(this.state, action)
      this.state = result.state
      this.events.push(...result.events)
      this.evaluate(result.events)
      this.pushFrame(result.events)
      this.emitStatus()
    } catch {
      // 脚本动作解析与引擎裁决脱节时跳过（防御 seed/引擎微变），教学流程不中断
    }
  }

  private pushFrame(batch: readonly GameEvent[]): void {
    if (!this.state || this.frameListeners.size === 0) return
    const view = this.view()
    const frame = {
      view,
      legalActions: narrowActionTargets(this.currentGate(), this.engine.getLegalActions(this.state, 'P1'), view),
      events: batch,
      seed: this.ctx()?.seed ?? 0,
    }
    for (const listener of this.frameListeners) listener(frame)
  }

  private emitStatus(): void {
    const status = this.status()
    for (const listener of this.statusListeners) listener(status)
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.nudgeTimer = null
  }
}
