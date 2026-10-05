/**
 * 模拟对局客户端内核（M2-NET1 E2E 验收工具）——纯协议侧驱动：
 * 只消费服务端下发的 viewFor 视图与 legalActions，随机挑一个合法动作上行
 * { type: 'action' }，不含任何引擎逻辑（与真实网页客户端同构）。
 *
 * 确定性：--seed 驱动本客户端的动作选择 RNG（mulberry32），同 seed + 同对局
 * 输入 → 同样的动作序列；host/join 两个进程各自持有独立 RNG 游标。
 *
 * E2E 验收员用法（见 sim/host.ts 与 sim/join.ts）：
 *   yarn workspace @siliconcard/server start --port 49321
 *   yarn workspace @siliconcard/server sim:host --port 49321 --seed 42
 *   yarn workspace @siliconcard/server sim:join --port 49321 --code XXXXXX --seed 42
 * 断线重连演练：kill 掉任一 sim 进程后按其打印的 code/token/lastSeq 重连。
 */

import { WebSocket } from 'ws'
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_VERSION_MISMATCH,
  PROTOCOL_VERSION,
  type AiDifficulty,
  type ClientFrame,
  type DeckDto,
  type ProtocolErrorCode,
  type RoomResult,
  type SeatFrame,
  type ServerFrame,
} from '../protocol'
import { loadServerContent } from '../content'

/** 动作选择 RNG（mulberry32，与引擎实现无关——客户端只求可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface SimClientEvents {
  onLog?: (line: string) => void
}

/** 协议侧测试客户端：记录全部下行帧，支持 waitFor 与续传 lastSeq 追踪 */
export class SimClient {
  private socket: WebSocket | null = null
  private readonly frames: ServerFrame[] = []
  private readonly waiters: Array<{ predicate: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }> = []
  private readonly log: (line: string) => void

  constructor(events: SimClientEvents = {}) {
    this.log = events.onLog ?? (() => {})
  }

  get lastSeq(): number | null {
    let max: number | null = null
    for (const frame of this.frames) {
      if (frame.seq !== null && (max === null || frame.seq > max)) max = frame.seq
    }
    return max
  }

  history(): readonly ServerFrame[] {
    return this.frames
  }

