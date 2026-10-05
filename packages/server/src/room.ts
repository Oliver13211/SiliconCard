/**
 * 房间层（M2-NET2 / M2-NET3）——建房/加入/短房间码、席位 token、seq 回放日志、
 * 断线宽限与 GC。socket → 席位的绑定、帧 seq 编号、重连续传都收敛在此。
 *
 * seq 语义（详见 docs/protocol.md）：
 * - 每个席位一条递增 seq（从 1 起）的下行帧日志；seq 非 null 的帧可随重连回放；
 * - 重连按客户端上报的 lastSeq 续传（回放 seq > lastSeq 的日志帧），随后
 *   永远追加一次全量对齐（sync）——日志覆盖不了就只发 sync；
 * - welcome / error 属连接级帧（seq null），不进日志。
 *
 * 回退硬约束：房间系统与 mDNS 发现完全解耦——知道 IP:port 就能直连 join，
 * 不依赖任何发现机制。
 */

import { randomInt, randomUUID } from 'node:crypto'
import type { PlayerSetup } from '@siliconcard/core'
import { aiSeatDeck, validateDeckDto } from './content'
import { GameSession, ProtocolFault, type ActionAppliedInfo } from './gameHost'
import type {
  AiDifficulty,
  AiSeatMap,
  DeckDto,
  GameSnapshot,
  ProtocolSeat,
  RoomPhase,
  RoomResult,
  SeatFrame,
  SeatFrameDraft,
  SeatInfo,
} from './protocol'
import { MAX_SEAT_LOG, PROTOCOL_VERSION } from './protocol'

/** 房间码长度与字符表（去掉易混淆的 I/1/O/0） */
export const ROOM_CODE_LENGTH = 6
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 服务端可持有的房间上限（LAN 场景防失控） */
export const DEFAULT_MAX_ROOMS = 64

/** 断线宽限：人类席位全部断开超过此时长才销毁房间（30s 重连恢复要求的余量） */
export const DEFAULT_DISCONNECT_GRACE_MS = 60_000

/** 房间服务端 socket 的最小接口（ws.WebSocket 天然满足，测试可注入桩） */
export interface ServerSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  terminate(): void
}

interface Participant {
  seat: ProtocolSeat
  token: string
  kind: 'human' | 'ai'
  difficulty?: AiDifficulty
  /** 开局送引擎的 PlayerSetup（faction/deck/heroName，create/join 时定死） */
  setup: PlayerSetup
  socket: ServerSocket | null
  /** seq 编号后的席位帧日志（仅人类席位；AI 席位无 socket 不产帧） */
  log: SeatFrame[]
  lastSeq: number
  disconnectedAt: number | null
}

export interface RoomSummary {
  code: string
  name: string
  phase: RoomPhase
  seats: Record<ProtocolSeat, SeatInfo | null>
  openSeats: number
}

export interface CreateRoomRequest {
  roomName?: string
  deck: DeckDto
  fillWithAi?: boolean
}

export interface RoomManagerOptions {
  /** 断线宽限（毫秒），默认 60s；测试注入小值验证 GC */
  disconnectGraceMs?: number
  maxRooms?: number
  /** 房间码随机源（默认 crypto.randomInt；测试可注入确定性源） */
  randomCodeInt?: (maxExclusive: number) => number
  /** 房间增删钩子（server.ts 接 mDNS 发布/撤销） */
  onRoomAdded?: (summary: RoomSummary) => void
  onRoomRemoved?: (summary: RoomSummary) => void
  /** 调试/验收钩子（透传给 GameSession，100 局零漂移对账用） */
  onActionApplied?: (info: ActionAppliedInfo) => void
  now?: () => number
}

function defaultRandomInt(maxExclusive: number): number {
  return randomInt(maxExclusive)
}

export function generateRoomCode(randomIntIn: (maxExclusive: number) => number = defaultRandomInt): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[randomIntIn(ROOM_CODE_ALPHABET.length)] ?? 'A'
  }
  return code
}

export class Room {
  readonly code: string
  readonly name: string
  readonly createdAt: number
  private game: GameSession | null = null
  private readonly participants: Partial<Record<ProtocolSeat, Participant>> = {}
  private readonly options: RoomManagerOptions
  private readonly now: () => number

  constructor(code: string, name: string, options: RoomManagerOptions) {
    this.code = code
    this.name = name
    this.options = options
    this.createdAt = (options.now ?? Date.now)()
    this.now = options.now ?? Date.now
  }

