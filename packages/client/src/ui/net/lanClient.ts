/**
 * LanClient —— 联机会话控制器（M2-UI4，UI 线对 net 层的组装层）。
 *
 * 职责：按 net 层交付的组装方式（见 src/net/index.ts 头注释）持有
 * LanConnection + RoomApi + RemoteBattleDriver，并补齐 UI 侧需要而 net 层刻意
 * 不做（零 UI 语义）的三件事：
 *  1. 凭据持久化（sessionStorage）：页面刷新后可「恢复上次对局」（resume 只服务
 *     已拿到凭据的连接——docs/protocol.md §3 断线语义）；
 *  2. 断线自动重连：指数退避重试 resume（lastSeq 续传 + 恒定一次 sync），
 *     对齐服务端 60s 宽限期（--grace-ms）；
 *  3. 事件归类回调：大厅席位变化 / 对局帧 / 错误帧，供 lanStore 写入 zustand。
 *
 * 对局事实经 RemoteBattleDriver（viewFor 视图 + legalActions + GameEvent 事件流），
 * 出招经 driver.dispatch（上行仅 {type:'action'}）——本模块不做任何引擎结算。
 * 可注入 connection 工厂与存储，无头测试零 DOM 依赖。
 */

import type { Action, GameEvent, PlayerView } from '@siliconcard/core'
import {
  LanConnection,
  RemoteBattleDriver,
  RoomApi,
  type DeckDto,
  type LanConnectionHandlers,
  type ProtocolSeat,
  type RoomPhase,
  type RoomResult,
  type SeatMap,
  type ServerFrame,
} from '../../net'

/** 断线重连凭据 + 续传位点（持久化载荷；lastSeq=null 表示下次只做全量对齐） */
export interface SavedLanSession {
  url: string
  code: string
  token: string
  seat: ProtocolSeat
  lastSeq: number | null
}

/** 对局帧（视图 + 合法动作 + 事件批）——gameStore.applyRemoteFrame 的直接输入 */
export interface LanBattleFrame {
  view: PlayerView
  legalActions: readonly Action[]
  events: readonly GameEvent[]
  seed: number | null
  fresh: boolean
}

export interface LanClientCallbacks {
  /** 房间/席位状态有更新（created/joined/started/ai_added/seat_update/sync 后） */
  onRoomChanged: () => void
  /** 对局帧到达（大厅开局首帧 fresh=true，其余为续帧/恢复帧） */
  onBattleFrame: (frame: LanBattleFrame) => void
  /** 连接断开（用户主动离开不触发） */
  onConnectionLost: (info: { code: number; reason: string }) => void
  /** 每次排定重连尝试（attempt 从 1 起） */
  onReconnectAttempt: (attempt: number) => void
  /** resume 成功（对局/大厅状态无缝续上） */
  onRestored: () => void
  /** 服务端 error 帧（RULE_VIOLATION 之外均为房间/协议级） */
  onError: (frame: { code: string; message: string; ruleCode?: string }) => void
}

/** 存储抽象：sessionStorage 的窄接口（测试注入内存实现） */
export interface LanStorage {
  get(): SavedLanSession | null
  save(session: SavedLanSession): void
  clear(): void
}

const STORAGE_KEY = 'siliconcard.lan.session.v1'

/** 默认存储：sessionStorage（不可用时静默降级为不持久化——恢复入口只是便利路径） */
export function createSessionStorage(): LanStorage {
  return {
    get(): SavedLanSession | null {
      try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        return raw ? (JSON.parse(raw) as SavedLanSession) : null
      } catch {
        return null
      }
    },
    save(session: SavedLanSession): void {
      try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
      } catch {
        /* 隐私模式等场景不可写：恢复入口降级，不影响主流程 */
      }
    },
    clear(): void {
      try {
        sessionStorage.removeItem(STORAGE_KEY)
      } catch {
        /* 同上 */
      }
    },
  }
}

export interface LanClientOptions {
  callbacks: LanClientCallbacks
  storage?: LanStorage
  /** 连接工厂（测试注入 fake；默认原生 WebSocket 的 LanConnection） */
  createConnection?: (url: string, handlers: LanConnectionHandlers) => LanConnection
}

export interface CreateRoomRequest {
  roomName?: string
  deck: DeckDto
  fillWithAi?: boolean
}