  connect(url: string, timeoutMs = 5000): Promise<void> {
    return new Promise((resolveConnect, rejectConnect) => {
      const socket = new WebSocket(url)
      let settled = false
      const timeout = setTimeout(() => {
        socket.terminate()
        rejectConnect(new Error(`连接超时：${url}`))
      }, timeoutMs)
      const settleConnect = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) rejectConnect(error)
        else resolveConnect()
      }
      socket.on('open', () => {
        this.socket = socket
        // welcome 校验通过才算建连成功（协议版本不符直接拒绝）
        const welcomeTimer = setTimeout(() => {
          settleConnect(new Error('建连后未收到 welcome 帧'))
        }, timeoutMs)
        const onWelcome = (data: Buffer): void => {
          try {
            const frame = JSON.parse(data.toString('utf8')) as ServerFrame
            if (frame.type !== 'welcome') return
            clearTimeout(welcomeTimer)
            socket.off('message', onWelcome)
            if (frame.protocol !== PROTOCOL_VERSION) {
              settleConnect(new Error(`服务端协议版本 ${String(frame.protocol)}，本客户端要求 ${String(PROTOCOL_VERSION)}`))
              socket.close(CLOSE_VERSION_MISMATCH, 'version mismatch')
              return
            }
            settleConnect()
          } catch {
            // 非 JSON 首帧交给常驻 message 处理器报错
          }
        }
        socket.on('message', onWelcome)
      })
      socket.on('error', (error: Error) => {
        settleConnect(error)
      })
      socket.on('message', (data: Buffer) => {
        let frame: ServerFrame
        try {
          frame = JSON.parse(data.toString('utf8')) as ServerFrame
        } catch {
          this.log(`⚠ 无法解析的服务端帧：${data.toString('utf8').slice(0, 120)}`)
          return
        }
        this.frames.push(frame)
        if (frame.type === 'error') {
          this.log(`✗ 服务端错误帧：[${frame.code}] ${frame.message}${frame.ruleCode ? `（规则码 ${frame.ruleCode}）` : ''}`)
        }
        for (let i = 0; i < this.waiters.length; i++) {
          const waiter = this.waiters[i]
          if (waiter && waiter.predicate(frame)) {
            this.waiters.splice(i, 1)
            waiter.resolve(frame)
            break
          }
        }
      })
      socket.on('close', (code: number, reason: Buffer) => {
        if (this.socket === socket) this.socket = null
        if (code === CLOSE_PROTOCOL_ERROR || code === CLOSE_VERSION_MISMATCH) {
          this.log(`✗ 连接被服务端关闭（${code}）：${reason.toString('utf8')}`)
        }
      })
    })
  }

  send(frame: ClientFrame): void {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error('连接未建立，无法发送')
    }
    this.socket.send(JSON.stringify(frame))
  }

  waitFor(predicate: (frame: ServerFrame) => boolean, timeoutMs = 15000, label = '条件'): Promise<ServerFrame> {
    const existing = this.frames.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolveWait, rejectWait) => {
      const waiter = { predicate, resolve: resolveWait }
      this.waiters.push(waiter)
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) {
          this.waiters.splice(index, 1)
          rejectWait(new Error(`等待超时（${label}，${timeoutMs}ms）`))
        }
      }, timeoutMs)
    })
  }

  /** 等待历史里出现第 index 帧（cursor 推进用；不扫旧帧防忙轮询） */
  async waitForHistoryLength(length: number, timeoutMs = 30000, label = '新帧'): Promise<void> {
    if (this.frames.length > length) return
    await new Promise<void>((resolveWait, rejectWait) => {
      const waiter = { predicate: () => true, resolve: () => resolveWait() }
      this.waiters.push(waiter)
      setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) {
          this.waiters.splice(index, 1)
          rejectWait(new Error(`等待超时（${label}，${timeoutMs}ms）`))
        }
      }, timeoutMs)
    })
  }

  /** 单行日志（playUntilEnded 等流程函数复用实例的日志通道） */
  logLine(line: string): void {
    this.log(line)
  }

  close(): void {
    this.socket?.close(1000, 'sim done')
  }

  terminate(): void {
    this.socket?.terminate()
  }
}

// ——— 常用断言辅助 ———

export function expectWelcome(frame: ServerFrame | undefined): void {
  if (!frame || frame.type !== 'welcome' || frame.protocol !== PROTOCOL_VERSION) {
    throw new Error(`首帧不是 welcome 或协议版本不符：${JSON.stringify(frame)}`)
  }
}

export function isRoomResult(frame: ServerFrame, name: RoomResult['name']): frame is Extract<SeatFrame, { type: 'room' }> {
  return frame.type === 'room' && frame.op.name === name
}

export function roomResultOf(frame: Extract<SeatFrame, { type: 'room' }>): RoomResult {
  return frame.op
}

export interface ProtocolErrorSeen {
  code: ProtocolErrorCode
  message: string
}

export function errorsSeen(frames: readonly ServerFrame[]): ProtocolErrorSeen[] {
  return frames
    .filter((frame): frame is Extract<ServerFrame, { type: 'error' }> => frame.type === 'error')
    .map((frame) => ({ code: frame.code, message: frame.message }))
}

// ——— 对局驱动 ———

export interface DeckChoice {
  deck: DeckDto
  label: string
}

/** 从 content 预组卡组解析 DeckDto（--deck 传 id；缺省取第一套） */
export function pickDeck(deckId: string | undefined): DeckChoice {
  const content = loadServerContent()
  const deck = deckId === undefined ? content.decks[0] : content.decks.find((entry) => entry.id === deckId)
  if (!deck) {
    const known = content.decks.map((entry) => entry.id).join(' / ') || '（无）'
    throw new Error(`预组卡组「${String(deckId)}」不存在。可用：${known}`)
  }
  return {
    deck: { faction: deck.faction, cards: deck.cards.map((entry) => ({ ...entry })) },
    label: deck.id,
  }
}

