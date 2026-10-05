/**
 * M2-NET3 断线重连测试 —— seq 续传 + 重连后全量对齐一次 + 杀连接 30s 内恢复对局。
 * 场景：
 * A. 人机对局（AI 托管对面）：人类客户端被 terminate（模拟杀进程），AI 继续演进，
 *   按 lastSeq 重连 → resumed 回执 + 连续续传帧 + 全量对齐 sync，视图与服务端
 *   viewFor 逐字节一致，对局继续打到终局；断线到恢复 < 30s（验收硬指标）。
 * B. lastSeq=null → 不回放、仅全量对齐。
 * C. 无效 token → INVALID_TOKEN。
 * D. 双人局：对手断线 → 己方收到 seat_update（离线提示，M2-UI4 数据源）；
 *   己方回合不受影响；对手重连拿回席位并对局继续。
 * （引擎 FIRST_PLAYER='P1' 恒定，故回合序列可确定性编排。）
 */

import { describe, expect, it } from 'vitest'
import { canonicalJson } from '@siliconcard/core'
import { SimClient, pickAction, pickDeck, mulberry32 } from './sim/simClient'
import { startTestServer } from './testServer'
import type { ProtocolSeat } from './protocol'

function deckOf(id: string) {
  const picked = pickDeck(id).deck
  return { faction: picked.faction, cards: picked.cards }
}

/** 人类席位打 N 手后停；endTurn=true 时第 N 手强制交回合（引擎 P1 恒先手，可编排）。
 *  cursor 从 0 扫起：大厅 sync/回执的 legalActions 恒为空，只有真实己方回合帧会触发出招，
 *  因此先于 waitFor(started) 到达的对局 sync 也不会漏消费。 */
async function driveSeat(client: SimClient, seat: ProtocolSeat, moves: number, policySeed: number, endTurn = false): Promise<void> {
  const rng = mulberry32(policySeed)
  let cursor = 0
  let sent = 0
  for (;;) {
    if (cursor >= client.history().length) {
      await client.waitForHistoryLength(cursor, 20000, `${seat} 推进帧`)
      continue
    }
    const frame = client.history()[cursor]
    cursor += 1
    if (frame === undefined || (frame.type !== 'events' && frame.type !== 'sync')) continue
    const phase = frame.type === 'events' ? frame.view.phase : frame.snapshot.phase
    if (phase === 'ended' || sent >= moves) return
    const legal = frame.type === 'events' ? frame.legalActions : frame.snapshot.legalActions
    if (legal.length === 0) continue
    const lastMove = endTurn && sent === moves - 1
    const action = lastMove
      ? (legal.find((candidate) => candidate.type === 'END_TURN') ?? pickAction(legal, rng, false))
      : pickAction(legal, rng, false)
    client.send({ v: 1, type: 'action', action })
    sent += 1
  }
}

/** 轮到该席位时投降并等待终局（对随机中途交回合的场景保持确定性） */
async function concedeWhenTurn(client: SimClient, seat: ProtocolSeat): Promise<void> {
  for (;;) {
    if (client.history().length === 0) await client.waitForHistoryLength(0, 20000, `${seat} 首帧`)
    const scanFrom = 0
    for (let i = scanFrom; i < client.history().length; i++) {
      const frame = client.history()[i]
      if (frame === undefined || (frame.type !== 'events' && frame.type !== 'sync')) continue
      const legal = frame.type === 'events' ? frame.legalActions : frame.snapshot.legalActions
      if (legal.some((candidate) => candidate.type === 'CONCEDE')) {
        client.send({ v: 1, type: 'action', action: { type: 'CONCEDE', playerId: seat } })
        await client.waitFor((candidate) => candidate.type === 'events' && candidate.view.phase === 'ended', 30000, '终局')
        return
      }
    }
    await client.waitForHistoryLength(client.history().length, 20000, `${seat} 可投降时机`)
  }
}

function credentialsOf(client: SimClient): { token: string } {
  const created = client.history().find((frame) => frame.type === 'room' && frame.op.name === 'created')
  if (created && created.type === 'room' && created.op.name === 'created') return { token: created.op.token }
  const joined = client.history().find((frame) => frame.type === 'room' && frame.op.name === 'joined')
  if (joined && joined.type === 'room' && joined.op.name === 'joined') return { token: joined.op.token }
  throw new Error('凭据簿缺失（created/joined 回执均未收到）')
}

