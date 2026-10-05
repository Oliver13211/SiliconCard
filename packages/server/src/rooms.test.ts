/**
 * M2-NET2 房间系统测试 —— 建房/加入/短房间码/满员/卡组校验/leave/HTTP 房间列表/
 * 房间数上限/断线宽限 GC。全部走真实 ws（127.0.0.1 随机端口）。
 */

import { describe, expect, it } from 'vitest'
import { SimClient, pickDeck } from './sim/simClient'
import { startTestServer } from './testServer'
import { ROOM_CODE_LENGTH } from './room'
import type { GameServer } from './server'

function deckOf(id: string) {
  const picked = pickDeck(id).deck
  return { faction: picked.faction, cards: picked.cards }
}

async function createRoom(server: GameServer, roomName = '测试房'): Promise<{ client: SimClient; code: string; token: string }> {
  const client = new SimClient()
  await client.connect(server.url())
  client.send({ v: 1, type: 'room', op: { name: 'create', roomName, deck: deckOf('nvidia-flagship-faith') } })
  const ack = await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
  const op = ack.type === 'room' && ack.op.name === 'created' ? ack.op : null
  if (!op) throw new Error('created 回执缺失')
  return { client, code: op.code, token: op.token }
}

describe('M2-NET2 房间生命周期', () => {
  it('建房/加入/房间码格式/回执席位', async () => {
    const server = await startTestServer()
    try {
      const { client, code, token } = await createRoom(server)
      expect(code).toMatch(new RegExp(`^[A-HJ-NP-Z2-9]{${ROOM_CODE_LENGTH}}$`)) // 短房间码（无易混淆字符）
      expect(token).not.toBe('')

      const guest = new SimClient()
      await guest.connect(server.url())
      guest.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckOf('amd-war-future') } })
      const joined = await guest.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined')
      expect(joined.type === 'room' && joined.op.name === 'joined' && joined.op.seat).toBe('P2')

      // 房主收到席位变化广播
      const update = await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'seat_update', 5000, 'seat_update')
      expect(update.type === 'room' && update.op.name === 'seat_update' && update.op.seats.P2?.kind).toBe('human')
      client.close()
      guest.close()
    } finally {
      await server.close()
    }
  })

  it('加入不存在房间 → ROOM_NOT_FOUND；满员再加入 → ROOM_FULL', async () => {
    const server = await startTestServer()
    try {
      const ghost = new SimClient()
      await ghost.connect(server.url())
      ghost.send({ v: 1, type: 'room', op: { name: 'join', code: 'ZZZZZZ', deck: deckOf('amd-war-future') } })
      const miss = await ghost.waitFor((frame) => frame.type === 'error', 5000, 'ROOM_NOT_FOUND')
      expect(miss.type === 'error' && miss.code).toBe('ROOM_NOT_FOUND')
      ghost.close()

      const { client, code } = await createRoom(server)
      const intruder = new SimClient()
      await intruder.connect(server.url())
      intruder.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckOf('amd-war-future') } })
      await intruder.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined')
      intruder.terminate()

      const third = new SimClient()
      await third.connect(server.url())
      third.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckOf('intel-driver-magic') } })
      const full = await third.waitFor((frame) => frame.type === 'error', 5000, 'ROOM_FULL')
      expect(full.type === 'error' && full.code).toBe('ROOM_FULL')
      third.close()
      client.close()
    } finally {
      await server.close()
    }
  })

  it('同一连接重复建房 → ALREADY_SEATED；未注册卡牌 → DECK_INVALID', async () => {
    const server = await startTestServer()
    try {
      const client = new SimClient()
      await client.connect(server.url())
      client.send({ v: 1, type: 'room', op: { name: 'create', roomName: 'a', deck: deckOf('nvidia-flagship-faith') } })
      await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      client.send({ v: 1, type: 'room', op: { name: 'create', roomName: 'b', deck: deckOf('nvidia-flagship-faith') } })
      const seated = await client.waitFor((frame) => frame.type === 'error', 5000, 'ALREADY_SEATED')
      expect(seated.type === 'error' && seated.code).toBe('ALREADY_SEATED')

      const stranger = new SimClient()
      await stranger.connect(server.url())
      stranger.send({
        v: 1,
        type: 'room',
        op: { name: 'create', roomName: 'c', deck: { faction: 'nvidia', cards: [{ cardId: 'no-such-card', count: 30 }] } },
      })
      const badDeck = await stranger.waitFor((frame) => frame.type === 'error', 5000, 'DECK_INVALID')
      expect(badDeck.type === 'error' && badDeck.code).toBe('DECK_INVALID')
      client.close()
      stranger.close()
    } finally {
      await server.close()
    }
  })

  it('HTTP /siliconcard/rooms 列表 + leave 退出', async () => {
    const server = await startTestServer()
    try {
      const { client, code } = await createRoom(server, 'HTTP 列表测试房')
      const response = await fetch(`http://127.0.0.1:${server.port}/siliconcard/rooms`)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { v: number; rooms: { code: string; name: string; openSeats: number }[] }
      expect(body.v).toBe(1)
      const entry = body.rooms.find((room) => room.code === code)
      expect(entry?.name).toBe('HTTP 列表测试房')
      expect(entry?.openSeats).toBe(1)

      client.send({ v: 1, type: 'room', op: { name: 'leave' } })
      await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'left', 5000, 'left')
      const after = await fetch(`http://127.0.0.1:${server.port}/siliconcard/rooms`)
      const afterBody = (await after.json()) as { rooms: { code: string }[] }
      // 宽限期内仍保留（可重连），但席位应显示离线
      expect(afterBody.rooms.some((room) => room.code === code)).toBe(true)
    } finally {
      await server.close()
    }
  })

  it('maxRooms 上限拒绝建房；dropRoom 主动销毁', async () => {
    const server = await startTestServer({ maxRooms: 2 })
    try {
      const first = await createRoom(server)
      const second = await createRoom(server)
      const third = new SimClient()
      await third.connect(server.url())
      third.send({ v: 1, type: 'room', op: { name: 'create', roomName: 'x', deck: deckOf('nvidia-flagship-faith') } })
      const limited = await third.waitFor((frame) => frame.type === 'error', 5000, 'ROOM_FULL')
      expect(limited.type === 'error' && limited.code).toBe('ROOM_FULL')
      third.close()

      expect(server.rooms.dropRoom(first.code)).toBe(true)
      expect(server.rooms.getByCode(first.code)).toBeUndefined()
      expect(server.rooms.dropRoom(first.code)).toBe(false)
      second.client.close()
      first.client.close()
    } finally {
      await server.close()
    }
  })

  it('断线宽限 GC：全部人类席位断开超宽限后销毁房间（sweep）', async () => {
    const server = await startTestServer({ disconnectGraceMs: 200 })
    try {
      const { client, code } = await createRoom(server)
      expect(server.rooms.getByCode(code)).toBeDefined()
      client.terminate()
      // 宽限期内：房间保留（可重连）
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(server.rooms.getByCode(code)).toBeDefined()
      // 超宽限后：sweep 销毁
      await new Promise((resolve) => setTimeout(resolve, 300))
      const destroyed = server.rooms.sweep()
      expect(destroyed.some((summary) => summary.code === code)).toBe(true)
      expect(server.rooms.getByCode(code)).toBeUndefined()
    } finally {
      await server.close()
    }
  })
})
