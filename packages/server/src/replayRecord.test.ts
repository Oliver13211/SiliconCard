/**
 * P2-α 局域网对局回放录制测试 —— 服务端完赛录制 + replay_fetch/replay_data 协议回环。
 *
 * 口径与 drift100 同源：双 SimClient 走真实 ws 对跑，onActionApplied hook 收集
 * 服务端权威动作序列；录制体在独立引擎上重放（runReplay）必须零漂移复现终局
 * 状态哈希——录制即黄金回放， serve 端录什么客户端就能重放什么。
 *
 * 覆盖：
 * A. 双人局：录制内容正确性（seed/双方卡组/逐动作 = hook 权威序列）、镜像重放
 *    零漂移、GAME_END 元数据（winner/reason/turns/endedAt）、viewer 按请求席位填、
 *    source='lan'、replay_data 走席位日志（seq 连续）；
 * B. AI 托管局：AI 席动作入列且顺序正确（镜像重放对账）；
 * C. 无完赛：大厅/对局进行中 replay_data.match === null；
 * D. 协议回环：parseClientFrame 接受 replay_fetch；未就座连接被拒；
 * E. 重连续传：replay_data 在席位日志中可随 resume 回放。
 */

import { describe, expect, it } from 'vitest'
import { canonicalJson, createEngine, runReplay, type Action, type GameEvent, type PlayerSetup } from '@siliconcard/core'
import { parseClientFrame, type ReplayMatchPayload } from './protocol'
import { mulberry32, pickAction, pickDeck, playUntilEnded, SimClient } from './sim/simClient'
import { assertSeqContiguous, startTestServer } from './testServer'
import type { GameServer } from './server'

const SEED = 20261114
const MAX_GUARD = 8000

function deckOf(id: string) {
  const picked = pickDeck(id).deck
  return { faction: picked.faction, cards: picked.cards }
}

/** 权威动作簿：onActionApplied hook 按房间收集（含 AI 席动作） */
function collectActions(): { hook: (info: { roomCode: string; action: Action }) => void; book: Map<string, Action[]> } {
  const book = new Map<string, Action[]>()
  return {
    hook: (info) => {
      const list = book.get(info.roomCode) ?? []
      list.push(info.action)
      book.set(info.roomCode, list)
    },
    book,
  }
}

function replayDataOf(client: SimClient, label: string): ReplayMatchPayload | null {
  for (const candidate of client.history()) {
    if (candidate.type === 'room' && candidate.op.name === 'replay_data') return candidate.op.match
  }
  throw new Error(`未收到 replay_data（${label}）`)
}

async function fetchReplay(client: SimClient, seat: string): Promise<ReplayMatchPayload | null> {
  const before = client.history().length
  client.send({ v: 1, type: 'room', op: { name: 'replay_fetch' } })
  await client.waitForHistoryLength(before, 5000, `${seat} replay_data`)
  return replayDataOf(client, seat)
}

/** 双人局对跑到终局（与 drift100 同款 drive：只消费服务端 legalActions） */
async function driveBothToEnd(p1: SimClient, p2: SimClient, policySeedA: number, policySeedB: number): Promise<void> {
  const drive = async (client: SimClient, seat: 'P1' | 'P2', policySeed: number): Promise<void> => {
    const rng = mulberry32(policySeed)
    let cursor = 0
    let guard = 0
    for (;;) {
      if (++guard > MAX_GUARD) throw new Error(`席位 ${seat} 帧数失控`)
      if (cursor >= client.history().length) {
        await client.waitForHistoryLength(cursor, 30000, `${seat} 对局帧`)
        continue
      }
      const frame = client.history()[cursor]
      cursor += 1
      if (frame === undefined || (frame.type !== 'events' && frame.type !== 'sync')) continue
      const phase = frame.type === 'events' ? frame.view.phase : frame.snapshot.phase
      if (phase === 'ended') return
      const legal = frame.type === 'events' ? frame.legalActions : frame.snapshot.legalActions
      if (legal.length === 0) continue
      client.send({ v: 1, type: 'action', action: pickAction(legal, rng, false) })
    }
  }
  await Promise.all([drive(p1, 'P1', policySeedA), drive(p2, 'P2', policySeedB)])
}