/** 主机地址规范化：允许裸 IP:port（缺省补 ws://），去尾斜杠 */
export function normalizeLanHost(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) throw new Error('请先填写主机地址（如 ws://192.168.1.20:49321）')
  return /^wss?:\/\//.test(trimmed) ? trimmed : `ws://${trimmed}`
}

/** 重连退避：1s → 2s → 4s → 封顶 5s（服务端宽限默认 60s，界面持续重试直到用户离开） */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 5000)
}

export class LanClient {
  private readonly callbacks: LanClientCallbacks
  private readonly storage: LanStorage
  private readonly createConnection: (url: string, handlers: LanConnectionHandlers) => LanConnection

  private conn: LanConnection | null = null
  private rooms: RoomApi | null = null
  private driver: RemoteBattleDriver | null = null
  private unsubscribeFrames: (() => void) | null = null

  private url = ''
  private roomCode: string | null = null
  private closedByUser = false
  /** 会话代际：leave 与在途建连竞争时，旧代际的建连结果直接作废 */
  private generation = 0
  /** created/joined 回执携带的席位/相位（开局 sync 前大厅视图的数据源；driver 就绪后以 driver 为准） */
  private lastSeats: SeatMap | null = null
  private lastPhase: RoomPhase | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  /** 大厅开局第一帧标记：startGame 成功或收到 started 回执时置位，首个对局视图帧消费 */
  private freshStartArmed = false
  /** 本客户端生命周期内是否已进过对局（跨重连保留）：防止重连回放的 started 重复武装开局合成 */
  private battleStarted = false
  /** driver 最近一次状态（onBattleEvents 与 onStateChange 组装对局帧用） */
  private lastDriverState: { view: PlayerView | null; legalActions: readonly Action[]; seed: number | null } = {
    view: null,
    legalActions: [],
    seed: null,
  }

  constructor(options: LanClientOptions) {
    this.callbacks = options.callbacks
    this.storage = options.storage ?? createSessionStorage()
    this.createConnection = options.createConnection ?? ((url, handlers) => new LanConnection(url, handlers))
  }

  /** 当前会话快照（lanStore 渲染大厅/等待界面用） */
  get snapshot(): {
    url: string
    roomCode: string | null
    seat: ProtocolSeat | null
    seats: SeatMap | null
    phase: RoomPhase | null
    credentialsSaved: boolean
  } {
    return {
      url: this.url,
      roomCode: this.roomCode,
      seat: this.driver?.current.seat ?? null,
      seats: this.driver?.current.seats ?? this.lastSeats,
      phase: this.driver?.current.phase ?? this.lastPhase,
      credentialsSaved: this.storage.get() !== null,
    }
  }

  get reconnectAttempt(): number {
    return this.attempt
  }

  get hasSession(): boolean {
    return this.conn !== null
  }

  /** 出招：原样上行（协议硬约束），客户端零引擎逻辑 */
  dispatch(action: Action): void {
    if (!this.driver) throw new Error('尚未连接房间，无法出招')
    this.driver.dispatch(action)
  }

  /** 建房：连接 → create。成功后 onRoomChanged（大厅视图经 snapshot 读取） */
  async connectAndCreate(url: string, request: CreateRoomRequest): Promise<string> {
    const normalized = normalizeLanHost(url)
    await this.openSession(normalized)
    const created = await this.rooms?.createRoom(request)
    if (!created) throw new Error('建房回执丢失')
    this.roomCode = created.code
    this.persistCredentials()
    return created.code
  }

  /** 加入：连接 → join(code) */
  async connectAndJoin(url: string, code: string, deck: DeckDto): Promise<string> {
    const normalized = normalizeLanHost(url)
    const joinCode = code.trim().toUpperCase()
    if (!/^[A-Z0-9]{4,10}$/.test(joinCode)) throw new Error('房间码格式不对（4-10 位字母数字）')
    await this.openSession(normalized)
    const joined = await this.rooms?.joinRoom(joinCode, deck)
    if (!joined) throw new Error('加入回执丢失')
    this.roomCode = joined.code
    this.persistCredentials()
    return joined.code
  }

  /** 房主开局（seed 缺省由服务端时钟派生）；对局帧随后经 onBattleFrame 推送 */
  async startGame(seed?: number): Promise<void> {
    if (!this.rooms) throw new Error('尚未连接房间')
    await this.rooms.start(seed)
    this.freshStartArmed = true
    this.callbacks.onRoomChanged()
  }

