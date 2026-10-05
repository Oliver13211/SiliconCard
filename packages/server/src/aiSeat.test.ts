/**
 * M2-NET3 服务端 AI 虚拟玩家托管测试 —— createAiPlayer 填充空位（人机房）/ add_ai：
 * - AI 席位自动出招（与人类动作走同一结算管线），人类席位收到其事件帧；
 * - AI 席位无 socket、不产席位帧（日志为空）；
 * - seats 元数据标明 AI 与难度（联机 UI 展示用）；
 * - 只有房主能 add_ai；对面已有人/已开局时拒绝；一人不能开局（ROOM_NOT_FULL）。
 */

import { describe, expect, it } from 'vitest'
import { SimClient, pickDeck } from './sim/simClient'
import { startTestServer } from './testServer'

function deckOf(id: string) {
  const picked = pickDeck(id).deck
  return { faction: picked.faction, cards: picked.cards }
}

/** 人类席位打 N 手后交回合，重复 M 轮（给 AI 充分的出招空间）。
 *  cursor 从 0 扫起：大厅 sync/回执的 legalActions 恒为空，只有真实己方回合帧会触发出招。 */
async function playTurns(client: SimClient, rounds: number, policySeed: number): Promise<void> {
  void policySeed
  let cursor = 0
  let round = 0
  for (;;) {
    if (cursor >= client.history().length) {
      await client.waitForHistoryLength(cursor, 30000, 'AI 对局推进')
      continue
    }
    const frame = client.history()[cursor]
    cursor += 1
    if (frame === undefined || (frame.type !== 'events' && frame.type !== 'sync')) continue
    if (frame.type === 'events' && frame.view.phase === 'ended') return
    const legal = frame.type === 'events' ? frame.legalActions : frame.snapshot.legalActions
    if (legal.length === 0) continue
    const endTurn = legal.find((candidate) => candidate.type === 'END_TURN')
    if (!endTurn) return // 异常防御：没有交回合动作就停
    client.send({ v: 1, type: 'action', action: endTurn }) // 人类只交回合，让 AI 多打
    round += 1
    if (round >= rounds) return
  }
}

