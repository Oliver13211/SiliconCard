/**
 * 硅牌 LAN 协议契约 · 客户端侧（M2-NET1..3，协议版本 1）—— 文档见 docs/protocol.md。
 *
 * ⚠ 本文件与 packages/server/src/protocol.ts 是同一契约的双胞胎：
 *   任何改动必须 server 与 client 同一提交并升 PROTOCOL_VERSION（WF-NET）。
 *   浏览器端不引入 ws/bonjour 依赖（联机走原生 WebSocket，零新增包）。
 *
 * 硬约束：对局上行仅 { type: 'action' }；服务端下行帧带 seq（席位可回放日志）；
 * 重连 = resume(lastSeq) 续传 + 恒定一次全量对齐（sync）。
 */

import type { Action, GameEvent, PlayerView } from '@siliconcard/core'

/** 协议版本：消息形状/语义不兼容变更时 +1（按服务端 welcome.protocol 校验） */
export const PROTOCOL_VERSION = 1

export type ProtocolSeat = 'P1' | 'P2'

export type AiDifficulty = 'easy' | 'normal' | 'hard'

/** AI 托管席位 → 难度（人类席位不出现） */
export type AiSeatMap = Partial<Record<ProtocolSeat, AiDifficulty>>

// ————————————————————————————————————————————————
// 卡组 DTO（create/join 携带；结构与 server 侧同形）
// ————————————————————————————————————————————————

export interface DeckDto {
  faction: string
  heroName?: string
  cards: readonly { cardId: string; count: number }[]
}

// ————————————————————————————————————————————————
// 客户端 → 服务端
// ————————————————————————————————————————————————

export type RoomOp =
  | { name: 'create'; roomName?: string; deck: DeckDto; fillWithAi?: boolean }
  | { name: 'join'; code: string; deck: DeckDto }
  | { name: 'start'; seed?: number }
  | { name: 'add_ai'; difficulty?: AiDifficulty; faction?: string }
  | { name: 'leave' }
  | { name: 'resume'; code: string; token: string; lastSeq: number | null }

/** 对局上行仅 action 一种 */
export interface ActionFrame {
  v: number
  type: 'action'
  action: Action
}

export interface RoomFrame {
  v: number
  type: 'room'
  op: RoomOp
}

export type ClientFrame = ActionFrame | RoomFrame

// ————————————————————————————————————————————————
// 服务端 → 客户端
// ————————————————————————————————————————————————

/** 席位呈现（联机 UI 的等待/重连提示数据源，M2-UI4） */
export interface SeatInfo {
  kind: 'human' | 'ai'
  connected: boolean
  difficulty?: AiDifficulty
}

/** 席位表：房间结果/大厅快照里未就座席位为 null；对局快照中恒非空 */
export type SeatMap = Record<ProtocolSeat, SeatInfo | null>

export type RoomPhase = 'lobby' | 'playing' | 'ended'

/** 全量对齐快照：开局与每次重连必发一次；view 为该席位 viewFor 视图 */
export interface GameSnapshot {
  roomCode: string
  roomName: string
  seat: ProtocolSeat
  seats: SeatMap
  phase: RoomPhase
  seed: number | null
  view: PlayerView | null
  legalActions: readonly Action[]
}

/** 房间控制回执（seq 计入席位日志，可随重连回放） */
export type RoomResult =
  | { name: 'created'; code: string; token: string; seat: ProtocolSeat; seats: SeatMap; phase: RoomPhase }
  | { name: 'joined'; code: string; token: string; seat: ProtocolSeat; seats: SeatMap; phase: RoomPhase }
  | { name: 'started'; seats: SeatMap; phase: RoomPhase }
  | { name: 'ai_added'; seats: SeatMap; phase: RoomPhase }
  | { name: 'resumed'; seat: ProtocolSeat; replayed: number }
  | { name: 'left' }
  | { name: 'seat_update'; seats: SeatMap; phase: RoomPhase }

export type SeatFrame =
  | { v: number; seq: number; type: 'sync'; snapshot: GameSnapshot }
  | { v: number; seq: number; type: 'events'; events: readonly GameEvent[]; view: PlayerView; legalActions: readonly Action[] }
  | { v: number; seq: number; type: 'room'; op: RoomResult }

/** 连接级错误帧（不回放） */
export interface ErrorFrame {
  v: number
  seq: null
  type: 'error'
  code: ProtocolErrorCode
  message: string
  ruleCode?: string
}

export type ConnectionFrame =
  | { v: number; seq: null; type: 'welcome'; protocol: number }
  | ErrorFrame

export type ServerFrame = SeatFrame | ConnectionFrame

export type ProtocolErrorCode =
  | 'VERSION_MISMATCH'
  | 'PROTOCOL_ERROR'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_NOT_FULL'
  | 'INVALID_TOKEN'
  | 'ROOM_GONE'
  | 'NOT_HOST'
  | 'ALREADY_SEATED'
  | 'SEAT_EMPTY'
  | 'AI_SEAT_TAKEN'
  | 'DECK_INVALID'
  | 'GAME_ALREADY_STARTED'
  | 'GAME_NOT_STARTED'
  | 'WRONG_SEAT'
  | 'NOT_IN_GAME'
  | 'RULE_VIOLATION'

// ————————————————————————————————————————————————
// HTTP 房间列表（手动 IP:port 直连的配套发现；GET /siliconcard/rooms）
// ————————————————————————————————————————————————

export interface RoomSummaryDto {
  code: string
  name: string
  phase: RoomPhase
  seats: SeatMap
  openSeats: number
}

/** 判断帧是否为席位回放帧（seq 非 null） */
export function isSeatFrame(frame: ServerFrame): frame is SeatFrame {
  return frame.seq !== null
}
