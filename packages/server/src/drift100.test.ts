/**
 * M2-NET1 出口标准测试 —— 双脚本客户端经真实 ws（127.0.0.1，随机空闲端口）
 * 对跑 100 局（确定性 seed），逐动作对账三重零漂移：
 *
 * 1. **双方 viewFor vs 服务端 state**：客户端每帧收到的 view（经 JSON 线路
 *    往返）与服务端 applyAction 后现算的 viewFor 逐字节一致（canonicalJson）；
 * 2. **事件流一致**：两个客户端各自收到的事件序列彼此相同，且与服务端每动作
 *    产出的事件逐帧一致；
 * 3. **状态确定性**：同 seed + 双端实际上行的动作序列，在独立引擎实例上重放，
 *    逐动作 stableHash 与服务端实时状态哈希一致，终局 phase === 'ended'。
 *
 * 另校验：每席位 seq 从 1 起连续递增；动作全部经 {type:'action'} 上行；
 * 客户端零引擎逻辑——只消费服务端下发的 legalActions（与真实网页客户端同构）。
 */

import { describe, expect, it } from 'vitest'
import { canonicalJson, createEngine, stableHash, type Action, type GameSetup, type GameState, type PlayerSetup } from '@siliconcard/core'
import { createGameServer, type GameServer } from './server'
import { mulberry32, pickAction, pickDeck, SimClient } from './sim/simClient'
import { assertSeqContiguous, gameFrames } from './testServer'
import type { ActionAppliedInfo } from './gameHost'
import type { ProtocolSeat, ServerFrame } from './protocol'

const GAME_COUNT = 100
const MAX_ACTIONS_PER_GAME = 2000

/** 100 局的确定性参数：seed、双方卡组、双方动作策略种子全部由局号推导 */
function gamePlan(index: number): { seed: number; deckA: string; deckB: string; policySeedA: number; policySeedB: number } {
  const decks = ['nvidia-flagship-faith', 'amd-war-future', 'intel-driver-magic', 'neutral-system-builder']
  return {
    seed: 20260001 + index * 7919,
    deckA: decks[index % decks.length] as string,
    deckB: decks[(index + 1) % decks.length] as string,
    policySeedA: 0x5eed00 + index * 2 + 1,
    policySeedB: 0x5eed00 + index * 2 + 2,
  }
}

interface TruthRecord {
  action: Action
  stateHash: string
  events: string
  viewP1: string
  viewP2: string
}

interface RoomTruth {
  setup: GameSetup
  mirror: ReturnType<typeof createEngine>
  mirrorState: GameState | null
  /** 开局视图（镜像引擎 initGame 后现算，逐席位） */
  openingViewP1: string
  openingViewP2: string
  records: TruthRecord[]
}

function seatDeck(seat: ProtocolSeat, deckId: string): PlayerSetup {
  const deck = pickDeck(deckId).deck
  return { id: seat, faction: deck.faction, deck: { cards: [...deck.cards] } }
}

interface WireRecord {
  views: string[]
  events: string[]
}

/** 把席位帧流转成对账序列：开局 sync 视图 + 每动作 (view, events) 的 canonicalJson */
function wireOf(frames: readonly ServerFrame[]): WireRecord {
  const views: string[] = []
  const events: string[] = []
  for (const frame of gameFrames(frames)) {
    if (frame.type === 'sync') {
      if (frame.snapshot.phase === 'lobby' || frame.snapshot.view === null) continue // 大厅 sync 无视图
      views.push(canonicalJson(frame.snapshot.view))
    } else {
      views.push(canonicalJson(frame.view))
      events.push(canonicalJson(frame.events))
    }
  }
  return { views, events }
}