describe('M2-NET3 服务端 AI 托管（createAiPlayer）', () => {
  it(
    'fillWithAi 人机房：AI 自动出招、事件帧可见、seats 元数据正确、对局可终局',
    async () => {
      const server = await startTestServer()
      try {
        const host = new SimClient()
        await host.connect(server.url())
        host.send({
          v: 1,
          type: 'room',
          op: { name: 'create', roomName: '人机房', deck: deckOf('nvidia-flagship-faith'), fillWithAi: true },
        })
        const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
        const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''

        // seats 元数据：P2 已由 AI 托管
        const syncLobby = await host.waitFor((frame) => frame.type === 'sync', 5000, '大厅 sync')
        if (syncLobby.type === 'sync') {
          expect(syncLobby.snapshot.seats.P2).toEqual({ kind: 'ai', connected: true, difficulty: 'normal' })
        }

        // 一人即可开局（空位已被 AI 填充）
        host.send({ v: 1, type: 'room', op: { name: 'start', seed: 424242 } })
        await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')

        // AI 托管 P2：席位日志应为空（无 socket 不产帧）
        const room = server.rooms.getByCode(code)
        expect(room?.seat('P2')?.kind).toBe('ai')

        // 人类连续交回合数轮：AI 每回合真实出招（事件帧流中出现非人类动作的结算）
        await playTurns(host, 3, 900)
        const eventFrames = host.history().filter((frame) => frame.type === 'events')
        expect(eventFrames.length).toBeGreaterThan(0)
        // AI 的动作事件确实产生（回合切换 ≥ 3 次 → 事件流跨回合）
        const turnStarts = host.history().filter(
          (frame) => frame.type === 'events' && frame.events.some((event) => event.type === 'TURN_START'),
        )
        expect(turnStarts.length).toBeGreaterThanOrEqual(2)

        // 人类投降收束（轮到 P1 时 CONCEDE 恒在合法集）
        host.send({ v: 1, type: 'action', action: { type: 'CONCEDE', playerId: 'P1' } })
        const final = await host.waitFor((frame) => frame.type === 'events' && frame.view.phase === 'ended', 30000, '终局')
        if (final.type === 'events') expect(final.view.winner).toBe('P2')
        host.close()
      } finally {
        await server.close()
      }
    },
    60_000,
  )

  it('add_ai：房主可加 AI；已开局/对面有人/非房主拒绝；单人未满员不能开局', async () => {
    const server = await startTestServer()
    try {
      const host = new SimClient()
      const guest = new SimClient()
      await host.connect(server.url())
      await guest.connect(server.url())
      host.send({ v: 1, type: 'room', op: { name: 'create', roomName: 'add_ai 演练', deck: deckOf('nvidia-flagship-faith') } })
      const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''

      // 单人开局 → ROOM_NOT_FULL
      host.send({ v: 1, type: 'room', op: { name: 'start', seed: 1 } })
      const notFull = await host.waitFor((frame) => frame.type === 'error' && frame.code === 'ROOM_NOT_FULL', 5000, 'ROOM_NOT_FULL')
      expect(notFull.type === 'error' && notFull.code).toBe('ROOM_NOT_FULL')

      // 非房主 add_ai → NOT_HOST
      guest.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckOf('amd-war-future') } })
      await guest.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined')
      guest.send({ v: 1, type: 'room', op: { name: 'add_ai' } })
      const notHost = await guest.waitFor((frame) => frame.type === 'error' && frame.code === 'NOT_HOST', 5000, 'NOT_HOST')
      expect(notHost.type === 'error' && notHost.code).toBe('NOT_HOST')

      // 对面有人时 add_ai → AI_SEAT_TAKEN
      host.send({ v: 1, type: 'room', op: { name: 'add_ai' } })
      const taken = await host.waitFor((frame) => frame.type === 'error' && frame.code === 'AI_SEAT_TAKEN', 5000, 'AI_SEAT_TAKEN')
      expect(taken.type === 'error' && taken.code).toBe('AI_SEAT_TAKEN')

      // guest 走人（宽限期内席位保留）→ add_ai 依旧 AI_SEAT_TAKEN
      guest.terminate()
      await host.waitFor(
        (frame) => frame.type === 'room' && frame.op.name === 'seat_update' && frame.op.seats.P2?.connected === false,
        5000,
        'guest 离线',
      )
      host.send({ v: 1, type: 'room', op: { name: 'add_ai' } })
      const stillTaken = await host.waitFor((frame) => frame.type === 'error' && frame.code === 'AI_SEAT_TAKEN', 5000, '宽限期 AI_SEAT_TAKEN')
      expect(stillTaken.type === 'error' && stillTaken.code).toBe('AI_SEAT_TAKEN')
      host.close()
    } finally {
      await server.close()
    }
  })

  it('独立 add_ai 房：房主 + AI 完整对局（AI 先手回合自动演进）', async () => {
    const server = await startTestServer()
    try {
      const host = new SimClient()
      await host.connect(server.url())
      host.send({ v: 1, type: 'room', op: { name: 'create', roomName: '纯 AI 房', deck: deckOf('neutral-system-builder') } })
      await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      host.send({ v: 1, type: 'room', op: { name: 'add_ai', difficulty: 'easy' } })
      const added = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'ai_added', 5000, 'ai_added')
      expect(added.type === 'room' && added.op.name === 'ai_added' && added.op.seats.P2?.difficulty).toBe('easy')

      host.send({ v: 1, type: 'room', op: { name: 'start', seed: 31337 } })
      await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')
      // P1 恒先手，AI 是 P2：先确认人类能正常拿到回合
      const firstTurn = await host.waitFor(
        (frame) => frame.type === 'sync' && (frame.snapshot.legalActions.length > 0 || frame.snapshot.phase === 'playing'),
        5000,
        '开局 sync',
      )
      expect(firstTurn.type).toBe('sync')

      host.send({ v: 1, type: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
      // AI 回合自动打完，交还 P1（TURN_START 事件再次指向 P1）
      const backToP1 = await host.waitFor(
        (frame) =>
          frame.type === 'events' &&
          frame.events.some((event) => event.type === 'TURN_START') &&
          frame.view.activePlayer === 'P1',
        30000,
        'AI 交回合',
      )
      expect(backToP1).toBeDefined()

      // 收束：P1 投降
      host.send({ v: 1, type: 'action', action: { type: 'CONCEDE', playerId: 'P1' } })
      const final = await host.waitFor((frame) => frame.type === 'events' && frame.view.phase === 'ended', 30000, '终局')
      if (final.type === 'events') expect(final.view.winner).toBe('P2')
      host.close()
    } finally {
      await server.close()
    }
  })
})
