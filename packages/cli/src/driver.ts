/**
 * 对局驱动（M3-AGT1）——外部 agent（固定执 P1） vs 内置人机（@siliconcard/ai，执 P2）。
 *
 * 职责边界（与 modes/ 的协议格式无关）：
 * - 持有完整 state 的权威宿主（与 LAN 服务端同角色），对外只产出 viewFor 视图 +
 *   合法动作 + 公开卡牌图鉴，绝不外泄对手手牌/牌库/rng（rules.md §10）；
 * - applyAgentAction：外部动作入口。非法动作捕获 RuleError 原样透出（code/detail 全量），
 *   状态不变，等待重发——纠正闭环由 modes 层的 lastError 字段承载；
 * - runAiTurns：轮到 P2 时循环取 AI 动作并结算（护栏与 ai 包 selfplay 同构：
 *   非法/空返回以 END_TURN 兜底并计数，绝不无声吞掉）。
 */

import { RuleError, createEngine, type Action, type Engine, type GameEvent, type GameState, type PlayerId } from '@siliconcard/core'
import { createAiPlayer, deriveAiSeed, type AiPlayer, type Difficulty } from '@siliconcard/ai'
import type { DeckChoice } from './content'

export const AGENT_PLAYER: PlayerId = 'P1'
export const AI_PLAYER: PlayerId = 'P2'

/** AI 回合单次结算护栏（同 ai 包 DEFAULT_MAX_ACTIONS 量级，防理论死循环） */
export const MAX_AI_ACTIONS = 2000

export interface AgentMatchOptions {
  seed: number
  difficulty: Difficulty
  agentDeck: DeckChoice
  opponentDeck: DeckChoice
}

export interface AgentActionOutcome {
  ok: boolean
  /** 接受时：本动作产出的事件（含 AI 回合则已在 runAiTurns 中另计） */
  events?: readonly GameEvent[]
  /** 拒绝时：引擎原样抛出的 RuleError（code + message + detail 全透出） */
  error?: RuleError
}

export class AgentMatch {
  readonly engine: Engine = createEngine()
  readonly seed: number
  readonly difficulty: Difficulty
  readonly agentDeck: DeckChoice
  readonly opponentDeck: DeckChoice
  state: GameState
  readonly ai: AiPlayer
  /** AI 异常记录（正常对局应为空；非空时在 gameover 消息中如实透出） */
  aiAnomalies: string[] = []
  /** 自对局开始累计的完整事件流（供 demo/调试导出；file/stdio 模式按增量冲洗） */
  private pending: GameEvent[] = []
  /** 已发生事件总量（协议 seq/统计用） */
  eventCount = 0
  /** 状态消息序号（按对局递增：同一对局的每次 turn.json / state 消息都可区分新旧） */
  private snapshotSeq = 0
  /** 全程事件流（终局回放/复盘用；与 pending 增量冲洗互补，累积到对局结束） */
  readonly allEvents: GameEvent[] = []

  /** 下一个状态消息 seq（供 protocol.buildStateMessage 调用） */
  nextSnapshotSeq(): number {
    this.snapshotSeq += 1
    return this.snapshotSeq
  }

  constructor(options: AgentMatchOptions) {
    this.seed = options.seed
    this.difficulty = options.difficulty
    this.agentDeck = options.agentDeck
    this.opponentDeck = options.opponentDeck
    this.state = this.engine.initGame({
      seed: options.seed,
      players: [
        { id: AGENT_PLAYER, faction: options.agentDeck.faction, deck: options.agentDeck.spec },
        { id: AI_PLAYER, faction: options.opponentDeck.faction, deck: options.opponentDeck.spec },
      ],
    })
    // AI 决策种子由对局 seed 确定性派生（同 seed → 同决策，可复现）
    this.ai = createAiPlayer({ playerId: AI_PLAYER, difficulty: options.difficulty, seed: deriveAiSeed(options.seed, AI_PLAYER) })
  }

  get over(): boolean {
    return this.state.phase === 'ended'
  }

  get agentTurn(): boolean {
    return !this.over && this.state.activePlayer === AGENT_PLAYER
  }

