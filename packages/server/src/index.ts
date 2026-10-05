/**
 * @siliconcard/server — LAN 对战权威服务端（Node + ws，M2-NET1..3）。
 *
 * 硬约束：服务端持有完整 GameState，客户端只收 viewFor 裁剪视图；
 * 对局上行仅 { type: 'action' }；消息带 seq，断线重连全量对齐；
 * mDNS 发现（_siliconcard._tcp）失败必须可回退手动 IP:port 直连。
 *
 * 入口：
 * - 程序内嵌：createGameServer({ port, discovery, ... })
 * - 命令行：yarn workspace @siliconcard/server start（见 src/main.ts）
 * - 模拟客户端：sim:host / sim:join（E2E 验收员直用，见 src/sim/）
 * 协议契约：src/protocol.ts（与 client/src/net/protocol.ts 双胞胎），文档 docs/protocol.md。
 */

export const SERVER_VERSION = '0.1.0' // M2-NET1..3：ws 权威服务端 + 房间/mDNS/重连/AI 托管

export { PROTOCOL_VERSION } from './protocol'
export type {
  ActionFrame,
  AiDifficulty,
  AiSeatMap,
  ClientFrame,
  ConnectionFrame,
  DeckDto,
  ErrorFrame,
  GameSnapshot,
  ParsedClientFrame,
  ProtocolErrorCode,
  ProtocolSeat,
  RoomFrame,
  RoomOp,
  RoomPhase,
  RoomResult,
  SeatFrame,
  SeatFrameDraft,
  SeatInfo,
} from './protocol'
export { MAX_FRAME_BYTES, MAX_SEAT_LOG, parseClientFrame } from './protocol'

export { DEFAULT_SERVER_PORT, createGameServer, type GameServer, type GameServerOptions } from './server'
export {
  DEFAULT_DISCONNECT_GRACE_MS,
  DEFAULT_MAX_ROOMS,
  ROOM_CODE_LENGTH,
  Room,
  RoomManager,
  generateRoomCode,
  type CreateRoomRequest,
  type RoomSummary,
  type ServerSocket,
} from './room'
export { GameSession, ProtocolFault, type ActionAppliedInfo, type RuleViolationInfo } from './gameHost'
export { Discovery, MDNS_SERVICE_TYPE, type DiscoveredRoom } from './discovery'
export { aiSeatDeck, loadServerContent, validateDeckDto, type DeckFile, type ServerContent } from './content'