/** 打一局并完成对账（镜像引擎逐动作对账由共享 hook 完成）；返回局统计 */
async function playOneGame(server: GameServer, index: number, truths: Map<string, RoomTruth>): Promise<{ actions: number; turns: number; winner: string | null }> {
  const plan = gamePlan(index)
  const setup: GameSetup = {
    seed: plan.seed,
    players: [seatDeck('P1', plan.deckA), seatDeck('P2', plan.deckB)],
  }

  const url = server.url()
  const p1 = new SimClient({ onLog: (line) => console.log(`[p1#${index}]`, line) })
  const p2 = new SimClient({ onLog: (line) => console.log(`[p2#${index}]`, line) })
  let code = ''
  try {
    await p1.connect(url)
    await p2.connect(url)

    const deckA = pickDeck(plan.deckA).deck
    const deckB = pickDeck(plan.deckB).deck
    p1.send({ v: 1, type: 'room', op: { name: 'create', roomName: `drift-${index}`, deck: { faction: deckA.faction, cards: deckA.cards } } })
    const created = await p1.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 15000, `#${index} created`)
    code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''
    expect(code).not.toBe('')

    // 本房间的对账缓冲（镜像对账在共享 onActionApplied hook 内进行）
    const openingEngine = createEngine()
    const openingState = openingEngine.initGame(setup)
    truths.set(code, {
      setup,
      mirror: openingEngine,
      mirrorState: openingState,
      openingViewP1: canonicalJson(openingEngine.viewFor(openingState, 'P1')),
      openingViewP2: canonicalJson(openingEngine.viewFor(openingState, 'P2')),
      records: [],
    })

    p2.send({ v: 1, type: 'room', op: { name: 'join', code, deck: { faction: deckB.faction, cards: deckB.cards } } })
    await p2.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 15000, `#${index} joined`)

    // 光标在开局前落位：drive 必须消费到开局 sync（含先手方的首批 legalActions）
    const cursorP1 = p1.history().length
    const cursorP2 = p2.history().length
    p1.send({ v: 1, type: 'room', op: { name: 'start', seed: plan.seed } })
    await p1.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 15000, `#${index} started`)

    // —— 双客户端对跑（各自只按本席位 legalActions 出招，70% 进攻倾向）——
    const drive = async (client: SimClient, seat: ProtocolSeat, policySeed: number, cursor: number): Promise<void> => {
      const rng = mulberry32(policySeed)
      let guard = 0
      for (;;) {
        if (++guard > MAX_ACTIONS_PER_GAME * 8) throw new Error(`席位 ${seat} 帧数失控（第 ${index} 局）`)
        if (cursor >= client.history().length) {
          await client.waitForHistoryLength(cursor, 30000, `第 ${index} 局 ${seat} 对局帧`)
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
    await Promise.all([drive(p1, 'P1', plan.policySeedA, cursorP1), drive(p2, 'P2', plan.policySeedB, cursorP2)])

    // —— 对账 1：seq 连续性（每席位从 1 起递增）——
    assertSeqContiguous(p1.history(), 'P1')
    assertSeqContiguous(p2.history(), 'P2')

    // —— 对账 2：双方 viewFor 与服务端 state 逐字节一致；事件流逐帧一致 ——
    const truth = truths.get(code)
    if (!truth) throw new Error(`房间 ${code} 缺少对账缓冲（hook 未命中）`)
    const wire1 = wireOf(p1.history())
    const wire2 = wireOf(p2.history())
    expect(wire1.views).toHaveLength(truth.records.length + 1) // 开局 sync 视图 + 每动作视图
    expect(wire2.views).toHaveLength(truth.records.length + 1)
    expect(wire1.views[0]).toBe(truth.openingViewP1) // 开局视图各席位与引擎 initGame 一致
    expect(wire2.views[0]).toBe(truth.openingViewP2)
    for (let i = 0; i < truth.records.length; i++) {
      const record = truth.records[i] as TruthRecord
      expect(wire1.views[i + 1] ?? '').toBe(record.viewP1)
      expect(wire2.views[i + 1] ?? '').toBe(record.viewP2)
      expect(wire1.events[i] ?? '').toBe(record.events)
      expect(wire2.events[i] ?? '').toBe(record.events)
    }
    expect(wire1.events).toEqual(wire2.events) // 事件流双方一致

    // —— 对账 3：终局事实 ——
    const session = server.rooms.getByCode(code)?.session
    expect(session).not.toBeNull()
    const finalSession = session!
    expect(finalSession.ended).toBe(true)
    expect(truth.mirrorState?.phase).toBe('ended')
    expect(stableHash(truth.mirrorState as GameState)).toBe(finalSession.stateHash)

    return {
      actions: truth.records.length,
      turns: finalSession.stateSnapshot.turn,
      winner: finalSession.stateSnapshot.winner,
    }
  } finally {
    p1.close()
    p2.close()
    // 局末清场：房间数上限（64）会被连续建房打满
    if (code) server.rooms.dropRoom(code)
  }
}

describe('M2-NET1 双客户端 100 局零漂移（真实 ws）', () => {
  it(
    `对跑 ${GAME_COUNT} 局：双方 viewFor / 事件流 / 确定性重放逐动作零漂移`,
    async () => {
      const truths = new Map<string, RoomTruth>()
      const mirrorFailures: { roomCode: string; error: unknown }[] = []
      const onActionApplied = (info: ActionAppliedInfo): void => {
        const truth = truths.get(info.roomCode)
        if (!truth) {
          mirrorFailures.push({ roomCode: info.roomCode, error: new Error('hook 未命中房间对账缓冲') })
          return
        }
        const record: TruthRecord = {
          action: info.action,
          stateHash: info.stateHash,
          events: canonicalJson(info.events),
          viewP1: canonicalJson(info.views.P1),
          viewP2: canonicalJson(info.views.P2),
        }
        // 断言失败不得顺着 hook 抛回消息循环（会把连接打断）；记录起来局末清算
        try {
          if (truth.mirrorState === null) truth.mirrorState = truth.mirror.initGame(truth.setup)
          const replayed = truth.mirror.applyAction(truth.mirrorState, info.action) // 独立引擎重放
          truth.mirrorState = replayed.state
          expect(stableHash(truth.mirrorState)).toBe(info.stateHash) // 状态逐动作确定
          expect(canonicalJson(truth.mirror.viewFor(truth.mirrorState, 'P1'))).toBe(record.viewP1)
          expect(canonicalJson(truth.mirror.viewFor(truth.mirrorState, 'P2'))).toBe(record.viewP2)
        } catch (error) {
          mirrorFailures.push({ roomCode: info.roomCode, error })
        }
        truth.records.push(record)
      }

      const server = await createGameServer({ port: 0, host: '127.0.0.1', onActionApplied })
      try {
        const summary = { games: 0, totalActions: 0, decisive: 0 }
        for (let index = 0; index < GAME_COUNT; index++) {
          const result = await playOneGame(server, index, truths)
          expect(mirrorFailures).toEqual([]) // 镜像重放对账（漂移 3）无失败
          summary.games += 1
          summary.totalActions += result.actions
          if (result.winner !== null) summary.decisive += 1
          expect(result.actions).toBeGreaterThan(0)
          expect(result.actions).toBeLessThan(MAX_ACTIONS_PER_GAME)
        }
        // 汇总：100 局全部完成、动作量级合理、绝大多数分出胜负（随机策略下疲劳/斩杀收束）
        expect(summary.games).toBe(GAME_COUNT)
        expect(summary.totalActions).toBeGreaterThan(GAME_COUNT * 20)
        expect(summary.decisive).toBeGreaterThan(GAME_COUNT * 0.8)
        console.log(
          `[drift100] ${summary.games} 局 / ${summary.totalActions} 动作 / 分出胜负 ${summary.decisive} 局 —— 三重对账全通过`,
        )
      } finally {
        await server.close()
      }
    },
    590_000,
  )
})