  /** 自上次 takeEvents 以来累积的事件（协议 log/事件增量） */
  takeEvents(): GameEvent[] {
    const out = this.pending
    this.pending = []
    return out
  }

  /**
   * 结算外部 agent 的一个动作。非法动作不抛出（modes 层需要把错误写进协议），
   * 返回 ok:false + RuleError；合法则返回 ok:true + 本次事件。
   */
  applyAgentAction(action: Action): AgentActionOutcome {
    if (this.over) {
      return {
        ok: false,
        error: new RuleError('GAME_ENDED', '对局已结束，不再接受任何动作', { winner: this.state.winner, endReason: this.state.endReason }),
      }
    }
    try {
      const result = this.engine.applyAction(this.state, action)
      this.state = result.state
      this.eventCount += result.events.length
      this.pending.push(...result.events)
      this.allEvents.push(...result.events)
      return { ok: true, events: result.events }
    } catch (error) {
      if (error instanceof RuleError) return { ok: false, error }
      throw error // 非 RuleError 属引擎/环境 bug，响亮外抛（AGENTS.md：问题如实上报）
    }
  }

  /** 轮到 AI 时连续结算其动作，直到回到 agent 回合或对局结束；返回 AI 侧事件 */
  runAiTurns(): GameEvent[] {
    if (this.over || this.state.activePlayer !== AI_PLAYER) return []
    const events: GameEvent[] = []
    let aiActions = 0
    while (!this.over && this.state.activePlayer === AI_PLAYER) {
      if (aiActions >= MAX_AI_ACTIONS) {
        this.aiAnomalies.push(`AI 连续动作数超过 ${MAX_AI_ACTIONS}，强制中断其回合`)
        const legal = this.engine.getLegalActions(this.state, AI_PLAYER)
        const endTurn = legal.find((a): a is Extract<Action, { type: 'END_TURN' }> => a.type === 'END_TURN')
        if (endTurn) this.applyAiAction(endTurn, events)
        break
      }
      aiActions += 1
      const action = this.ai.decideNextAction(this.engine, this.state)
      if (!action) {
        this.aiAnomalies.push(`第 ${this.state.turn} 回合：AI 在其行动回合返回 null，以 END_TURN 兜底`)
        this.forceEndTurn(events)
        continue
      }
      const legal = this.engine.getLegalActions(this.state, AI_PLAYER)
      const inList = legal.some((candidate) => JSON.stringify(candidate) === JSON.stringify(action))
      if (!inList) {
        this.aiAnomalies.push(`第 ${this.state.turn} 回合：AI 选出合法集之外的动作 ${JSON.stringify(action)}，以 END_TURN 兜底`)
        this.forceEndTurn(events)
        continue
      }
      try {
        const result = this.engine.applyAction(this.state, action)
        this.state = result.state
        events.push(...result.events)
        this.eventCount += result.events.length
        this.pending.push(...result.events)
        this.allEvents.push(...result.events)
      } catch (error) {
        if (!(error instanceof RuleError)) throw error
        this.aiAnomalies.push(`第 ${this.state.turn} 回合：AI 动作被引擎拒绝（${error.code}）${JSON.stringify(action)}，以 END_TURN 兜底`)
        this.forceEndTurn(events)
      }
    }
    return events
  }

  private applyAiAction(action: Action, sink: GameEvent[]): void {
    try {
      const result = this.engine.applyAction(this.state, action)
      this.state = result.state
      sink.push(...result.events)
      this.eventCount += result.events.length
      this.pending.push(...result.events)
      this.allEvents.push(...result.events)
    } catch (error) {
      if (!(error instanceof RuleError)) throw error
      // 兜底动作也被拒（理论仅剩对局已结束），放弃结算
    }
  }

  private forceEndTurn(sink: GameEvent[]): void {
    const legal = this.engine.getLegalActions(this.state, AI_PLAYER)
    const endTurn = legal.find((a): a is Extract<Action, { type: 'END_TURN' }> => a.type === 'END_TURN')
    if (endTurn) this.applyAiAction(endTurn, sink)
  }
}
