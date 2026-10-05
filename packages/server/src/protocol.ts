/**
 * 硅牌 LAN 协议契约（M2-NET1..3，协议版本 1）—— 完整文档见 docs/protocol.md。
 *
 * 职责：消息 schema（帧信封 / 房间控制 op / 对局帧）、协议版本号、错误码、
 * seq 语义常量。本文件与 packages/client/src/net/protocol.ts 是同一契约的
 * 双胞胎：任何改动必须 server 与 client 同一提交并升版本号（WF-NET）。
 *
 * 硬约束（net-dev 预设 + 架构铁律 3）：
 * - 服务端是权威节点，客户端只见 viewFor 视图；
 * - 对局上行仅 { type: 'action' }，房间控制消息以 { type: 'room' } 另列；
 * - 所有服务端下行帧带 seq；seq 非 null 的帧进入该席位可回放日志，
 *   断线重连按 lastSeq 续传，并始终追加一次全量对齐（sync）。
 */

import type { Action, GameEvent, PlayerView } from '@siliconcard/core'

/** 协议版本：消息形状/语义不兼容变更时 +1（客户端按 welcome.protocol 校验） */
export const PROTOCOL_VERSION = 1

/** 席位（与 core PlayerId 同构；协议层独立命名避免泄漏引擎类型到房间层） */
export type ProtocolSeat = 'P1' | 'P2'

export const PROTOCOL_SEATS: readonly ProtocolSeat[] = ['P1', 'P2']

export type AiDifficulty = 'easy' | 'normal' | 'hard'

/** AI 托管席位 → 难度（人类席位不出现） */
export type AiSeatMap = Partial<Record<ProtocolSeat, AiDifficulty>>

/** ws 协议违规关闭码（1000/4xxx 标准段内自选） */
export const CLOSE_PROTOCOL_ERROR = 4002
export const CLOSE_VERSION_MISMATCH = 4003

/** 单帧大小上限（字节）：卡组 DTO + 动作远小于此，超限视为攻击直接断开 */
export const MAX_FRAME_BYTES = 1_048_576

/** 每席位回放日志上限（条）：超出丢最旧，重连回放若无法覆盖则退化为仅全量对齐 */
export const MAX_SEAT_LOG = 4096

// ————————————————————————————————————————————————
// 卡组 DTO（create/join 携带；结构在房间层校验，规则语义由引擎 initGame 把关）
// ————————————————————————————————————————————————