export interface PlayOptions {
  client: SimClient
  seat: 'P1' | 'P2'
  seed: number
  /** 打完自己前 N 手后投降（限制对局长度；0 = 不主动投降） */
  concedeAfter?: number
  /** 收到的对局帧上限（防失控） */
  maxFrames?: number
}

export interface PlayResult {
  winner: 'P1' | 'P2' | null
  actionsSent: number
  framesSeen: number
}

/** 从下一帧开始等待对局推进并出招，直到对局结束（phase === 'ended'）。
 *  帧按 cursor 逐条消费（不重扫旧帧）。cursor 落位规则：
 *  - 重连场景（历史里已有重放帧）：定位「最后一条本席位 legalActions 非空」的帧
 *    ——服务端 AI 回合同步演进，该帧必然是当前待行动回合（或对手回合法，无害）；
 *  - 全新对局（历史里只有大厅帧）：cursor 从 0 起，等开局 sync 触发。 */
export async function playUntilEnded(options: PlayOptions): Promise<PlayResult> {
  const { client, seat, seed } = options
  const rng = mulberry32(seed)
  const maxFrames = options.maxFrames ?? 4000
  const history = client.history()
  let cursor = 0
  for (let i = history.length - 1; i >= 0; i--) {
    const frame = history[i]
    if (frame === undefined) continue
    const legal = frame.type === 'events' ? frame.legalActions : frame.type === 'sync' ? frame.snapshot.legalActions : []
    if (legal.length > 0) {
      cursor = i
      break
    }
  }
  let actionsSent = 0

  for (;;) {
    if (client.history().length - cursor > maxFrames) throw new Error(`对局帧数超过上限 ${maxFrames}，中止`)
    if (cursor >= client.history().length) {
      await client.waitForHistoryLength(cursor, 30000, '对局帧')
      continue
    }
    const frame = client.history()[cursor]
    cursor += 1
    if (!frame || (frame.type !== 'events' && frame.type !== 'sync' && frame.type !== 'room')) continue
    if (frame.type === 'room') continue
    if (frame.type === 'sync') {
      if (frame.snapshot.phase === 'ended') {
        return { winner: frame.snapshot.view?.winner ?? null, actionsSent, framesSeen: cursor }
      }
      if (frame.snapshot.legalActions.length === 0) continue
    } else {
      if (frame.view.phase === 'ended') {
        return { winner: frame.view.winner, actionsSent, framesSeen: cursor }
      }
      if (frame.legalActions.length === 0) continue // 对手的回合
    }
    const legalActions = frame.type === 'events' ? frame.legalActions : frame.snapshot.legalActions
    const action = pickAction(legalActions, rng, options.concedeAfter !== undefined && actionsSent >= options.concedeAfter)
    client.send({ v: PROTOCOL_VERSION, type: 'action', action })
    actionsSent += 1
    const label = action.type === 'PLAY_CARD' ? `PLAY_CARD ${String((action as { uid?: unknown }).uid)}` : action.type
    client.logLine(`  [${seat}] 第 ${actionsSent} 手：${label}`)
  }
}

export function describeDifficulty(difficulty: AiDifficulty): string {
  return { easy: '简单', normal: '普通', hard: '困难' }[difficulty]
}

/** 动作策略：可投降；否则 70% 概率在非 END_TURN 的合法动作里挑，其余交回合 */
export function pickAction(legalActions: readonly { type: string }[], rng: () => number, forceConcede: boolean): { type: string } {
  const list = legalActions as readonly Record<string, unknown>[]
  if (forceConcede) {
    const concede = list.find((action) => action['type'] === 'CONCEDE')
    if (concede) return concede as { type: string }
  }
  const aggressive = list.filter((action) => action['type'] !== 'END_TURN' && action['type'] !== 'CONCEDE')
  if (aggressive.length > 0 && rng() < 0.7) {
    return aggressive[Math.floor(rng() * aggressive.length)] as { type: string }
  }
  const endTurn = list.find((action) => action['type'] === 'END_TURN')
  if (endTurn) return endTurn as { type: string }
  return list[0] as { type: string }
}
