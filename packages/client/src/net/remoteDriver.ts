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
 *
 * 回放入柜（P2-α）：对局结束（events 帧 view.phase === 'ended'，含重连 sync 直达
 * 终局）自动上行一次 replay_fetch；replay_data 应答经 onReplayMatch / 模块级
 * setRemoteReplaySink 交付 MatchRecording 形载荷（lanStore 接线落 IndexedDB，
 * 无完赛 match 为 null 静默）。协议硬约束不破：上行仍是 room op，不碰对局 action。
 */

import type { Action, GameEvent, PlayerView } from '@siliconcard/core'
import { PROTOCOL_VERSION } from './protocol'
import type { LanConnection } from './connection'
import type { GameSnapshot, ProtocolSeat, ReplayMatchPayload, RoomPhase, RoomResult, SeatMap, ServerFrame } from './protocol'

export interface RemoteBattleState {
  seat: ProtocolSeat | null
  phase: RoomPhase | null
  view: PlayerView | null
  legalActions: readonly Action[]
  seats: SeatMap | null
  /** 对局种子（开局 sync 后可得） */
  seed: number | null
}

/**
 * 联机回放 sink（P2-α）：driver 在 replay_data 到达（match 非 null）时交付
 * MatchRecording 形载荷。模块级注册而非实例属性——LanClient 内的 driver 实例
 * 不外泄（铁律 3），sink 经此注入即可覆盖所有 driver 实例；置 null 即整体关闭。
 * 语义对齐本地链路的 setMatchRecordingSink（ui/game/battleDriver.ts）。
 */
export type RemoteReplaySink = (match: ReplayMatchPayload) => void

let remoteReplaySink: RemoteReplaySink | null = null

export function setRemoteReplaySink(sink: RemoteReplaySink | null): void {
  remoteReplaySink = sink
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
  private readonly replayListeners = new Set<(match: ReplayMatchPayload | null) => void>()
  /** ended → replay_fetch 只发一次（每驱动实例；重连的新实例重置，服务端/落库侧按内容寻址 id 去重） */
  private replayRequested = false
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

  /** 完赛录制订阅（replay_data 应答；match null = 服务端无完赛可给，返回退订函数） */
  onReplayMatch(listener: (match: ReplayMatchPayload | null) => void): () => void {
    this.replayListeners.add(listener)
    return () => {
      this.replayListeners.delete(listener)
    }
  }

  /** 对局上行唯一入口：原样转发动作，结算全在服务端 */
  dispatch(action: Action): void {
    this.conn.send({ v: 1, type: 'action', action })
  }

  private applyFrame(frame: ServerFrame): void {
    if (frame.type === 'room') {
      for (const listener of this.roomListeners) listener(frame.op)
      if (frame.op.name === 'replay_data') {
        this.emitReplayMatch(frame.op.match)
        return
      }
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
    if (frame.view.phase === 'ended') {
      this.requestReplayOnce() // 对局结束：向服务端取回完赛录制（P2-α）
    }
    if (frame.events.length > 0) {
      for (const listener of this.eventListeners) listener(frame.events)
    }
  }

  private applySnapshot(snapshot: GameSnapshot): void {
    const wasEnded = this.state.phase === 'ended'
    this.state = {
      seat: snapshot.seat,
      phase: snapshot.phase,
      view: snapshot.view,
      legalActions: snapshot.legalActions,
      seats: snapshot.seats,
      seed: snapshot.seed,
    }
    this.emitState()
    // 重连/页面刷新后 sync 直达终局（对局在断线期间结束）：同样补一次取回
    if (snapshot.phase === 'ended' && !wasEnded) {
      this.requestReplayOnce()
    }
  }

  /** ended 后自动取回放（每实例一次）；断线时静默放弃——sync/重放帧会再次触达 */
  private requestReplayOnce(): void {
    if (this.replayRequested) return
    this.replayRequested = true
    try {
      this.conn.send({ v: PROTOCOL_VERSION, type: 'room', op: { name: 'replay_fetch' } })
    } catch (error) {
      console.warn('[siliconcard-net] replay_fetch 发送失败（静默；重连后 sync 会再触达）', error)
    }
  }

  private emitReplayMatch(match: ReplayMatchPayload | null): void {
    for (const listener of this.replayListeners) listener(match)
    if (match === null) return // 无完赛可给：静默不提示（console 留痕足够）
    if (match.source !== 'lan') return // 契约自检：非联机录制不进 sink
    try {
      remoteReplaySink?.(match)
    } catch (error) {
      console.warn('[siliconcard-net] 联机回放 sink 交付失败（静默处理，不影响对局）', error)
    }
  }

  private emitState(): void {
    for (const listener of this.stateListeners) listener(this.state)
  }
}