  /** 房主把空位交给 AI 托管 */
  async addAi(difficulty?: 'easy' | 'normal' | 'hard'): Promise<void> {
    if (!this.rooms) throw new Error('尚未连接房间')
    await this.rooms.addAi(difficulty)
    this.callbacks.onRoomChanged()
  }

  /**
   * 主动离开：leave op 同步发出（回执不等待——断线时房间由服务端宽限期回收），
   * 随即拆掉本会话并清凭据。closedByUser 先置位，连接关闭不再触发重连。
   */
  async leave(): Promise<void> {
    this.generation += 1 // 作废在途建连（openSession 完成后检测代际不符自弃）
    this.closedByUser = true
    this.clearReconnectTimer()
    const rooms = this.rooms
    if (rooms) {
      void rooms.leave().catch(() => undefined) // send 在 request 内同步发生；回执/超时不阻塞 UI
    }
    this.teardownSocket()
    this.storage.clear()
    this.roomCode = null
    this.lastSeats = null
    this.lastPhase = null
    this.battleStarted = false
    this.attempt = 0
  }

  /**
   * 页面刷新后的恢复入口：用持久化凭据重连（lastSeq 续传；位点缺失则仅全量对齐）。
   * 失败抛错（房间可能已超宽限期销毁），调用方决定提示与凭据清理。
   */
  async restoreSaved(): Promise<SavedLanSession> {
    const saved = this.storage.get()
    if (!saved) throw new Error('没有可恢复的联机会话')
    this.closedByUser = false
    await this.openSession(normalizeLanHost(saved.url))
    this.roomCode = saved.code
    if (!this.rooms) throw new Error('房间通道未建立')
    const resumed = await this.rooms.resume({ code: saved.code, token: saved.token, lastSeq: saved.lastSeq })
    this.persistCredentials(resumed.seat)
    this.callbacks.onRestored()
    this.callbacks.onRoomChanged()
    return { ...saved, seat: resumed.seat }
  }

