/**
 * RoomApi —— 房间控制 API（M2-NET2/M2-NET3）：建房/加入/开局/AI 托管/离开/重连。
 * 每个方法 = 发送 room op → 等待对应回执（Promise + 超时）。
 * 重连带 lastSeq 续传；断线凭据（code/token）由 createRoom/joinRoom 回执保管
 * （联机 UI 可持久化以支撑页面刷新后恢复，M2-UI4）。
 */

import type { LanConnection } from './connection'
import type {
  AiDifficulty,
  DeckDto,
  RoomOp,
  RoomResult,
  RoomSummaryDto,
  ServerFrame,
} from './protocol'

export type CreatedResult = Extract<RoomResult, { name: 'created' }>
export type JoinedResult = Extract<RoomResult, { name: 'joined' }>

/** 断线重连凭据 */
export interface SeatCredentials {
  code: string
  token: string
  seat: 'P1' | 'P2'
}

export class RoomApi {
  private credentials: SeatCredentials | null = null
  private readonly pending = new Set<(frame: ServerFrame) => void>()

  constructor(private readonly conn: LanConnection) {
    void this.conn.onFrame((frame) => {
      for (const waiter of this.pending) waiter(frame)
    })
  }

  get seatCredentials(): SeatCredentials | null {
    return this.credentials
  }

  private waitForRoomResult<T extends RoomResult['name']>(expectName: T, timeoutMs: number): Promise<Extract<RoomResult, { name: T }>> {
    return new Promise<Extract<RoomResult, { name: T }>>((resolveWait, rejectWait) => {
      const timer = setTimeout(() => {
        this.pending.delete(waiter)
        rejectWait(new Error(`等待超时（回执 ${expectName}，${String(timeoutMs)}ms）`))
      }, timeoutMs)
      const waiter = (frame: ServerFrame): void => {
        if (frame.type !== 'room' || frame.op.name !== expectName) return
        clearTimeout(timer)
        this.pending.delete(waiter)
        resolveWait(frame.op as Extract<RoomResult, { name: T }>)
      }
      this.pending.add(waiter)
    })
  }

  private async request<T extends RoomResult['name']>(op: RoomOp, expectName: T, timeoutMs = 8000): Promise<Extract<RoomResult, { name: T }>> {
    const pendingResult = this.waitForRoomResult(expectName, timeoutMs)
    this.conn.send({ v: 1, type: 'room', op })
    return pendingResult
  }

  async createRoom(request: { roomName?: string; deck: DeckDto; fillWithAi?: boolean }): Promise<CreatedResult> {
    const result = await this.request({ name: 'create', roomName: request.roomName, deck: request.deck, fillWithAi: request.fillWithAi }, 'created')
    this.credentials = { code: result.code, token: result.token, seat: result.seat }
    return result
  }

  async joinRoom(code: string, deck: DeckDto): Promise<JoinedResult> {
    const result = await this.request({ name: 'join', code, deck }, 'joined')
    this.credentials = { code: result.code, token: result.token, seat: result.seat }
    return result
  }

  async start(seed?: number): Promise<Extract<RoomResult, { name: 'started' }>> {
    return this.request({ name: 'start', seed }, 'started')
  }

  async addAi(difficulty?: AiDifficulty, faction?: string): Promise<Extract<RoomResult, { name: 'ai_added' }>> {
    return this.request({ name: 'add_ai', difficulty, faction }, 'ai_added')
  }

  async leave(): Promise<Extract<RoomResult, { name: 'left' }>> {
    const result = await this.request({ name: 'leave' }, 'left')
    this.credentials = null
    return result
  }

  /** 断线重连：lastSeq 续传 + 恒定一次全量对齐（sync）。lastSeq 缺省取 LanConnection 追踪值 */
  async resume(request?: { code: string; token: string; lastSeq: number | null }): Promise<Extract<RoomResult, { name: 'resumed' }>> {
    const basis = request ?? this.credentials
    if (!basis) throw new Error('没有重连凭据（先 createRoom/joinRoom 或手动传入 code/token）')
    const lastSeq = request?.lastSeq ?? this.conn.lastSeq
    const result = await this.request({ name: 'resume', code: basis.code, token: basis.token, lastSeq }, 'resumed')
    this.credentials = { code: basis.code, token: basis.token, seat: result.seat }
    return result
  }
}

/** HTTP 房间列表（手动 IP:port 直连路径的配套发现；mDNS 在浏览器侧不可用） */
export async function fetchLanRooms(wsUrl: string, timeoutMs = 5000): Promise<RoomSummaryDto[]> {
  const httpUrl = wsUrl.replace(/^ws/, 'http').replace(/\/$/, '') + '/siliconcard/rooms'
  const response = await fetch(httpUrl, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`房间列表请求失败：HTTP ${String(response.status)}`)
  const body = (await response.json()) as { v: number; rooms?: RoomSummaryDto[] }
  return body.rooms ?? []
}