  phase(): RoomPhase {
    return this.game ? this.game.phase() : 'lobby'
  }

  get session(): GameSession | null {
    return this.game
  }

  seat(seatId: ProtocolSeat): Participant | undefined {
    return this.participants[seatId]
  }

  /** 每个席位一份快照（sync 也要区分席位视角） */
  snapshotFor(seatId: ProtocolSeat): GameSnapshot | null {
    const participant = this.participants[seatId]
    if (!participant) return null
    if (!this.game) {
      return {
        roomCode: this.code,
        roomName: this.name,
        seat: seatId,
        seats: this.seatsInfo(),
        phase: 'lobby',
        seed: null,
        view: null,
        legalActions: [],
      }
    }
    return this.game.snapshot(seatId, this.humanConnected())
  }

  seatsInfo(): Record<ProtocolSeat, SeatInfo | null> {
    const info = (participant: Participant | undefined): SeatInfo | null => {
      if (!participant) return null
      if (participant.kind === 'ai') return { kind: 'ai', connected: true, difficulty: participant.difficulty }
      return { kind: 'human', connected: participant.socket !== null }
    }
    return { P1: info(this.participants.P1), P2: info(this.participants.P2) }
  }

  humanConnected(): Record<ProtocolSeat, boolean> {
    const connected = (seatId: ProtocolSeat): boolean => {
      const participant = this.participants[seatId]
      if (!participant) return false
      return participant.kind === 'ai' || participant.socket !== null
    }
    return { P1: connected('P1'), P2: connected('P2') }
  }

  summary(): RoomSummary {
    const seats = this.seatsInfo()
    const openSeats = (seats.P1 === null ? 1 : 0) + (seats.P2 === null ? 1 : 0)
    return { code: this.code, name: this.name, phase: this.phase(), seats, openSeats }
  }

  // ——— 帧投递 ———

  /** 席位帧出口：编号 → 日志 → socket。AI 席位无 socket，直接丢弃 */
  deliverSeatFrame(seatId: ProtocolSeat, draft: SeatFrameDraft): void {
    const participant = this.participants[seatId]
    if (!participant || participant.kind === 'ai') return
    participant.lastSeq += 1
    const frame = { ...draft, seq: participant.lastSeq } as SeatFrame
    participant.log.push(frame)
    if (participant.log.length > MAX_SEAT_LOG) participant.log.shift()
    participant.socket?.send(JSON.stringify(frame))
  }

  /** 给席位发全量对齐帧（席位缺失时抛错——调用方保证席位已就座） */
  deliverSync(seatId: ProtocolSeat): void {
    const snapshot = this.snapshotFor(seatId)
    if (!snapshot) throw new ProtocolFault('PROTOCOL_ERROR', `席位 ${seatId} 未就座，无法对齐`)
    this.deliverSeatFrame(seatId, { v: PROTOCOL_VERSION, type: 'sync', snapshot })
  }

  /** 连接级帧（seq null，不进日志）：welcome / error 专用 */
  sendError(seatId: ProtocolSeat, code: ProtocolFault['code'], message: string, ruleCode?: string): void {
    const participant = this.participants[seatId]
    if (!participant) return
    const frame = ruleCode === undefined
      ? { v: PROTOCOL_VERSION, seq: null, type: 'error' as const, code, message }
      : { v: PROTOCOL_VERSION, seq: null, type: 'error' as const, code, message, ruleCode }
    participant.socket?.send(JSON.stringify(frame))
  }

  sendRoomResult(seatId: ProtocolSeat, op: RoomResult): void {
    this.deliverSeatFrame(seatId, { v: PROTOCOL_VERSION, type: 'room', op })
  }

  broadcastRoomResult(op: RoomResult): void {
    for (const seatId of ['P1', 'P2'] as const) {
      if (this.participants[seatId]) this.sendRoomResult(seatId, op)
    }
  }

  broadcastSync(): void {
    for (const seatId of ['P1', 'P2'] as const) {
      const snapshot = this.snapshotFor(seatId)
      if (snapshot) this.deliverSeatFrame(seatId, { v: PROTOCOL_VERSION, type: 'sync', snapshot })
    }
  }

  // ——— 席位生命周期 ———

  fillHumanSeat(seatId: ProtocolSeat, deck: DeckDto): Participant {
    const participant: Participant = {
      seat: seatId,
      token: randomUUID(),
      kind: 'human',
      setup: deckToSetup(seatId, deck),
      socket: null,
      log: [],
      lastSeq: 0,
      disconnectedAt: null,
    }
    this.participants[seatId] = participant
    return participant
  }

