/**
 * @siliconcard/client · net 层（M2-NET1..3）—— 联机对接面，UI 线唯一入口。
 *
 * 组装（典型用法）：
 * ```ts
 * import { LanConnection, RoomApi, RemoteBattleDriver, fetchLanRooms } from '../net'
 * const conn = new LanConnection('ws://192.168.1.20:49321', {
 *   onClose: () => { ...提示重连（M2-UI4）... },
 * })
 * await conn.connect()
 * const rooms = new RoomApi(conn)
 * const driver = new RemoteBattleDriver(conn)
 * driver.attach()
 * const created = await rooms.createRoom({ deck, fillWithAi: false })
 * // 对局事实：driver.current.{view, legalActions}；事件：driver.onBattleEvents(...)
 * // 出招：driver.dispatch(action) —— 上行仅 {type:'action'}，结算全在服务端
 * // 断线恢复：await rooms.resume()（lastSeq 续传 + 全量对齐 sync）
 * ```
 *
 * 发现路径：局域网自动发现（mDNS）只能在 Node 侧进行（server 包 Discovery /
 * sim 脚本 --discover）；浏览器端的主路径是手动 IP:port 直连 + fetchLanRooms
 * 拉取房间列表——mDNS 失败不影响该硬回退（net-dev 预设硬约束）。
 *
 * 协议契约：./protocol.ts 与 packages/server/src/protocol.ts 双胞胎，改动必须
 * server + client 同一提交并升版本号（WF-NET）。
 */

export { PROTOCOL_VERSION, isSeatFrame } from './protocol'
export type {
  ActionFrame,
  AiDifficulty,
  AiSeatMap,
  ClientFrame,
  ConnectionFrame,
  DeckDto,
  ErrorFrame,
  GameSnapshot,
  ProtocolErrorCode,
  ProtocolSeat,
  RoomFrame,
  RoomOp,
  RoomPhase,
  RoomResult,
  RoomSummaryDto,
  SeatFrame,
  SeatInfo,
  SeatMap,
  ServerFrame,
} from './protocol'

export { LanConnection, httpRoomsUrl, type LanConnectionHandlers } from './connection'
export { RoomApi, fetchLanRooms, type CreatedResult, type JoinedResult, type SeatCredentials } from './rooms'
export { RemoteBattleDriver, type RemoteBattleState } from './remoteDriver'
