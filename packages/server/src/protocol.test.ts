/**
 * 协议校验测试 —— 闸门行为（M2-NET1 安全姿态）：
 * - 垃圾帧 / 二进制帧 / 协议版本不符 → error 帧 + 断开（4002/4003）；
 * - 未就座连接上行 action → NOT_IN_GAME（不断开）；
 * - 他人席位 playerId → WRONG_SEAT；
 * - 引擎非法动作 → RULE_VIOLATION（带 ruleCode），且服务端状态哈希不变；
 * - 开局前 action → NOT_IN_GAME。
 * 另含 parseClientFrame 的纯函数单测（形状闸门）。
 */

import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { CLOSE_PROTOCOL_ERROR, CLOSE_VERSION_MISMATCH, parseClientFrame } from './protocol'
import { SimClient, pickDeck } from './sim/simClient'
import { startTestServer } from './testServer'
import type { GameServer } from './server'
import type { ServerFrame } from './protocol'

function deckOf(id: string) {
  const picked = pickDeck(id).deck
  return { faction: picked.faction, cards: picked.cards }
}

async function createSeated(server: GameServer): Promise<{ client: SimClient; code: string }> {
  const client = new SimClient()
  await client.connect(server.url())
  client.send({ v: 1, type: 'room', op: { name: 'create', roomName: '协议校验', deck: deckOf('nvidia-flagship-faith') } })
  const ack = await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
  const code = ack.type === 'room' && ack.op.name === 'created' ? ack.op.code : ''
  if (!code) throw new Error('created 缺失')
  return { client, code }
}

