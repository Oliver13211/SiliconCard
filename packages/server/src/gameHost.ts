/**
 * GameSession —— 单个房间的对局托管（M2-NET1 / M2-NET3）。
 *
 * 职责边界（架构铁律 3）：
 * - 完整 GameState 只存在于本模块内（服务端是权威节点）；一切下行只含
 *   viewFor 视图、本席位 getLegalActions 与 GameEvent 事件流；
 * - 上行动作经本模块校验（席位归属 → 引擎合法性）后结算；引擎抛 RuleError
 *   以返回值上报（房间层转 error 帧），状态不动、对局继续；
 * - AI 席位（M2-NET3）经 @siliconcard/ai 的 createAiPlayer 托管：只走引擎
 *   公开接口决策（不读完整 state 作弊），每次结算与人类动作走同一管线，
 *   事件帧对人类席位一致可见。
 */

import {
  createEngine,
  stableHash,
  type Action,
  type Engine,
  type GameEvent,
  type GameState,
  type PlayerSetup,
  type PlayerView,
} from '@siliconcard/core'
import { createAiPlayer, deriveAiSeed, type AiPlayer } from '@siliconcard/ai'
import type {
  AiSeatMap,
  ErrorFrame,
  GameSnapshot,
  ProtocolErrorCode,
  ProtocolSeat,
  RoomPhase,
  SeatFrameDraft,
  SeatInfo,
} from './protocol'
import { PROTOCOL_SEATS, PROTOCOL_VERSION } from './protocol'

/** 单次 AI 回合触发的动作上限（防评估异常导致死循环；正常回合远低于此） */
const MAX_AI_ACTIONS_PER_TRIGGER = 200

/** 席位动作被引擎拒绝时的上报载荷（房间层转 RULE_VIOLATION error 帧） */
export interface RuleViolationInfo {
  ruleCode: string
  message: string
}

export interface ActionAppliedInfo {
  /** 所属房间码（多房间共享一个 server 时路由对账缓冲用） */
  roomCode: string
  /** 触发本次结算的动作（含 AI 席位动作） */
  action: Action
  /** 结算后的完整状态（引擎不可变语义：每次返回全新状态对象） */
  state: GameState
  events: readonly GameEvent[]
  views: Record<ProtocolSeat, PlayerView>
  legalActions: Record<ProtocolSeat, readonly Action[]>
  stateHash: string
}

export interface GameSessionOptions {
  seed: number
  roomCode: string
  roomName: string
  players: readonly [PlayerSetup, PlayerSetup]
  /** AI 托管席位 → 难度（人类席位不出现） */
  aiSeats: AiSeatMap
  /** 席位帧出口（房间层负责 seq 编号、日志与 socket 投递） */
  onSeatFrame: (seat: ProtocolSeat, frame: SeatFrameDraft) => void
  /** 调试/验收钩子（100 局零漂移测试用它对账服务端真相；生产不传） */
  onActionApplied?: (info: ActionAppliedInfo) => void
}

export class GameSession {
  readonly seed: number
  private readonly engine: Engine
  private state: GameState
  private readonly roomCode: string
  private readonly roomName: string
  private readonly aiSeats: AiSeatMap
  private readonly aiPlayers: Partial<Record<ProtocolSeat, AiPlayer>> = {}
  private readonly onSeatFrame: (seat: ProtocolSeat, frame: SeatFrameDraft) => void
  private readonly onActionApplied?: (info: ActionAppliedInfo) => void

  constructor(options: GameSessionOptions) {
    this.engine = createEngine()
    this.seed = options.seed
    this.roomCode = options.roomCode
    this.roomName = options.roomName
    this.aiSeats = options.aiSeats
    this.onSeatFrame = options.onSeatFrame
    this.onActionApplied = options.onActionApplied
    this.state = this.engine.initGame({
      seed: options.seed,
      players: options.players,
    })
    for (const seat of PROTOCOL_SEATS) {
      const difficulty = this.aiSeats[seat]
      if (difficulty) {
        // AI 决策种子由对局种子确定性派生（同 seed → 同对局，见 ai 包 deriveAiSeed）
        this.aiPlayers[seat] = createAiPlayer({ playerId: seat, difficulty, seed: deriveAiSeed(options.seed, seat) })
      }
    }
  }

  get stateSnapshot(): Readonly<GameState> {
    return this.state
  }

  get stateHash(): string {
    return stableHash(this.state)
  }

  get ended(): boolean {
    return this.state.phase === 'ended'
  }

  phase(): RoomPhase {
    return this.state.phase === 'ended' ? 'ended' : 'playing'
  }

  viewFor(seat: ProtocolSeat): PlayerView {
    return this.engine.viewFor(this.state, seat)
  }

  /** 该席位当前合法动作：仅轮到自己且对局进行中非空（不向对手泄漏手牌可打性） */
  legalActionsFor(seat: ProtocolSeat): readonly Action[] {
    if (this.state.phase !== 'main' || this.state.activePlayer !== seat) return []
    return this.engine.getLegalActions(this.state, seat)
  }