describe('M2-NET3 断线重连（seq 续传 + 全量对齐）', () => {
  it(
    'A: 杀客户端连接 → AI 继续演进 → lastSeq 重连恢复对局（< 30s）并打到终局',
    async () => {
      const server = await startTestServer({ disconnectGraceMs: 60_000 })
      try {
        // 建人机房：AI 托管 P2，杀 P1 连接
        const host = new SimClient()
        await host.connect(server.url())
        host.send({ v: 1, type: 'room', op: { name: 'create', roomName: '重连演练', deck: deckOf('nvidia-flagship-faith'), fillWithAi: true } })
        const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
        const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''
        host.send({ v: 1, type: 'room', op: { name: 'start', seed: 20261005 } })
        await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')

        // 先走一手并交回合（引擎 P1 恒先手 → AI 连锁回合真实演进），凭据定格
        await driveSeat(host, 'P1', 1, 101, true)
        const { token } = credentialsOf(host)
        const lastSeq = host.lastSeq
        expect(lastSeq).not.toBeNull()
        expect(lastSeq ?? 0).toBeGreaterThan(2) // 开局至少已有 created/sync/started/events 若干帧

        // —— 杀进程（terminate = 半开连接，等价于客户端凭空消失）——
        const killedAt = Date.now()
        host.terminate()

        // 稍候再重连（AI 若在回合中会继续演进、帧缓冲进席位日志）
        await new Promise((resolve) => setTimeout(resolve, 300))

        const resumed = new SimClient()
        await resumed.connect(server.url())
        resumed.send({ v: 1, type: 'room', op: { name: 'resume', code, token, lastSeq } })
        const ack = await resumed.waitFor((frame) => frame.type === 'room' && frame.op.name === 'resumed', 5000, 'resumed')
        const replayed = ack.type === 'room' && ack.op.name === 'resumed' ? ack.op.replayed : -1
        const recoverMs = Date.now() - killedAt
        expect(recoverMs).toBeLessThan(30_000) // 验收硬指标：30s 内恢复对局
        expect(replayed).toBeGreaterThanOrEqual(0)

        // 续传帧 seq 严格接续 lastSeq，无缺口无重复
        let expected = (lastSeq ?? 0) + 1
        for (const frame of resumed.history()) {
          if (frame.seq === null) continue
          expect(frame.seq).toBe(expected)
          expected += 1
        }
        // resumed 回执之后紧跟全量对齐 sync（其后可能还有 seat_update 广播帧）
        const ackIndex = resumed.history().indexOf(ack)
        const afterAck = resumed.history()[ackIndex + 1]
        expect(afterAck?.type).toBe('sync')
        const session = server.rooms.getByCode(code)?.session
        expect(session).not.toBeNull()
        const sessionRef = session!
        if (afterAck?.type === 'sync') {
          expect(canonicalJson(afterAck.snapshot.view)).toBe(canonicalJson(sessionRef.viewFor('P1')))
        }
        resumed.close()

        // —— 对局继续：轮到 P1 时投降收束（引擎 P1 恒先手，重连后必回到 P1 回合）——
        const again = new SimClient()
        await again.connect(server.url())
        again.send({ v: 1, type: 'room', op: { name: 'resume', code, token, lastSeq } })
        await again.waitFor((frame) => frame.type === 'sync', 5000, '再次重连对齐')
        await concedeWhenTurn(again, 'P1')
        const final = again.history()[again.history().length - 1]
        if (final?.type === 'events') {
          expect(final.view.winner).toBe('P2') // P1 投降 → AI 胜
          expect(final.view.phase).toBe('ended')
        }
        again.close()
      } finally {
        await server.close()
      }
    },
    60_000,
  )

  it('A2: seq 回放保真 —— 上报更旧的 lastSeq，缺口帧逐字节重放', async () => {
    const server = await startTestServer({ disconnectGraceMs: 60_000 })
    try {
      const host = new SimClient()
      await host.connect(server.url())
      host.send({ v: 1, type: 'room', op: { name: 'create', roomName: '回放保真', deck: deckOf('nvidia-flagship-faith'), fillWithAi: true } })
      const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''
      host.send({ v: 1, type: 'room', op: { name: 'start', seed: 20261006 } })
      await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')

      await driveSeat(host, 'P1', 1, 101, true)
      const { token } = credentialsOf(host)
      const lastSeq = host.lastSeq
      expect(lastSeq).not.toBeNull()
      host.terminate()
      await new Promise((resolve) => setTimeout(resolve, 200))

      const retrograde = (lastSeq ?? 2) - 2
      // 白盒对账基线：重连前席位日志末端（含断线时补记的 seat_update）
      const seatLastSeqBefore = server.rooms.getByCode(code)?.seat('P1')?.lastSeq ?? 0
      const replayClient = new SimClient()
      await replayClient.connect(server.url())
      replayClient.send({ v: 1, type: 'room', op: { name: 'resume', code, token, lastSeq: retrograde } })
      // 全新房间只此一次 resume：历史里第一条 resumed 回执即本次
      const ack2 = await replayClient.waitFor((frame) => frame.type === 'room' && frame.op.name === 'resumed', 5000, 'resumed(回放)')
      expect(ack2.type === 'room' && ack2.op.name === 'resumed' && ack2.op.replayed).toBe(seatLastSeqBefore - retrograde)
      for (const frame of replayClient.history()) {
        if (frame.seq === null || frame.seq > (lastSeq ?? 0)) continue
        const original = host.history().find((candidate) => candidate.seq === frame.seq)
        expect(original).toBeDefined()
        expect(canonicalJson(frame)).toBe(canonicalJson(original)) // 同 seq 帧逐字节一致
      }
      replayClient.close()
    } finally {
      await server.close()
    }
  })

  it('B: lastSeq=null → 仅全量对齐不回放；C: 无效 token → INVALID_TOKEN', async () => {
    const server = await startTestServer()
    try {
      const host = new SimClient()
      await host.connect(server.url())
      host.send({ v: 1, type: 'room', op: { name: 'create', roomName: '对齐演练', deck: deckOf('nvidia-flagship-faith') } })
      const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''
      const { token } = credentialsOf(host)
      host.terminate()

      // B: lastSeq null
      const fresh = new SimClient()
      await fresh.connect(server.url())
      fresh.send({ v: 1, type: 'room', op: { name: 'resume', code, token, lastSeq: null } })
      const ackB = await fresh.waitFor((frame) => frame.type === 'room' && frame.op.name === 'resumed', 5000, 'resumed(null)')
      expect(ackB.type === 'room' && ackB.op.name === 'resumed' && ackB.op.replayed).toBe(0)
      // resumed 回执之后紧跟一次全量对齐（其后可能还有 seat_update 等广播帧）
      const ackIndex = fresh.history().indexOf(ackB)
      const afterAck = fresh.history()[ackIndex + 1]
      expect(afterAck?.type).toBe('sync')
      fresh.close()

      // C: 伪造 token
      const stranger = new SimClient()
      await stranger.connect(server.url())
      stranger.send({ v: 1, type: 'room', op: { name: 'resume', code, token: 'forged-token', lastSeq: 1 } })
      const errorC = await stranger.waitFor((frame) => frame.type === 'error', 5000, 'INVALID_TOKEN')
      expect(errorC.type === 'error' && errorC.code).toBe('INVALID_TOKEN')
      stranger.close()
    } finally {
      await server.close()
    }
  })

  it(
    'D: 双人局对手断线 → 己方 seat_update 离线提示；对手重连恢复，对局继续',
    async () => {
      const server = await startTestServer()
      try {
        const host = new SimClient()
        await host.connect(server.url())
        host.send({ v: 1, type: 'room', op: { name: 'create', roomName: '双人重连', deck: deckOf('nvidia-flagship-faith') } })
        const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
        const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''

        const guest = new SimClient()
        await guest.connect(server.url())
        guest.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckOf('amd-war-future') } })
        await guest.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined')

        host.send({ v: 1, type: 'room', op: { name: 'start', seed: 777 } })
        await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')

        // 各打一手并交回合（P1 恒先手）：P1 → P2 → P1
        await driveSeat(host, 'P1', 1, 303, true)
        await driveSeat(guest, 'P2', 1, 304, true)
        await driveSeat(host, 'P1', 1, 305, true)

        // 对手断线：房主应收到 seat_update（connected=false）——联机 UI 重连提示的数据源
        const { token: guestToken } = credentialsOf(guest)
        const guestLastSeq = guest.lastSeq
        guest.terminate()
        await host.waitFor(
          (frame) =>
            frame.type === 'room' &&
            frame.op.name === 'seat_update' &&
            frame.op.seats.P2 !== null &&
            frame.op.seats.P2.connected === false,
          5000,
          'seat_update 离线',
        )

        // 对手重连：凭据续传拿回席位（此刻正轮 P2，游戏在等他）
        const back = new SimClient()
        await back.connect(server.url())
        back.send({ v: 1, type: 'room', op: { name: 'resume', code, token: guestToken, lastSeq: guestLastSeq } })
        const ack = await back.waitFor((frame) => frame.type === 'room' && frame.op.name === 'resumed', 5000, 'guest resumed')
        expect(ack.type === 'room' && ack.op.name === 'resumed' && ack.op.seat).toBe('P2')
        await back.waitFor((frame) => frame.type === 'sync', 5000, '重连对齐')
        // 房主看到对手回到线上
        await host.waitFor(
          (frame) =>
            frame.type === 'room' &&
            frame.op.name === 'seat_update' &&
            frame.op.seats.P2 !== null &&
            frame.op.seats.P2.connected === true,
          5000,
          'seat_update 回线',
        )

        // 重连方在其回合内投降收束（此刻正轮 P2，确定性）
        back.send({ v: 1, type: 'action', action: { type: 'CONCEDE', playerId: 'P2' } })
        const final = await host.waitFor((frame) => frame.type === 'events' && frame.view.phase === 'ended', 30000, '终局')
        if (final.type === 'events') expect(final.view.winner).toBe('P1')
        host.close()
        back.close()
      } finally {
        await server.close()
      }
    },
    60_000,
  )
})
