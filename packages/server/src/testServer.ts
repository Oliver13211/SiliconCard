/**
 * 测试基础设施 —— 测试用服务端启动 helper（端口 0 = 随机空闲端口，host 回环）。
 * 模拟客户端复用 src/sim/simClient.ts 的 SimClient（E2E 验收员用同一套客户端脚本）。
 */

import { createGameServer, type GameServer, type GameServerOptions } from './server'
import { PROTOCOL_VERSION, type RoomResult, type SeatFrame, type ServerFrame } from './protocol'
import type { ProtocolSeat } from './protocol'

export async function startTestServer(options: Partial<GameServerOptions> = {}): Promise<GameServer> {
  return createGameServer({
    port: 0,
    host: '127.0.0.1',
    ...options,
  })
}

/** 从席位帧流里取首条指定名字的房间回执（断言失败给可读错误） */
export function roomAck(frames: readonly ServerFrame[], name: RoomResult['name']): Extract<RoomResult, { name: typeof name }> {
  const found = frames.find((frame) => frame.type === 'room' && frame.op.name === name)
  if (!found || found.type !== 'room') {
    throw new Error(`未找到房间回执 ${name}；已有帧类型：${frames.map((frame) => frame.type).join(',')}`)
  }
  return found.op as Extract<RoomResult, { name: typeof name }>
}

/** 校验席位 seq 从 1 起连续递增（每席位一条独立计数） */
export function assertSeqContiguous(frames: readonly ServerFrame[], seat: ProtocolSeat): number {
  let expected = 1
  for (const frame of frames) {
    if (frame.seq === null) continue
    if (frame.seq !== expected) {
      throw new Error(`席位 ${seat} seq 不连续：期望 ${String(expected)}，实际 ${String(frame.seq)}`)
    }
    expected += 1
  }
  return expected - 1
}

/** 提取席位帧流中的 sync/events 帧（房间回执与连接级帧不参与状态对账） */
export function gameFrames(frames: readonly ServerFrame[]): Extract<SeatFrame, { type: 'sync' | 'events' }>[] {
  return frames.filter((frame): frame is Extract<SeatFrame, { type: 'sync' | 'events' }> => frame.type === 'sync' || frame.type === 'events')
}

export const PROTOCOL = PROTOCOL_VERSION