  fillAiSeat(seatId: ProtocolSeat, difficulty: AiDifficulty, hostFaction?: string): Participant {
    const aiDeck = aiSeatDeck(hostFaction)
    const participant: Participant = {
      seat: seatId,
      token: randomUUID(),
      kind: 'ai',
      difficulty,
      setup: {
        id: seatId,
        faction: aiDeck.faction,
        deck: { cards: aiDeck.cards },
      },
      socket: null,
      log: [],
      lastSeq: 0,
      disconnectedAt: null,
    }
    this.participants[seatId] = participant
    return participant
  }

  bindSocket(seatId: ProtocolSeat, socket: ServerSocket): void {
    const participant = this.participants[seatId]
    if (!participant) throw new ProtocolFault('INVALID_TOKEN', '席位不存在')
    if (participant.socket && participant.socket !== socket) {
      participant.socket.terminate() // 半死连接被新连接接管（重连恢复）
    }
    participant.socket = socket
    participant.disconnectedAt = null
  }

  unbindSocket(seatId: ProtocolSeat, socket: ServerSocket): void {
    const participant = this.participants[seatId]
    if (!participant || participant.socket !== socket) return
    participant.socket = null
    participant.disconnectedAt = this.now()
  }

  startGame(seed?: number): void {
    const p1 = this.participants.P1
    const p2 = this.participants.P2
    if (!p1 || !p2) throw new ProtocolFault('ROOM_NOT_FULL', '对局需要两名玩家就座')
    if (this.game) throw new ProtocolFault('GAME_ALREADY_STARTED', '对局已经开始')
    const aiSeats: AiSeatMap = {}
    if (p1.kind === 'ai') aiSeats.P1 = p1.difficulty ?? 'normal'
    if (p2.kind === 'ai') aiSeats.P2 = p2.difficulty ?? 'normal'
    const players: [PlayerSetup, PlayerSetup] = [
      { ...p1.setup, id: 'P1' },
      { ...p2.setup, id: 'P2' },
    ]
    this.game = new GameSession({
      seed: seed ?? (this.now() % 0x7fffffff),
      roomCode: this.code,
      roomName: this.name,
      players,
      aiSeats,
      onSeatFrame: (seatId, draft) => this.deliverSeatFrame(seatId, draft),
      onActionApplied: this.options.onActionApplied,
    })
    this.broadcastRoomResult({ name: 'started', seats: this.seatsInfo(), phase: this.phase() })
    for (const seatId of ['P1', 'P2'] as const) {
      if (this.participants[seatId]?.kind === 'human') this.game.sendSyncFrame(seatId, this.humanConnected())
    }
    this.game.runAiTurns() // AI 先手时先走完第一回合
  }

  resumeSeat(seatId: ProtocolSeat, lastSeq: number | null): number {
    const participant = this.participants[seatId]
    if (!participant) throw new ProtocolFault('INVALID_TOKEN', '席位不存在')
    let replayed = 0
    if (lastSeq !== null && lastSeq <= participant.lastSeq && participant.log.length > 0) {
      const oldest = participant.log[0]?.seq ?? Number.POSITIVE_INFINITY
      if (oldest <= lastSeq + 1) {
        for (const frame of participant.log) {
          if (frame.seq > lastSeq) {
            participant.socket?.send(JSON.stringify(frame))
            replayed += 1
          }
        }
      }
      // 日志起头都晚于 lastSeq+1：中间有缺口，放弃回放，靠随后的 sync 全量对齐
    }
    this.deliverSeatFrame(seatId, { v: PROTOCOL_VERSION, type: 'room', op: { name: 'resumed', seat: seatId, replayed } })
    const snapshot = this.snapshotFor(seatId)
    if (snapshot) this.deliverSeatFrame(seatId, { v: PROTOCOL_VERSION, type: 'sync', snapshot })
    return replayed
  }

  /** 房间是否可以销毁：没有任何人类席位，或全部人类席位断开超过宽限期 */
  isStale(nowMs: number, graceMs: number): boolean {
    const humanSeats = (['P1', 'P2'] as const)
      .map((seatId) => this.participants[seatId])
      .filter((participant): participant is Participant => participant !== undefined && participant.kind === 'human')
    if (humanSeats.length === 0) return true
    return humanSeats.every((participant) => {
      if (participant.socket !== null) return false
      return participant.disconnectedAt !== null && nowMs - participant.disconnectedAt > graceMs
    })
  }
}

