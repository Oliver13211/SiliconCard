/**
 * createGameServer —— LAN 权威服务端装配（M2-NET1..3）。
 *
 * 职责：http + ws 承载、帧解析闸门（大小/JSON/版本/类型）、消息路由
 * （对局 action ↔ 房间控制 room）、心跳探活、HTTP 房间列表（手动 IP:port
 * 直连的配套发现）、mDNS 广播挂接。
 *
 * 安全姿态（局域网玩具级但该挡的都挡）：单帧 1MB 上限、协议违规断开
 * （4002/4003）、动作必须来自已就座连接且 playerId 与席位一致、非法动作
 * 不改变状态只回 error 帧。
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocketServer, type WebSocket, type RawData } from 'ws'
import { loadServerContent, type ServerContent } from './content'
import { ProtocolFault, type ActionAppliedInfo } from './gameHost'
import { Discovery } from './discovery'
import { RoomManager, type RoomSummary, type ServerSocket } from './room'
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_VERSION_MISMATCH,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseClientFrame,
} from './protocol'
import type { ErrorFrame } from './protocol'

export const DEFAULT_SERVER_PORT = 49321

export interface GameServerOptions {
  host?: string
  port?: number
  contentDir?: string
  /** 是否开启 mDNS 房间广播（默认关；main.ts 默认开；手动 IP:port 直连永远可用） */
  discovery?: boolean
  disconnectGraceMs?: number
  maxRooms?: number
  /** 验收/调试钩子（100 局零漂移测试对账服务端真相） */
  onActionApplied?: (info: ActionAppliedInfo) => void
}

export interface GameServer {
  readonly host: string
  readonly port: number
  readonly rooms: RoomManager
  readonly discovery: Discovery | null
  readonly content: ServerContent
  listRooms(): RoomSummary[]
  /** ws 直连地址（手动 IP:port 回退路径的直接入口） */
  url(): string
  close(): Promise<void>
}

function rawDataToText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8')
  return Buffer.from(data as ArrayBuffer).toString('utf8')
}