  seatInfo(seat: ProtocolSeat, humanConnected: boolean): SeatInfo {
    const difficulty = this.aiSeats[seat]
    if (difficulty) return { kind: 'ai', connected: true, difficulty }
    return { kind: 'human', connected: humanConnected }
  }

  seatsInfo(humanConnected: Record<ProtocolSeat, boolean>): Record<ProtocolSeat, SeatInfo> {
    return {
      P1: this.seatInfo('P1', humanConnected.P1 ?? false),
      P2: this.seatInfo('P2', humanConnected.P2 ?? false),
    }
  }

  snapshot(seat: ProtocolSeat, humanConnected: Record<ProtocolSeat, boolean>): GameSnapshot {
    return {
      roomCode: this.roomCode,
      roomName: this.roomName,
      seat,
      seats: this.seatsInfo(humanConnected),
      phase: this.phase(),
      seed: this.seed,
      view: this.viewFor(seat),
      legalActions: [...this.legalActionsFor(seat)],
    }
  }

  /** 开局/重连的全量对齐：给该席位发一次 sync 帧（view + legalActions 现算） */
  sendSyncFrame(seat: ProtocolSeat, humanConnected: Record<ProtocolSeat, boolean>): void {
    this.onSeatFrame(seat, { v: PROTOCOL_VERSION, type: 'sync', snapshot: this.snapshot(seat, humanConnected) })
  }

  /**
   * 人类席位动作入口。上下文错误抛 ProtocolFault（房间层转 error 帧）；
   * 引擎拒绝返回 violation 上报（状态不动，对局继续）；结算成功返回 null，
   * 并在同一调用内驱动 AI 连锁回合。
   */
  applyHumanAction(seat: ProtocolSeat, rawAction: unknown): RuleViolationInfo | null {
    const shape = rawAction as { playerId?: unknown } | null
    if (!shape || shape.playerId !== seat) {
      throw new ProtocolFault('WRONG_SEAT', `动作 playerId 与席位（${seat}）不符`)
    }
    const violation = this.applyInternal(seat, rawAction as Action)
    return violation
  }

  /** AI 回合驱动：当前行动席位是 AI 时连续决策直到交回合/终局（同步执行，帧经出口投递） */
  runAiTurns(): void {
    let guard = 0
    while (this.state.phase === 'main') {
      const seat = this.state.activePlayer
      const bot = this.aiPlayers[seat]
      if (!bot) break
      const action = bot.decideNextAction(this.engine, this.state)
      if (!action) break
      const violation = this.applyInternal(seat, action)
      if (violation) break // AI 只从合法集选动作，命中即异常：停止本触发防连环刷帧
      if (++guard >= MAX_AI_ACTIONS_PER_TRIGGER) break
    }
  }

  /** 统一结算管线：引擎结算 → 双席位 events 帧 → 调试钩子 → AI 连锁 */
  private applyInternal(seat: ProtocolSeat, action: Action): RuleViolationInfo | null {
    let result
    try {
      result = this.engine.applyAction(this.state, action)
    } catch (error) {
      return {
        ruleCode: error instanceof Error && 'code' in error ? String((error as { code: unknown }).code) : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      }
    }
    this.state = result.state

    const views: Record<ProtocolSeat, PlayerView> = {
      P1: this.engine.viewFor(this.state, 'P1'),
      P2: this.engine.viewFor(this.state, 'P2'),
    }
    const legalActions: Record<ProtocolSeat, readonly Action[]> = {
      P1: this.legalActionsFor('P1'),
      P2: this.legalActionsFor('P2'),
    }
    for (const target of PROTOCOL_SEATS) {
      if (this.aiSeats[target]) continue // AI 席位无 socket，不产帧省内存
      this.onSeatFrame(target, {
        v: PROTOCOL_VERSION,
        type: 'events',
        events: result.events,
        view: views[target] as PlayerView,
        legalActions: legalActions[target] as readonly Action[],
      })
    }
    this.onActionApplied?.({
      roomCode: this.roomCode,
      action,
      state: this.state,
      events: result.events,
      views,
      legalActions,
      stateHash: stableHash(this.state),
    })
    this.runAiTurns()
    return null
  }
}

/** 房间/对局上下文错误：房间层捕获后向发起席位发 error 帧（连接不断开） */
export class ProtocolFault extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProtocolFault'
  }
}

/** 连接级错误帧构造（seq null，不进席位日志、不回放） */
export function buildErrorFrame(code: ProtocolErrorCode, message: string, ruleCode?: string): ErrorFrame {
  return ruleCode === undefined
    ? { v: PROTOCOL_VERSION, seq: null, type: 'error', code, message }
    : { v: PROTOCOL_VERSION, seq: null, type: 'error', code, message, ruleCode }
}