function deckToSetup(seatId: ProtocolSeat, deck: DeckDto): PlayerSetup {
  return {
    id: seatId,
    faction: deck.faction,
    heroName: deck.heroName,
    deck: { cards: deck.cards.map((entry) => ({ ...entry })) },
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>()
  private readonly bindings = new Map<ServerSocket, { room: Room; seat: ProtocolSeat }>()
  private readonly options: Required<Pick<RoomManagerOptions, 'disconnectGraceMs' | 'maxRooms'>> & RoomManagerOptions
  private readonly randomCodeInt: (maxExclusive: number) => number

  constructor(options: RoomManagerOptions = {}) {
    this.options = {
      ...options,
      disconnectGraceMs: options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS,
      maxRooms: options.maxRooms ?? DEFAULT_MAX_ROOMS,
    }
    this.randomCodeInt = options.randomCodeInt ?? defaultRandomInt
  }

  bindingOf(socket: ServerSocket): { room: Room; seat: ProtocolSeat } | undefined {
    return this.bindings.get(socket)
  }

  getByCode(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase())
  }

  /** 主动销毁单个房间（对局结束清理 / 运维 / 测试；触发 onRoomRemoved 撤 mDNS） */
  dropRoom(code: string): boolean {
    const room = this.rooms.get(code.toUpperCase())
    if (!room) return false
    this.rooms.delete(room.code)
    this.options.onRoomRemoved?.(room.summary())
    return true
  }

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()].map((room) => room.summary())
  }

  createRoom(socket: ServerSocket, request: CreateRoomRequest): Room {
    if (this.bindings.has(socket)) throw new ProtocolFault('ALREADY_SEATED', '当前连接已就座（先 leave 或断开）')
    if (this.rooms.size >= this.options.maxRooms) {
      throw new ProtocolFault('ROOM_FULL', `服务器房间数已达上限（${this.options.maxRooms}）`)
    }
    const deckIssue = validateDeckDto(request.deck)
    if (deckIssue) throw new ProtocolFault('DECK_INVALID', deckIssue)
    const code = this.uniqueCode()
    const room = new Room(code, request.roomName ?? `房间 ${code}`, this.options)
    this.rooms.set(code, room)
    const participant = room.fillHumanSeat('P1', request.deck)
    room.bindSocket('P1', socket)
    this.bindings.set(socket, { room, seat: 'P1' })
    if (request.fillWithAi) room.fillAiSeat('P2', 'normal', request.deck.faction)
    room.sendRoomResult('P1', {
      name: 'created',
      code,
      token: participant.token,
      seat: 'P1',
      seats: room.seatsInfo(),
      phase: room.phase(),
    })
    room.deliverSync('P1')
    this.options.onRoomAdded?.(room.summary())
    return room
  }

  joinRoom(socket: ServerSocket, code: string, deck: DeckDto): Room {
    if (this.bindings.has(socket)) throw new ProtocolFault('ALREADY_SEATED', '当前连接已就座（先 leave 或断开）')
    const room = this.rooms.get(code.toUpperCase())
    if (!room) throw new ProtocolFault('ROOM_NOT_FOUND', `房间 ${code} 不存在或已解散`)
    if (room.seat('P2')) throw new ProtocolFault('ROOM_FULL', `房间 ${code} 已满员`)
    const deckIssue = validateDeckDto(deck)
    if (deckIssue) throw new ProtocolFault('DECK_INVALID', deckIssue)
    const participant = room.fillHumanSeat('P2', deck)
    room.bindSocket('P2', socket)
    this.bindings.set(socket, { room, seat: 'P2' })
    room.sendRoomResult('P2', {
      name: 'joined',
      code: room.code,
      token: participant.token,
      seat: 'P2',
      seats: room.seatsInfo(),
      phase: room.phase(),
    })
    room.deliverSync('P2')
    room.broadcastRoomResult({ name: 'seat_update', seats: room.seatsInfo(), phase: room.phase() })
    return room
  }

  resumeRoom(socket: ServerSocket, code: string, token: string, lastSeq: number | null): { room: Room; seat: ProtocolSeat; replayed: number } {
    const room = this.rooms.get(code.toUpperCase())
    if (!room) throw new ProtocolFault('ROOM_NOT_FOUND', `房间 ${code} 不存在或已解散`)
    for (const seatId of ['P1', 'P2'] as const) {
      const participant = room.seat(seatId)
      if (participant && participant.kind === 'human' && participant.token === token) {
        if (this.bindings.has(socket)) throw new ProtocolFault('ALREADY_SEATED', '当前连接已就座（先 leave 或断开）')
        room.bindSocket(seatId, socket)
        this.bindings.set(socket, { room, seat: seatId })
        const replayed = room.resumeSeat(seatId, lastSeq)
        room.broadcastRoomResult({ name: 'seat_update', seats: room.seatsInfo(), phase: room.phase() })
        return { room, seat: seatId, replayed }
      }
    }
    throw new ProtocolFault('INVALID_TOKEN', '重连令牌无效（席位不匹配或令牌过期）')
  }

  addAi(socket: ServerSocket, difficulty?: AiDifficulty, faction?: string): Room {
    const binding = this.requireBinding(socket)
    const room = binding.room
    if (binding.seat !== 'P1') throw new ProtocolFault('NOT_HOST', '只有房主可以添加 AI 托管')
    if (room.phase() !== 'lobby') throw new ProtocolFault('GAME_ALREADY_STARTED', '对局开始后不能添加 AI')
    if (room.seat('P2')) throw new ProtocolFault('AI_SEAT_TAKEN', '对面席位已有人（或已有 AI）')
    const host = room.seat('P1')
    room.fillAiSeat('P2', difficulty ?? 'normal', faction ?? host?.setup.faction)
    room.broadcastRoomResult({ name: 'ai_added', seats: room.seatsInfo(), phase: room.phase() })
    room.broadcastSync()
    return room
  }

  startGame(socket: ServerSocket, seed?: number): Room {
    const binding = this.requireBinding(socket)
    const room = binding.room
    if (binding.seat !== 'P1') throw new ProtocolFault('NOT_HOST', '只有房主可以开始对局')
    room.startGame(seed)
    return room
  }

  leave(socket: ServerSocket): void {
    const binding = this.bindings.get(socket)
    if (!binding) throw new ProtocolFault('PROTOCOL_ERROR', '当前连接未就座')
    // 先回执再断开（leave 回执走席位日志，socket 关闭前送出）
    binding.room.sendRoomResult(binding.seat, { name: 'left' })
    this.detach(socket, binding)
    socket.close(1000, 'leave')
  }

  /** socket 断开（含 leave/terminate/网络掉线）统一走这里 */
  handleDisconnect(socket: ServerSocket): void {
    const binding = this.bindings.get(socket)
    if (binding) this.detach(socket, binding)
  }

  /** 宽限 GC：返回本次销毁的房间 */
  sweep(): RoomSummary[] {
    const nowMs = (this.options.now ?? Date.now)()
    const destroyed: RoomSummary[] = []
    for (const room of [...this.rooms.values()]) {
      if (room.isStale(nowMs, this.options.disconnectGraceMs)) {
        destroyed.push(room.summary())
        this.rooms.delete(room.code)
        this.options.onRoomRemoved?.(room.summary())
      }
    }
    return destroyed
  }

  destroyAll(): RoomSummary[] {
    const destroyed: RoomSummary[] = []
    for (const room of [...this.rooms.values()]) {
      destroyed.push(room.summary())
      this.rooms.delete(room.code)
      this.options.onRoomRemoved?.(room.summary())
    }
    this.bindings.clear()
    return destroyed
  }

  private requireBinding(socket: ServerSocket): { room: Room; seat: ProtocolSeat } {
    const binding = this.bindings.get(socket)
    if (!binding) throw new ProtocolFault('PROTOCOL_ERROR', '当前连接未就座')
    return binding
  }

  private detach(socket: ServerSocket, binding: { room: Room; seat: ProtocolSeat }): void {
    this.bindings.delete(socket)
    binding.room.unbindSocket(binding.seat, socket)
    // 只有断开的是当前绑定 socket 时才广播席位变化（重连接管旧连接时不误报离线）
    const participant = binding.room.seat(binding.seat)
    if (participant?.kind === 'human' && participant.socket !== socket && participant.disconnectedAt !== null) {
      binding.room.broadcastRoomResult({ name: 'seat_update', seats: binding.room.seatsInfo(), phase: binding.room.phase() })
    }
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 64; attempt++) {
      const code = generateRoomCode(this.randomCodeInt)
      if (!this.rooms.has(code)) return code
    }
    throw new Error('房间码生成失败：64 次尝试均冲突（房间表异常）')
  }
}