/** 断言录制体与权威序列/镜像引擎逐动作零漂移 + GAME_END 元数据自洽 */
function assertRecordingSound(match: ReplayMatchPayload, actions: readonly Action[], server: GameServer, code: string): void {
  // 1. 录制体 = 服务端权威动作序列（逐动作同口径，drift100 hook 收集）
  expect(canonicalJson(match.recording.actions)).toBe(canonicalJson(actions))

  // 2. 独立引擎重放零漂移：录制体必须复现服务端权威终局
  const mirror = runReplay(createEngine(), match.recording)
  const session = server.rooms.getByCode(code)?.session
  expect(session).not.toBeNull()
  expect(mirror.stateHash).toBe(session!.stateHash)
  expect(mirror.finalState.phase).toBe('ended')
  expect(mirror.finalState.turn).toBe(session!.stateSnapshot.turn)

  // 3. GAME_END 元数据与镜像终局自洽
  const endEvent = mirror.events.at(-1) as Extract<GameEvent, { type: 'GAME_END' }> | undefined
  expect(endEvent?.type).toBe('GAME_END')
  expect(match.winner).toBe(endEvent?.winner ?? null)
  expect(match.winner).toBe(session!.stateSnapshot.winner)
  expect(match.reason).toBe(endEvent?.reason ?? null)
  expect(['health_zero', 'concede']).toContain(match.reason)
  expect(match.turns).toBe(mirror.finalState.turn)

  // 4. 时间元数据：startedAt（本局开始时刻）≤ endedAt ≤ 当前
  expect(match.startedAt).toBeGreaterThan(0)
  expect(match.endedAt).toBeGreaterThanOrEqual(match.startedAt)
  expect(match.endedAt).toBeLessThanOrEqual(Date.now())
  expect(match.source).toBe('lan')
}