export function createGameServer(options: GameServerOptions = {}): Promise<GameServer> {
  const host = options.host ?? '0.0.0.0'
  const content = loadServerContent(options.contentDir)
  const discovery = options.discovery === true ? new Discovery() : null

  const rooms = new RoomManager({
    disconnectGraceMs: options.disconnectGraceMs,
    maxRooms: options.maxRooms,
    onActionApplied: options.onActionApplied,
    onRoomAdded: (summary) => discovery?.publishRoom({ code: summary.code, name: summary.name, port: boundPort }),
    onRoomRemoved: (summary) => discovery?.unpublishRoom(summary.code),
  })
  // 房间只能在 listen 之后（有连接才可能建房），boundPort 在首个建房前就已就位
  let boundPort = 0

  const httpServer = http.createServer((request, response) => {
    const url = request.url ?? ''
    if (request.method === 'GET' && (url === '/siliconcard/rooms' || url.startsWith('/siliconcard/rooms?'))) {
      const body = JSON.stringify({ v: PROTOCOL_VERSION, rooms: rooms.listRooms() })
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
      })
      response.end(body)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ v: PROTOCOL_VERSION, error: 'NOT_FOUND' }))
  })

  const wss = new WebSocketServer({ server: httpServer })
  const alive = new WeakMap<WebSocket, boolean>()

  const sendError = (socket: WebSocket, code: ErrorFrame['code'], message: string, ruleCode?: string): void => {
    const frame: ErrorFrame = ruleCode === undefined
      ? { v: PROTOCOL_VERSION, seq: null, type: 'error', code, message }
      : { v: PROTOCOL_VERSION, seq: null, type: 'error', code, message, ruleCode }
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
  }

  wss.on('connection', (socket: WebSocket) => {
    alive.set(socket, true)
    socket.on('pong', () => alive.set(socket, true))
    socket.on('error', () => {
      // message/close 事件足够路由；error 只兜底防进程崩溃
    })
    socket.on('close', () => rooms.handleDisconnect(socket as unknown as ServerSocket))
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, seq: null, type: 'welcome', protocol: PROTOCOL_VERSION }))

    socket.on('message', (data: RawData, isBinary: boolean) => {
      alive.set(socket, true)
      const failClosed = (code: ErrorFrame['code'], message: string, closeCode: number): void => {
        sendError(socket, code, message)
        socket.close(closeCode, code)
      }
      if (isBinary) {
        failClosed('PROTOCOL_ERROR', '不支持二进制帧（协议为每帧一条 JSON 文本）', CLOSE_PROTOCOL_ERROR)
        return
      }
      const text = rawDataToText(data)
      if (text.length > MAX_FRAME_BYTES) {
        failClosed('PROTOCOL_ERROR', '帧超过 1MB 上限', CLOSE_PROTOCOL_ERROR)
        return
      }
      const frame = parseClientFrame(text)
      if (!frame) {
        failClosed('PROTOCOL_ERROR', `无法解析的客户端帧：${text.slice(0, 120)}`, CLOSE_PROTOCOL_ERROR)
        return
      }
      if (frame.v !== PROTOCOL_VERSION) {
        failClosed('VERSION_MISMATCH', `客户端协议版本 ${frame.v}，服务端要求 ${PROTOCOL_VERSION}`, CLOSE_VERSION_MISMATCH)
        return
      }

      if (frame.kind === 'action') {
        const binding = rooms.bindingOf(socket as unknown as ServerSocket)
        if (!binding) {
          sendError(socket, 'NOT_IN_GAME', '尚未加入房间（对局上行仅限已就座连接的 {type:"action"}）')
          return
        }
        const session = binding.room.session
        if (!session) {
          sendError(socket, 'NOT_IN_GAME', '对局尚未开始')
          return
        }
        try {
          const violation = session.applyHumanAction(binding.seat, frame.action)
          if (violation) {
            sendError(socket, 'RULE_VIOLATION', violation.message, violation.ruleCode)
          }
        } catch (error) {
          if (error instanceof ProtocolFault) {
            sendError(socket, error.code, error.message)
            return
          }
          failClosed('PROTOCOL_ERROR', `动作结算异常：${String(error)}`, CLOSE_PROTOCOL_ERROR)
        }
        return
      }

      // —— 房间控制消息（另列，见 docs/protocol.md）——
      const op = frame.op
      try {
        switch (op.name) {
          case 'create':
            rooms.createRoom(socket as unknown as ServerSocket, { roomName: op.roomName, deck: op.deck, fillWithAi: op.fillWithAi })
            return
          case 'join':
            rooms.joinRoom(socket as unknown as ServerSocket, op.code, op.deck)
            return
          case 'start':
            rooms.startGame(socket as unknown as ServerSocket, op.seed)
            return
          case 'add_ai':
            rooms.addAi(socket as unknown as ServerSocket, op.difficulty, op.faction)
            return
          case 'resume':
            rooms.resumeRoom(socket as unknown as ServerSocket, op.code, op.token, op.lastSeq)
            return
          case 'leave':
            rooms.leave(socket as unknown as ServerSocket)
            return
          default: {
            const exhaustive: never = op
            throw new ProtocolFault('PROTOCOL_ERROR', `未支持的房间操作：${String((exhaustive as { name: string }).name)}`)
          }
        }
      } catch (error) {
        if (error instanceof ProtocolFault) {
          // 房间层上下文错误（未就座连接发错消息时还没有席位可回），直接对连接回
          const binding = rooms.bindingOf(socket as unknown as ServerSocket)
          if (binding) binding.room.sendError(binding.seat, error.code, error.message)
          else sendError(socket, error.code, error.message)
          return
        }
        failClosed('PROTOCOL_ERROR', `房间操作异常：${String(error)}`, CLOSE_PROTOCOL_ERROR)
      }
    })
  })

  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (alive.get(socket) === false) {
        socket.terminate()
        continue
      }
      alive.set(socket, false)
      socket.ping()
    }
  }, 15_000)

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(options.port ?? 0, host, () => {
      const address = httpServer.address() as AddressInfo
      const port = address.port
      boundPort = port
      resolve({
        host,
        port,
        rooms,
        discovery,
        content,
        listRooms: () => rooms.listRooms(),
        url: () => `ws://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
        close: () =>
          new Promise<void>((resolveClose) => {
            clearInterval(heartbeat)
            for (const socket of wss.clients) socket.terminate()
            wss.close(() => {
              httpServer.close(() => {
                rooms.destroyAll()
                discovery?.destroy()
                resolveClose()
              })
            })
          }),
      })
    })
  })
}
