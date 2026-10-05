/**
 * LanConnection —— 浏览器侧 ws 连接管理（M2-NET1，原生 WebSocket 零依赖）。
 *
 * 职责：建连/断开、帧收发（每帧一条 JSON 文本）、lastSeq 追踪（重连续传凭据）、
 * welcome 协议版本校验。对局上行只经 send({type:'action'})——协议硬约束。
 * 帧订阅支持多路（RoomApi 与 RemoteBattleDriver 各挂一套）。
 */

import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from './protocol'

export interface LanConnectionHandlers {
  /** 连接就绪（welcome 校验通过后） */
  onReady?: () => void
  /** 连接关闭（联机 UI 据此提示重连，M2-UI4） */
  onClose?: (info: { code: number; reason: string }) => void
  /** 协议层异常（版本不符 / 帧不可解析） */
  onProtocolError?: (message: string) => void
}

export class LanConnection {
  private socket: WebSocket | null = null
  private lastSeqSeen: number | null = null
  private ready = false
  private readonly frameHandlers = new Set<(frame: ServerFrame) => void>()

  constructor(
    private readonly url: string,
    private readonly handlers: LanConnectionHandlers = {},
  ) {}

  get lastSeq(): number | null {
    return this.lastSeqSeen
  }

  get connected(): boolean {
    return this.ready && this.socket !== null && this.socket.readyState === WebSocket.OPEN
  }

  /** 订阅服务端帧（多路；返回退订函数） */
  onFrame(handler: (frame: ServerFrame) => void): () => void {
    this.frameHandlers.add(handler)
    return () => {
      this.frameHandlers.delete(handler)
    }
  }

  /** 建连并等待 welcome；协议版本不符立即断开并 reject */
  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(this.url)
      const timeout = setTimeout(() => {
        socket.close()
        rejectConnect(new Error(`连接超时：${this.url}`))
      }, timeoutMs)

      socket.addEventListener('open', () => {
        this.socket = socket
      })
      socket.addEventListener('message', (event: MessageEvent) => {
        let frame: ServerFrame
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame
        } catch {
          this.handlers.onProtocolError?.('服务端帧不可解析（协议破坏）')
          return
        }
        if (frame.type === 'welcome') {
          clearTimeout(timeout)
          if (frame.protocol !== PROTOCOL_VERSION) {
            const message = `服务端协议版本 ${String(frame.protocol)}，客户端要求 ${String(PROTOCOL_VERSION)}，请刷新页面`
            this.handlers.onProtocolError?.(message)
            socket.close()
            rejectConnect(new Error(message))
            return
          }
          this.ready = true
          this.handlers.onReady?.()
          resolveConnect()
          return
        }
        if (frame.seq !== null && (this.lastSeqSeen === null || frame.seq > this.lastSeqSeen)) {
          this.lastSeqSeen = frame.seq
        }
        for (const handler of this.frameHandlers) handler(frame)
      })
      socket.addEventListener('close', (event: CloseEvent) => {
        clearTimeout(timeout)
        const wasReady = this.ready
        this.ready = false
        if (this.socket === socket) this.socket = null
        this.handlers.onClose?.({ code: event.code, reason: event.reason })
        if (!wasReady) {
          rejectConnect(new Error(`连接被拒绝：${event.reason || `code ${String(event.code)}`}`))
        }
      })
      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        rejectConnect(new Error(`无法连接 ${this.url}（mDNS 不可用时请手动输入 IP:port）`))
      })
    })
  }

  /** 上行一帧（对局动作 = { v, type:'action', action }，房间控制 = { v, type:'room', op }） */
  send(frame: ClientFrame): void {
    if (!this.connected || this.socket === null) {
      throw new Error('连接未就绪，无法发送')
    }
    this.socket.send(JSON.stringify(frame))
  }

  close(): void {
    this.ready = false
    this.socket?.close(1000, 'client close')
    this.socket = null
  }
}

/** ws 地址 → http 地址（同 host:port 的房间列表接口用） */
export function httpRoomsUrl(wsUrl: string): string {
  return wsUrl.replace(/^ws/, 'http').replace(/\/$/, '') + '/siliconcard/rooms'
}