describe('P2-α 局域网对局回放录制', () => {
  it('A: 双人局——录制逐动作与权威序列/镜像重放零漂移，viewer 按请求席位填，seq 连续', async () => {
    const { hook, book } = collectActions()
    const server = await startTestServer({ onActionApplied: hook })
    try {
      const p1 = new SimClient()
      const p2 = new SimClient()
      await p1.connect(server.url())
      await p2.connect(server.url())
      const deckA = deckOf('nvidia-flagship-faith')
      const deckB = deckOf('amd-war-future')
      p1.send({ v: 1, type: 'room', op: { name: 'create', roomName: '回放录制A', deck: deckA } })
      const created = await p1.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''
      p2.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckB } })
      await p2.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined')
      p1.send({ v: 1, type: 'room', op: { name: 'start', seed: SEED } })
      await p1.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')
      await driveBothToEnd(p1, p2, 0x5eed11, 0x5eed22)
      expect(book.get(code)?.length ?? 0).toBeGreaterThan(0)

      const matchP1 = await fetchReplay(p1, 'P1')
      const matchP2 = await fetchReplay(p2, 'P2')
      expect(matchP1).not.toBeNull()
      expect(matchP2).not.toBeNull()
      const match1 = matchP1 as ReplayMatchPayload
      const match2 = matchP2 as ReplayMatchPayload

      // viewer 语义：按请求席位填（双端各存一份本视角录制，胜负归属参照）
      expect(match1.viewer).toBe('P1')
      expect(match2.viewer).toBe('P2')

      // 录制体内容：seed + 双方卡组（create/join 上送的 DeckDto 原样入列）
      expect(match1.recording.seed).toBe(SEED)
      const expectedPlayers: PlayerSetup[] = [
        { id: 'P1', faction: deckA.faction, deck: { cards: deckA.cards } },
        { id: 'P2', faction: deckB.faction, deck: { cards: deckB.cards } },
      ]
      expect(canonicalJson(match1.recording.players)).toBe(canonicalJson(expectedPlayers))
      // 双席位录制体一致（viewer 之外逐字节同）
      expect(canonicalJson(match1.recording)).toBe(canonicalJson(match2.recording))
      expect(match2.recording.seed).toBe(match1.recording.seed)

      assertRecordingSound(match1, book.get(code) ?? [], server, code)
      assertRecordingSound(match2, book.get(code) ?? [], server, code)

      // replay_data 走席位日志（seq 计入），fetch 后每席位 seq 仍连续
      assertSeqContiguous(p1.history(), 'P1')
      assertSeqContiguous(p2.history(), 'P2')

      // —— E. 重连续传：replay_data 在席位日志中可随 resume 回放 ——
      const dataFrame = p2.history().find((frame) => frame.type === 'room' && frame.op.name === 'replay_data')
      expect(dataFrame && dataFrame.seq !== null).toBe(true)
      const joined = p2.history().find((frame) => frame.type === 'room' && frame.op.name === 'joined')
      const token = joined && joined.type === 'room' && joined.op.name === 'joined' ? joined.op.token : ''
      const dataSeq = dataFrame && dataFrame.seq !== null ? dataFrame.seq : 0
      p2.terminate()
      const resumed = new SimClient()
      await resumed.connect(server.url())
      resumed.send({ v: 1, type: 'room', op: { name: 'resume', code, token, lastSeq: dataSeq - 1 } })
      await resumed.waitFor((frame) => frame.type === 'room' && frame.op.name === 'resumed', 5000, 'resumed')
      const replayedData = resumed
        .history()
        .find((frame) => frame.type === 'room' && frame.op.name === 'replay_data' && frame.seq === dataSeq)
      expect(replayedData).toBeDefined()
      expect(replayedData && replayedData.type === 'room' && replayedData.op.name === 'replay_data' ? replayedData.op.match : null).not.toBeNull()
      resumed.close()
      p1.close()
    } finally {
      await server.close()
    }
  }, 60_000)

  it('B: AI 托管局——AI 席动作入列且顺序正确（镜像重放对账）', async () => {
    const { hook, book } = collectActions()
    const server = await startTestServer({ onActionApplied: hook })
    try {
      const host = new SimClient()
      await host.connect(server.url())
      host.send({ v: 1, type: 'room', op: { name: 'create', roomName: '回放录制B', deck: deckOf('intel-driver-magic'), fillWithAi: true } })
      const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''
      host.send({ v: 1, type: 'room', op: { name: 'start', seed: SEED + 1 } })
      await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')
      await playUntilEnded({ client: host, seat: 'P1', seed: 0x5eed33 })

      const match = await fetchReplay(host, 'P1')
      expect(match).not.toBeNull()
      const recording = match as ReplayMatchPayload
      const actions = book.get(code) ?? []
      expect(actions.length).toBeGreaterThan(0)

      // AI 席（P2）与人类席（P1）动作都在列（AI 托管走同一结算管线）
      const actorIds = new Set(recording.recording.actions.map((action) => String((action as { playerId?: unknown }).playerId)))
      expect(actorIds.has('P1')).toBe(true)
      expect(actorIds.has('P2')).toBe(true)

      // AI 席动作在权威序列与录制体中逐动作一致（runReplay 零漂移即顺序正确的最强对账）
      assertRecordingSound(recording, actions, server, code)
      host.close()
    } finally {
      await server.close()
    }
  }, 60_000)

  it('C: 无完赛——大厅与对局进行中 replay_data.match 均为 null', async () => {
    const server = await startTestServer()
    try {
      const p1 = new SimClient()
      const p2 = new SimClient()
      await p1.connect(server.url())
      await p2.connect(server.url())
      p1.send({ v: 1, type: 'room', op: { name: 'create', roomName: '回放录制C', deck: deckOf('neutral-system-builder') } })
      const created = await p1.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''

      // 大厅（对局未开）：无完赛 → match null
      expect(await fetchReplay(p1, 'P1-lobby')).toBeNull()

      p2.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckOf('nvidia-flagship-faith') } })
      await p2.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined')
      p1.send({ v: 1, type: 'room', op: { name: 'start', seed: SEED + 2 } })
      await p1.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')

      // 对局进行中（未发任何动作）：无完赛 → match null
      expect(await fetchReplay(p1, 'P1-playing')).toBeNull()
      expect(await fetchReplay(p2, 'P2-playing')).toBeNull()
      p1.close()
      p2.close()
    } finally {
      await server.close()
    }
  }, 30_000)

  it('D: 协议回环——parseClientFrame 接受 replay_fetch；未就座连接被拒 PROTOCOL_ERROR', async () => {
    // 解析层：replay_fetch 无载荷，多余字段忽略（宽松解析 → 明确形状）
    expect(parseClientFrame('{"v":1,"type":"room","op":{"name":"replay_fetch"}}')).toEqual({
      v: 1,
      kind: 'room',
      op: { name: 'replay_fetch' },
    })
    expect(parseClientFrame('{"v":1,"type":"room","op":{"name":"replay_fetch","x":1}}')).toEqual({
      v: 1,
      kind: 'room',
      op: { name: 'replay_fetch' },
    })
    expect(parseClientFrame('{"v":1,"type":"room","op":{"name":"replay_fetch_nothing"}}')).toBeNull()

    // 路由层：未就座连接发 replay_fetch → PROTOCOL_ERROR（不进房间层）
    const server = await startTestServer()
    try {
      const stranger = new SimClient()
      await stranger.connect(server.url())
      stranger.send({ v: 1, type: 'room', op: { name: 'replay_fetch' } })
      const error = await stranger.waitFor((frame) => frame.type === 'error', 5000, 'PROTOCOL_ERROR')
      expect(error.type === 'error' && error.code).toBe('PROTOCOL_ERROR')
      stranger.close()
    } finally {
      await server.close()
    }
  }, 30_000)
})
