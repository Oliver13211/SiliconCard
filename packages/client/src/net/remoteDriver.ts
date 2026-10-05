/**
 * RemoteBattleDriver —— 远端驱动事件流（M2-NET1，UI 线对接面）。
 *
 * 与本地 BattleDriver（src/ui/game/battleDriver.ts）同构的报告形状：
 *   { view: PlayerView, legalActions: readonly Action[], events: readonly GameEvent[] }
 * 差异：事实源在服务端——本驱动只缓存最近一次 viewFor 视图与本席位 legalActions，
 * 把每个对局帧携带的事件流推给订阅者（动画/日志/音效），对局上行只有 dispatch(action)
 * → { type:'action' }（协议硬约束：客户端不做任何引擎结算）。
 *
 * UI 线接入（对齐 gameStore 的消费方式）：
 *   const driver = new RemoteBattleDriver(conn)
 *   driver.attach()
 *   const off = driver.onBattleEvents((events) => { ...动画/战报... })
 *   const { view, legalActions } = driver.current
 *   driver.dispatch(action)
 * 断线重连：凭据（code/token）由 RoomApi 保管，resume 后的重放帧 + 全量对齐 sync
 * 会自然流经本驱动（视图/事件无感恢复）。
 */

import type { Action, GameEvent, PlayerView } from '@siliconcard/core'
import type { LanConnection } from './connection'
import type { GameSnapshot, ProtocolSeat, RoomPhase, RoomResult, SeatMap, ServerFrame } from './protocol'

export interface RemoteBattleState {
  seat: ProtocolSeat | null
  phase: RoomPhase | null
  view: PlayerView | null
  legalActions: readonly Action[]
  seats: SeatMap | null
  /** 对局种子（开局 sync 后可得） */
  seed: number | null
}

export class RemoteBattleDriver {
  private state: RemoteBattleState = {
    seat: null,
    phase: null,
    view: null,
    legalActions: [],
    seats: null,
    seed: null,
  }
  private readonly eventListeners = new Set<(events: readonly GameEvent[]) => void>()
  private readonly stateListeners = new Set<(state: RemoteBattleState) => void>()
  private readonly roomListeners = new Set<(op: RoomResult) => void>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly conn: LanConnection) {}

  /** 开始消费连接帧（connect 之后调用；重复 attach 以最后一次为准） */
  attach(): void {
    this.detach()
    this.unsubscribe = this.conn.onFrame((frame) => this.applyFrame(frame))
  }

  detach(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  get current(): RemoteBattleState {
    return this.state
  }

  /** 事件流订阅（对齐 gameStore.notifyEvents 的消费形状；返回退订函数） */
  onBattleEvents(listener: (events: readonly GameEvent[]) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /** 视图/合法动作变化订阅（store 同步用；返回退订函数） */
  onStateChange(listener: (state: RemoteBattleState) => void): () => void {
    this.stateListeners.add(listener)
    return () => {
      this.stateListeners.delete(listener)
    }
  }

  /** 房间回执订阅（等待/重连提示，M2-UI4；返回退订函数） */
  onRoomResult(listener: (op: RoomResult) => void): () => void {
    this.roomListeners.add(listener)
    return () => {
      this.roomListeners.delete(listener)
    }
  }

  /** 对局上行唯一入口：原样转发动作，结算全在服务端 */
  dispatch(action: Action): void {
    this.conn.send({ v: 1, type: 'action', action })
  }

  private applyFrame(frame: ServerFrame): void {
    if (frame.type === 'room') {
      for (const listener of this.roomListeners) listener(frame.op)
      if (frame.op.name === 'seat_update' || frame.op.name === 'started' || frame.op.name === 'ai_added') {
        this.state = { ...this.state, seats: frame.op.seats, phase: frame.op.phase }
        this.emitState()
      }
      return
    }
    if (frame.type === 'sync') {
      this.applySnapshot(frame.snapshot)
      return
    }
    if (frame.type !== 'events') return // welcome / error：连接级帧，不进对局状态
    // events 帧：视图/合法动作替换 + 事件流推送（引擎 GamePhase → 协议 RoomPhase 映射）
    this.state = {
      ...this.state,
      view: frame.view,
      legalActions: frame.legalActions,
      phase: frame.view.phase === 'ended' ? 'ended' : 'playing',
    }
    this.emitState()
    if (frame.events.length > 0) {
      for (const listener of this.eventListeners) listener(frame.events)
    }
  }

  private applySnapshot(snapshot: GameSnapshot): void {
    this.state = {
      seat: snapshot.seat,
      phase: snapshot.phase,
      view: snapshot.view,
      legalActions: snapshot.legalActions,
      seats: snapshot.seats,
      seed: snapshot.seed,
    }
    this.emitState()
  }

  private emitState(): void {
    for (const listener of this.stateListeners) listener(this.state)
  }
}