describe('parseClientFrame（形状闸门）', () => {
  it('合法帧放行；垃圾输入一律拒绝', () => {
    expect(parseClientFrame('not json')).toBeNull()
    expect(parseClientFrame('"just a string"')).toBeNull()
    expect(parseClientFrame('[]')).toBeNull()
    expect(parseClientFrame('{}')).toBeNull()
    expect(parseClientFrame('{"v":1}')).toBeNull()
    expect(parseClientFrame('{"v":1,"type":"unknown"}')).toBeNull()
    expect(parseClientFrame('{"v":1,"type":"action"}')).toBeNull() // 缺 action
    expect(parseClientFrame('{"v":1,"type":"action","action":{"type":123}}')).toBeNull()
    expect(parseClientFrame('{"v":1,"type":"room","op":{"name":"create","deck":{"faction":"nvidia","cards":[]}}}')).toBeNull() // 空 cards
    expect(parseClientFrame('{"v":1,"type":"room","op":{"name":"join","code":"X","deck":{"faction":"nvidia","cards":[{"cardId":"c","count":0}]}}}')).toBeNull() // count ≤ 0
    expect(parseClientFrame('{"v":1,"type":"room","op":{"name":"resume","code":"X"}}')).toBeNull() // 缺 token

    const action = parseClientFrame('{"v":1,"type":"action","action":{"type":"END_TURN","playerId":"P1"}}')
    expect(action).toEqual({ v: 1, kind: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
    const leave = parseClientFrame('{"v":1,"type":"room","op":{"name":"leave"}}')
    expect(leave?.kind).toBe('room')
  })
})

describe('ws 闸门（真实 socket）', () => {
  it('垃圾帧 → error + 关闭 4002；版本不符 → 关闭 4003', async () => {
    const server = await startTestServer()
    try {
      const garbage = await new Promise<{ frames: ServerFrame[]; closeCode: number }>((resolve) => {
        const socket = new WebSocket(server.url())
        const frames: ServerFrame[] = []
        socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as ServerFrame))
        socket.on('close', (code: number) => resolve({ frames, closeCode: code }))
        socket.on('open', () => socket.send('这不是 JSON'))
      })
      expect(garbage.frames.some((frame) => frame.type === 'error' && frame.code === 'PROTOCOL_ERROR')).toBe(true)
      expect(garbage.closeCode).toBe(CLOSE_PROTOCOL_ERROR)

      const stale = await new Promise<{ frames: ServerFrame[]; closeCode: number }>((resolve) => {
        const socket = new WebSocket(server.url())
        const frames: ServerFrame[] = []
        socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString('utf8')) as ServerFrame))
        socket.on('close', (code: number) => resolve({ frames, closeCode: code }))
        socket.on('open', () => socket.send(JSON.stringify({ v: 0, type: 'room', op: { name: 'leave' } })))
      })
      expect(stale.frames.some((frame) => frame.type === 'error' && frame.code === 'VERSION_MISMATCH')).toBe(true)
      expect(stale.closeCode).toBe(CLOSE_VERSION_MISMATCH)
    } finally {
      await server.close()
    }
  })

  it('未就座上行 action → NOT_IN_GAME（连接保留）', async () => {
    const server = await startTestServer()
    try {
      const client = new SimClient()
      await client.connect(server.url())
      client.send({ v: 1, type: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
      const error = await client.waitFor((frame) => frame.type === 'error', 5000, 'NOT_IN_GAME')
      expect(error.type === 'error' && error.code).toBe('NOT_IN_GAME')
      // 连接未被关闭：房间控制消息仍可正常处理
      client.send({ v: 1, type: 'room', op: { name: 'create', roomName: '还能用', deck: deckOf('nvidia-flagship-faith') } })
      await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      client.close()
    } finally {
      await server.close()
    }
  })

  it('开局前 action → NOT_IN_GAME；开局后他人席位 → WRONG_SEAT；非法动作 → RULE_VIOLATION 且状态不变', async () => {
    const server = await startTestServer()
    try {
      const { client, code } = await createSeated(server)
      // 开局前
      client.send({ v: 1, type: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
      const early = await client.waitFor((frame) => frame.type === 'error', 5000, 'NOT_IN_GAME(lobby)')
      expect(early.type === 'error' && early.code).toBe('NOT_IN_GAME')

      // 开局（人机房，避免时序耦合：AI 托管对面）
      client.send({ v: 1, type: 'room', op: { name: 'add_ai', difficulty: 'normal' } })
      await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'ai_added', 5000, 'ai_added')
      client.send({ v: 1, type: 'room', op: { name: 'start', seed: 20261005 } })
      await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')

      const session = server.rooms.getByCode(code)?.session
      expect(session).not.toBeNull()
      const sessionRef = session!
      const hashBefore = sessionRef.stateHash

      // 他人席位（P2 名义 + P2 不在线；playerId 冒用）
      client.send({ v: 1, type: 'action', action: { type: 'END_TURN', playerId: 'P2' } })
      const wrongSeat = await client.waitFor((frame) => frame.type === 'error' && frame.code === 'WRONG_SEAT', 5000, 'WRONG_SEAT')
      expect(wrongSeat.type === 'error' && wrongSeat.code).toBe('WRONG_SEAT')
      expect(sessionRef.stateHash).toBe(hashBefore) // 非法上行不改变状态

      // 引擎非法动作（当前回合盲发 PLAY_CARD 不存在的手牌）
      client.send({ v: 1, type: 'action', action: { type: 'PLAY_CARD', playerId: 'P1', uid: 'h-nope' } })
      const rule = await client.waitFor((frame) => frame.type === 'error' && frame.code === 'RULE_VIOLATION', 5000, 'RULE_VIOLATION')
      expect(rule.type === 'error' && rule.code).toBe('RULE_VIOLATION')
      expect(rule.type === 'error' && typeof rule.ruleCode === 'string' && rule.ruleCode.length > 0).toBe(true)
      expect(sessionRef.stateHash).toBe(hashBefore) // 引擎拒绝 → 状态不动

      // 交回合（若当前恰为 AI 回合则被引擎拒绝，无碍）→ AI 托管开始出招产生事件帧
      client.send({ v: 1, type: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
      await client.waitFor((frame) => frame.type === 'events', 20000, 'AI 事件帧')
      client.close()
    } finally {
      await server.close()
    }
  })
})