  /** 立即尝试一次重连（自动重连循环内部亦复用） */
  private async reconnectNow(): Promise<void> {
    this.reconnectTimer = null
    if (this.closedByUser) return
    const saved = this.storage.get()
    if (!saved) return
    try {
      await this.openSession(this.url)
      if (!this.rooms) throw new Error('房间通道未建立')
      const lastSeq = saved.lastSeq
      await this.rooms.resume({ code: saved.code, token: saved.token, lastSeq })
      this.attempt = 0
      this.callbacks.onRestored()
      this.callbacks.onRoomChanged()
    } catch {
      this.teardownSocket()
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer !== null) return
    if (!this.storage.get()) return // 没有凭据（如 create/join 回执未拿到）无法 resume，只能回表单重连
    this.attempt += 1
    this.callbacks.onReconnectAttempt(this.attempt)
    this.reconnectTimer = setTimeout(() => void this.reconnectNow(), reconnectDelayMs(this.attempt))
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /** 建立一套全新连接 + 房间通道 + 对局驱动（重连/首连共用） */
  private async openSession(url: string): Promise<void> {
    this.teardownSocket()
    const generation = ++this.generation
    this.closedByUser = false
    this.url = url
    const conn = this.createConnection(url, {
      onClose: (info) => this.handleClose(info),
      onProtocolError: (message) => this.callbacks.onError({ code: 'PROTOCOL_ERROR', message }),
    })
    this.conn = conn
    await conn.connect()
    if (generation !== this.generation || this.closedByUser) {
      this.teardownSocket() // 建连期间用户已离开：本次结果作废
      throw new Error('已离开房间，连接作废')
    }

    this.rooms = new RoomApi(conn)
    const driver = new RemoteBattleDriver(conn)
    driver.attach()
    this.driver = driver
    this.lastDriverState = { view: null, legalActions: [], seed: null }

    // error 帧不进 RemoteBattleDriver（连接级帧）：这里归类后转给 UI
    this.unsubscribeFrames = conn.onFrame((frame: ServerFrame) => {
      if (frame.type !== 'error') return
      this.callbacks.onError({ code: frame.code, message: frame.message, ruleCode: frame.ruleCode })
    })

    driver.onStateChange((state) => {
      // 首个携带视图的帧（开局 sync / 回放首帧）经此上报；fresh 标记只对
      // 「大厅开局后的第一帧」生效（回放/恢复不武装 freshStartArmed，不会误合成）
      const hadView = this.lastDriverState.view !== null
      this.lastDriverState = { view: state.view, legalActions: state.legalActions, seed: state.seed }
      if (state.view) this.battleStarted = true
      if (state.view) {
        this.callbacks.onBattleFrame({
          view: state.view,
          legalActions: state.legalActions,
          events: [],
          seed: state.seed,
          fresh: hadView ? false : this.consumeFreshStart(),
        })
      }
    })
    driver.onBattleEvents((events) => {
      // 事件批与视图分两次回调（driver 先 emitState 后推事件）：视图已由上面上报，
      // 这里只负责把事件流带给 gameStore（战报/动画/终局收口）
      const { view, legalActions, seed } = this.lastDriverState
      if (!view) return
      this.callbacks.onBattleFrame({
        view,
        legalActions,
        events,
        seed,
        fresh: false,
      })
    })
    driver.onRoomResult((op) => this.handleRoomResult(op))
  }

  /** 大厅开局标记只对首个携带事件的帧生效（fresh 消费一次） */
  private consumeFreshStart(): boolean {
    if (!this.freshStartArmed) return false
    this.freshStartArmed = false
    return true
  }

  private handleRoomResult(op: RoomResult): void {
    // roomListeners 先于 driver 的 seats/phase 状态更新触发（net 层实现顺序）：
    // 回调推迟一个微任务，保证 handleRoomChanged 读到的是本帧落位后的最新状态
    const notify = (): void => queueMicrotask(() => this.callbacks.onRoomChanged())
    switch (op.name) {
      case 'created':
      case 'joined':
        this.roomCode = op.code
        this.lastSeats = op.seats
        this.lastPhase = op.phase
        this.persistCredentials()
        notify()
        break
      case 'started':
        // 房主外席位没有 startGame 调用：开局标记由 started 回执补齐（随后 sync 为开局首帧）。
        // battleStarted 跨重连保留——中盘重连回放的 started 不再武装，避免重复合成开局事件
        if (!this.battleStarted) this.freshStartArmed = true
        this.lastSeats = op.seats
        this.lastPhase = op.phase
        notify()
        break
      case 'ai_added':
      case 'seat_update':
        this.lastSeats = op.seats
        this.lastPhase = op.phase
        notify()
        break
      case 'resumed':
        this.persistCredentials(op.seat)
        break
      case 'left':
        notify()
        break
    }
  }

  private handleClose(info: { code: number; reason: string }): void {
    // 断线瞬间抢出续传位点与凭据（teardown 会先拆连接与通道）
    const dyingSeq = this.conn?.lastSeq ?? null
    const creds = this.rooms?.seatCredentials ?? null
    const seat = this.driver?.current.seat ?? null
    this.teardownSocket()
    if (this.closedByUser) return
    if (creds) {
      this.storage.save({
        url: this.url,
        code: creds.code,
        token: creds.token,
        seat: seat ?? creds.seat,
        lastSeq: dyingSeq,
      })
    }
    this.callbacks.onConnectionLost(info)
    this.scheduleReconnect()
  }

  /** 拆掉当前 socket 与订阅（保留凭据与重连状态） */
  private teardownSocket(): void {
    this.unsubscribeFrames?.()
    this.unsubscribeFrames = null
    this.driver?.detach()
    this.driver = null
    this.rooms = null
    if (this.conn) {
      this.conn.close()
      this.conn = null
    }
  }

  /** 凭据落盘（断线重连/页面刷新恢复的数据源）；lastSeq 缺省取自当前连接追踪值 */
  private persistCredentials(seatOverride?: ProtocolSeat, lastSeqOverride?: number | null): void {
    const current = this.driver?.current.seat ?? seatOverride
    const base = this.rooms?.seatCredentials
    if (!base) return
    const seat = seatOverride ?? current ?? base.seat
    const lastSeq = lastSeqOverride !== undefined ? lastSeqOverride : (this.conn?.lastSeq ?? null)
    this.storage.save({ url: this.url, code: base.code, token: base.token, seat, lastSeq })
  }
}