export interface DeckDto {
  /** 派系 id（内置四系：nvidia / amd / intel / neutral） */
  faction: string
  /** 英雄显示名（缺省由引擎按派系给默认） */
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

/** 对局上行仅 action 一种；action 形状由引擎校验（未知形状 → 引擎 RuleError 转协议错误帧） */
export interface ActionFrame {
  v: number
  type: 'action'
  action: unknown
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
  /** 对局种子（对局未开始为 null；GAME_START 事件亦携带） */
  seed: number | null
  view: PlayerView | null
  /** 仅当轮到该席位且对局进行中时非空；对手回合恒为空（不泄漏手牌可打性） */
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

/** seq 非 null 的帧属于该席位可回放日志（按 lastSeq 续传）；seq null 的帧只发当次 */
export type SeatFrame =
  | { v: number; seq: number; type: 'sync'; snapshot: GameSnapshot }
  | { v: number; seq: number; type: 'events'; events: readonly GameEvent[]; view: PlayerView; legalActions: readonly Action[] }
  | { v: number; seq: number; type: 'room'; op: RoomResult }

/** 席位帧草稿（尚未编号）：GameSession 产出，房间层统一分配 seq 后成为 SeatFrame */
export type SeatFrameDraft = DistributiveOmit<SeatFrame, 'seq'>

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** 连接级错误帧（不回放） */
export interface ErrorFrame {
  v: number
  seq: null
  type: 'error'
  code: ProtocolErrorCode
  message: string
  /** RULE_VIOLATION 时携带引擎 RuleErrorCode 原文 */
  ruleCode?: string
}

/** 连接级帧（不回放）：welcome / error */
export type ConnectionFrame =
  | { v: number; seq: null; type: 'welcome'; protocol: number }
  | ErrorFrame

export type ServerFrame = SeatFrame | ConnectionFrame

/** 协议错误码（引擎 RuleError 走 RULE_VIOLATION，原错误码放 ruleCode 字段） */
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
// 帧解析（服务端入站唯一闸门：宽松解析 → 明确拒绝）
// ————————————————————————————————————————————————

export interface ParsedActionFrame {
  v: number
  kind: 'action'
  /** 原始 action 载荷（交引擎校验） */
  action: unknown
}

export interface ParsedRoomFrame {
  v: number
  kind: 'room'
  /** 房间控制 op（已做最小形状校验） */
  op: RoomOp
}

export type ParsedClientFrame = ParsedActionFrame | ParsedRoomFrame

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 最小形状校验：字段类型对得上才放行；形状即错返回 null（调用方发 PROTOCOL_ERROR 并断开） */
export function parseClientFrame(raw: string): ParsedClientFrame | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const v = value['v']
  const type = value['type']
  if (typeof v !== 'number' || !Number.isInteger(v)) return null
  if (type === 'action') {
    const action = value['action']
    if (!isRecord(action) || typeof action['type'] !== 'string') return null
    return { v, kind: 'action', action }
  }
  if (type === 'room') {
    const op = value['op']
    if (!isRecord(op) || typeof op['name'] !== 'string') return null
    switch (op['name']) {
      case 'create': {
        const deck = op['deck']
        if (!isDeckDto(deck)) return null
        const roomName = op['roomName']
        return {
          v,
          kind: 'room',
          op: {
            name: 'create',
            roomName: typeof roomName === 'string' && roomName.length > 0 ? roomName.slice(0, 40) : undefined,
            deck,
            fillWithAi: op['fillWithAi'] === true,
          },
        }
      }
      case 'join': {
        const deck = op['deck']
        if (!isDeckDto(deck) || typeof op['code'] !== 'string') return null
        return { v, kind: 'room', op: { name: 'join', code: op['code'].toUpperCase().slice(0, 12), deck } }
      }
      case 'start': {
        const seed = op['seed']
        return { v, kind: 'room', op: { name: 'start', seed: typeof seed === 'number' && Number.isFinite(seed) ? Math.trunc(seed) : undefined } }
      }
      case 'add_ai': {
        const difficulty = op['difficulty']
        const faction = op['faction']
        return {
          v,
          kind: 'room',
          op: {
            name: 'add_ai',
            difficulty: difficulty === 'easy' || difficulty === 'normal' || difficulty === 'hard' ? difficulty : undefined,
            faction: typeof faction === 'string' && faction.length > 0 ? faction : undefined,
          },
        }
      }
      case 'leave':
        return { v, kind: 'room', op: { name: 'leave' } }
      case 'resume': {
        if (typeof op['code'] !== 'string' || typeof op['token'] !== 'string') return null
        const lastSeq = op['lastSeq']
        return {
          v,
          kind: 'room',
          op: {
            name: 'resume',
            code: op['code'].toUpperCase().slice(0, 12),
            token: op['token'],
            lastSeq: typeof lastSeq === 'number' && Number.isInteger(lastSeq) && lastSeq >= 0 ? lastSeq : null,
          },
        }
      }
      default:
        return null
    }
  }
  return null
}

function isDeckDto(value: unknown): value is DeckDto {
  if (!isRecord(value) || typeof value['faction'] !== 'string' || value['faction'].length === 0) return false
  const cards = value['cards']
  if (!Array.isArray(cards) || cards.length === 0) return false
  return cards.every((entry) => {
    if (!isRecord(entry)) return false
    const cardId = entry['cardId']
    const count = entry['count']
    return typeof cardId === 'string' && cardId.length > 0 && typeof count === 'number' && Number.isInteger(count) && count > 0
  })
}
