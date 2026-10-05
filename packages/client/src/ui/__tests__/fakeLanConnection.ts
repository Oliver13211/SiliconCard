/**
 * 联机测试替身（M2-UI4）：FakeLanConnection 模拟 LanConnection 的公开面
 * （connect/onFrame/send/close/lastSeq），测试以「服务端视角」驱动 serverFrame /
 * accept / drop。经 lanStore 的连接工厂注入（as LanConnection 边界收敛在工厂处），
 * net 层真实代码（RoomApi / RemoteBattleDriver / LanClient）原样受测。
 */

import { PROTOCOL_VERSION, type ClientFrame, type ServerFrame } from '../../net'
import type { LanConnectionHandlers } from '../../net/connection'

export class FakeLanConnection {
  readonly url: string
  private readonly handlers: LanConnectionHandlers
  private readonly listeners = new Set<(frame: ServerFrame) => void>()
  private connectSettled: (() => void) | null = null
  private connectFailed: ((error: Error) => void) | null = null

  /** 客户端发出的帧（对局动作 + 房间控制） */
  readonly sent: ClientFrame[] = []
  connected = false
  private seqSeen: number | null = null

  constructor(url: string, handlers: LanConnectionHandlers = {}) {
    this.url = url
    this.handlers = handlers
  }

  get lastSeq(): number | null {
    return this.seqSeen
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.connectSettled = resolve
      this.connectFailed = reject
    })
  }

  /** 测试侧：服务端握手通过（welcome 版本校验通过） */
  accept(): void {
    this.connected = true
    this.connectSettled?.()
  }

  /** 测试侧：建连被拒（主机不可达等） */
  refuse(reason = 'connection refused'): void {
    const reject = this.connectFailed
    this.connected = false
    this.handlers.onClose?.({ code: 1006, reason })
    reject?.(new Error(`连接被拒绝：${reason}`))
  }

  onFrame(handler: (frame: ServerFrame) => void): () => void {
    this.listeners.add(handler)
    return () => {
      this.listeners.delete(handler)
    }
  }

  send(frame: ClientFrame): void {
    if (!this.connected) throw new Error('连接未就绪，无法发送')
    this.sent.push(frame)
  }

  close(): void {
    const wasConnected = this.connected
    this.connected = false
    // 真实 socket：客户端 close 也会触发 close 事件（closedByUser 抑制逻辑依赖它）
    if (wasConnected) this.handlers.onClose?.({ code: 1000, reason: 'client close' })
  }

  /** 测试侧：服务端下发一帧（seq 追踪与 LanConnection 同规则） */
  serverFrame(frame: ServerFrame): void {
    if (frame.seq !== null && (this.seqSeen === null || frame.seq > this.seqSeen)) {
      this.seqSeen = frame.seq
    }
    for (const listener of [...this.listeners]) listener(frame)
  }

  /** 测试侧：服务端异常断开 */
  drop(code = 1006): void {
    this.connected = false
    this.handlers.onClose?.({ code, reason: '' })
  }
}

export function welcome(): ServerFrame {
  return { v: PROTOCOL_VERSION, seq: null, type: 'welcome', protocol: PROTOCOL_VERSION }
}
