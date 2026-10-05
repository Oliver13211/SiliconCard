/**
 * 联机 UI 流无头测试（M2-UI4）：lanStore + LanClient + net 层真实代码
 * （RoomApi / RemoteBattleDriver），仅 LanConnection 以 FakeLanConnection 替身注入。
 * 覆盖：建房/加入/等待（seat_update）、开局首帧（含开局事件合成）、动作上行、
 * RULE_VIOLATION 错误帧、对局中断线自动重连（lastSeq 续传、无缝续局不重复合成）、
 * 页面刷新恢复（不补造历史事件）、主动离开不重连。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameEvent, PlayerView } from '@siliconcard/core'
import type { GameSnapshot, LanConnection, RoomResult, SeatMap } from '../../net'
import { useLanStore, __setLanDependenciesForTests } from '../store/lanStore'
import { useGameStore } from '../store/gameStore'
import { FakeLanConnection } from './fakeLanConnection'
import { makeView } from './fixtures'
import type { SavedLanSession } from '../net/lanClient'
import { normalizeLanHost, reconnectDelayMs } from '../net/lanClient'

// —— 替身注入 ————————————————————————————————————————————

function memoryStorage() {
  const box: { data: SavedLanSession | null } = { data: null }
  return {
    box,
    get: (): SavedLanSession | null => box.data,
    save: (session: SavedLanSession): void => {
      box.data = session
    },
    clear: (): void => {
      box.data = null
    },
  }
}

function harness() {
  const connections: FakeLanConnection[] = []
  const storage = memoryStorage()
  __setLanDependenciesForTests({
    storage,
    createConnection: (url, handlers) => {
      const fake = new FakeLanConnection(url, handlers)
      connections.push(fake)
      return fake as unknown as LanConnection
    },
  })
  useLanStore.getState()._resetForTests()
  useGameStore.getState()._resetForTests()
  useLanStore.getState().refreshSavedFlag()
  return { connections, storage }
}

/** 排空微任务（fake conn 的 Promise 链路无定时器） */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}

// —— 服务端模拟帧 ————————————————————————————————————————————

const SEATS_FULL: SeatMap = {
  P1: { kind: 'human', connected: true },
  P2: { kind: 'human', connected: true },
}

function serverRoom(fake: FakeLanConnection, seq: number, op: RoomResult): void {
  fake.serverFrame({ v: 1, seq, type: 'room', op })
}

function serverCreated(fake: FakeLanConnection, code = 'A1B2C3', seq = 1): void {
  serverRoom(fake, seq, {
    name: 'created',
    code,
    token: 'tok-host',
    seat: 'P1',
    seats: { P1: { kind: 'human', connected: true }, P2: null },
    phase: 'lobby',
  })
}

function serverStarted(fake: FakeLanConnection, seq = 3): void {
  serverRoom(fake, seq, { name: 'started', seats: SEATS_FULL, phase: 'playing' })
}

function snapshotOf(overrides?: { view?: PlayerView; seat?: 'P1' | 'P2'; phase?: GameSnapshot['phase']; seed?: number }): GameSnapshot {
  return {
    roomCode: 'A1B2C3',
    roomName: '测试房',
    seat: overrides?.seat ?? 'P1',
    seats: SEATS_FULL,
    phase: overrides?.phase ?? 'playing',
    seed: overrides?.seed ?? 424242,
    view: overrides?.view ?? makeView(),
    legalActions: [{ type: 'END_TURN', playerId: overrides?.seat ?? 'P1' }],
  }
}

function serverSync(fake: FakeLanConnection, snapshot: GameSnapshot, seq = 4): void {
  fake.serverFrame({ v: 1, seq, type: 'sync', snapshot })
}

function serverEvents(fake: FakeLanConnection, events: readonly GameEvent[], view: PlayerView, seq: number): void {
  fake.serverFrame({ v: 1, seq, type: 'events', events, view, legalActions: [{ type: 'END_TURN', playerId: view.viewer }] })
}

/** 建房主路径：发起 → 建连 → create 上行 → created 回执 → 大厅 */
async function createRoomFlow(connections: FakeLanConnection[]): Promise<FakeLanConnection> {
  const lan = useLanStore.getState()
  lan.setHost('192.168.1.20:49321')
  const creating = lan.createLanRoom()
  await flush()
  const fake = connections[0]
  if (!fake) throw new Error('连接未创建')
  fake.accept()
  await flush()
  serverCreated(fake)
  await creating
  return fake
}

// ————————————————————————————————————————————————

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('联机地址与工具函数', () => {
  it('主机地址规范化：裸 IP:port 补 ws://，已带协议与尾斜杠原样收敛', () => {
    expect(normalizeLanHost('192.168.1.20:49321')).toBe('ws://192.168.1.20:49321')
    expect(normalizeLanHost('ws://192.168.1.20:49321/')).toBe('ws://192.168.1.20:49321')
    expect(() => normalizeLanHost('   ')).toThrow()
  })

  it('重连退避：1s → 2s → 4s → 封顶 5s', () => {
    expect(reconnectDelayMs(1)).toBe(1000)
    expect(reconnectDelayMs(2)).toBe(2000)
    expect(reconnectDelayMs(3)).toBe(4000)
    expect(reconnectDelayMs(9)).toBe(5000)
  })
})

describe('建房/加入/等待（大厅闭环）', () => {
  it('建房：房间码展示、本席位已连接、上行 create 带 DeckDto', async () => {
    const { connections } = harness()
    const fake = await createRoomFlow(connections)

    const lan = useLanStore.getState()
    expect(lan.step).toBe('lobby')
    expect(lan.error).toBeNull()
    expect(lan.lobby?.roomCode).toBe('A1B2C3')
    expect(lan.lobby?.url).toBe('ws://192.168.1.20:49321')
    expect(lan.lobby?.seats?.P1).toMatchObject({ kind: 'human', connected: true })
    expect(lan.lobby?.phase).toBe('lobby')

    const createOp = fake.sent.find((f) => f.type === 'room' && f.op.name === 'create')
    expect(createOp).toBeDefined()
    if (createOp?.type === 'room' && createOp.op.name === 'create') {
      expect(createOp.op.deck.faction).toBe(useLanStore.getState().draftFaction)
      expect(createOp.op.deck.cards.length).toBeGreaterThan(0)
    }
  })

  it('等待对手：seat_update 推送 P2 就座与掉线状态（等待/重连提示的数据源）', async () => {
    const { connections } = harness()
    const fake = await createRoomFlow(connections)

    serverRoom(fake, 2, {
      name: 'seat_update',
      seats: { P1: { kind: 'human', connected: true }, P2: { kind: 'human', connected: true } },
      phase: 'lobby',
    })
    await flush()
    expect(useLanStore.getState().lobby?.seats?.P2).toMatchObject({ kind: 'human', connected: true })

    // 对手断线（宽限期内）：BattleScreen 的掉线横幅读这个字段
    serverRoom(fake, 3, {
      name: 'seat_update',
      seats: { P1: { kind: 'human', connected: true }, P2: { kind: 'human', connected: false } },
      phase: 'lobby',
    })
    await flush()
    expect(useLanStore.getState().lobby?.seats?.P2?.connected).toBe(false)
  })

  it('加入失败（房间码错）：错误帧给房间级提示，立刻回表单可重试（硬回退路径）', async () => {
    const { connections } = harness()
    const lan = useLanStore.getState()
    lan.setHost('192.168.1.20:49321')
    lan.setDraftJoinCode('ZZZZZZ')
    // 不 await 整个调用：RoomApi 侧要等 8s 超时才 reject（net 层不因 error 帧拒绝请求，
    // 已登记）；UI 反馈由 error 帧即时给出
    void lan.joinLanRoom('ZZZZZZ')
    await flush()
    const fake = connections[0]
    expect(fake).toBeDefined()
    fake?.accept()
    await flush()
    fake?.serverFrame({ v: 1, seq: null, type: 'error', code: 'ROOM_NOT_FOUND', message: 'no such room' })
    await flush()
    expect(useLanStore.getState().step).toBe('form')
    expect(useLanStore.getState().error).toContain('房间不存在')
  })
})

describe('开局与对局帧（BattleScreen 复用）', () => {
  it('房主开局：start 上行 → started+sync → 自动进 battle 屏，开局事件补进战报', async () => {
    const { connections } = harness()
    const fake = await createRoomFlow(connections)

    serverRoom(fake, 2, {
      name: 'seat_update',
      seats: SEATS_FULL,
      phase: 'lobby',
    })
    await flush()

    const starting = useLanStore.getState().startLanGame()
    await flush()
    serverStarted(fake)
    await flush()
    serverSync(fake, snapshotOf())
    await starting
    await flush()

    expect(fake.sent.find((f) => f.type === 'room' && f.op.name === 'start')).toBeDefined()

    const game = useGameStore.getState()
    expect(game.screen).toBe('battle')
    expect(game.remoteMode).toBe(true)
    expect(game.view?.viewer).toBe('P1')
    expect(game.config?.seed).toBe(424242)
    expect(game.log.some((e) => e.text.includes('对局开始'))).toBe(true)
    expect(game.interactivity?.canEndTurn).toBe(true) // legalActions 来自服务端 sync
  })

  it('对局帧驱动战报与动作上行（客户端零引擎逻辑：原样转发）', async () => {
    const { connections } = harness()
    const fake = await createRoomFlow(connections)
    serverStarted(fake)
    await flush()
    serverSync(fake, snapshotOf())
    await flush()

    serverEvents(fake, [{ type: 'ARMOR_GAINED', playerId: 'P1', amount: 5, totalArmor: 5 }], makeView(), 5)
    await flush()
    const game = useGameStore.getState()
    expect(game.log.some((e) => e.text.includes('护甲'))).toBe(true)

    game.endTurn()
    const last = fake.sent.at(-1)
    expect(last).toMatchObject({ type: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
  })

  it('联机模式下 botTick 停用（对面动作由服务端推送，本地不代打）', async () => {
    const { connections } = harness()
    const fake = await createRoomFlow(connections)
    serverStarted(fake)
    await flush()
    // 对手回合视图：sync 携带 activePlayer=P2
    serverSync(fake, snapshotOf({ view: makeView({ activePlayer: 'P2' }) }))
    await flush()
    expect(useGameStore.getState().view?.activePlayer).toBe('P2')

    useGameStore.getState().botTick()
    await flush()
    // 没有任何动作上行（托管 tick 被拦）
    expect(fake.sent.filter((f) => f.type === 'action')).toHaveLength(0)
  })

  it('RULE_VIOLATION 错误帧：进对局错误条，剥错误码前缀并统一「供电不够」口吻', async () => {
    const { connections } = harness()
    await createRoomFlow(connections)
    serverStarted(connections[0] as FakeLanConnection)
    await flush()
    serverSync(connections[0] as FakeLanConnection, snapshotOf())
    await flush()

    ;(connections[0] as FakeLanConnection).serverFrame({
      v: 1,
      seq: null,
      type: 'error',
      code: 'RULE_VIOLATION',
      message: '[MANA_NOT_ENOUGH] 供电不足：需要 575W，余电 100W',
      ruleCode: 'MANA_NOT_ENOUGH',
    })
    await flush()
    const err = useGameStore.getState().lastError
    expect(err?.code).toBe('RULE_VIOLATION')
    expect(err?.message).toContain('供电不够')
    expect(err?.message).not.toContain('[')
  })
})

describe('断线重连（seq 续传 + 无缝续局）', () => {
  it('对局中断线：进重连态 → 指数退避重试 → resume 带 lastSeq → 重放+sync 恢复，开局事件不重复', async () => {
    vi.useFakeTimers()
    try {
      const { connections, storage } = harness()
      const fake = await createRoomFlow(connections)
      serverStarted(fake)
      await flush()
      serverSync(fake, snapshotOf())
      await flush()
      serverEvents(fake, [{ type: 'ARMOR_GAINED', playerId: 'P1', amount: 5, totalArmor: 5 }], makeView(), 5)
      await flush()
      expect(useGameStore.getState().screen).toBe('battle')

      // —— 服务端断开 ——
      fake.drop()
      expect(useLanStore.getState().step).toBe('reconnecting')
      expect(useLanStore.getState().reconnectAttempt).toBe(1)
      // 凭据 + 断线瞬间位点已落盘（重连续传凭据）
      expect(storage.box.data).toMatchObject({ code: 'A1B2C3', seat: 'P1', lastSeq: 5 })

      // —— 1s 后自动重连：新连接 + resume(lastSeq=5) ——
      await vi.advanceTimersByTimeAsync(1000)
      expect(connections.length).toBe(2)
      const reconnected = connections[1] as FakeLanConnection
      reconnected.accept()
      await flush()
      const resumeOp = reconnected.sent.find((f) => f.type === 'room' && f.op.name === 'resume')
      expect(resumeOp).toMatchObject({ type: 'room', op: { name: 'resume', code: 'A1B2C3', token: 'tok-host', lastSeq: 5 } })

      // —— 服务端：回放错过的事件帧 + resumed + 恒定一次 sync ——
      serverEvents(reconnected, [{ type: 'HEALING', target: { kind: 'hero', playerId: 'P1' }, amount: 3, resultingHealth: 28 }], makeView(), 6)
      await flush()
      serverRoom(reconnected, 7, { name: 'resumed', seat: 'P1', replayed: 1 })
      await flush()
      serverSync(reconnected, snapshotOf({ view: makeView({ turn: 2 }) }), 8)
      await flush()

      // 恢复完成：重连态解除、对局继续（无缝）
      expect(useLanStore.getState().step).toBe('lobby')
      expect(useLanStore.getState().reconnectAttempt).toBe(0)
      const game = useGameStore.getState()
      expect(game.screen).toBe('battle')
      expect(game.remoteMode).toBe(true)
      expect(game.view?.turn).toBe(2)
      // 开局事件只在开局首帧合成一次；恢复不重复补造
      expect(game.log.filter((e) => e.text.includes('对局开始'))).toHaveLength(1)
      expect(game.log.some((e) => e.text.includes('回血'))).toBe(true) // 回放帧的事件进战报
    } finally {
      vi.useRealTimers()
    }
  })

  it('页面刷新恢复：sessionStorage 凭据 → resume（无续传位点则仅全量对齐）→ 不补造开局事件', async () => {
    const { connections, storage } = harness()
    storage.save({ url: 'ws://192.168.1.20:49321', code: 'A1B2C3', token: 'tok-p2', seat: 'P2', lastSeq: null })
    useLanStore.getState().refreshSavedFlag()
    expect(useLanStore.getState().savedSession?.code).toBe('A1B2C3')

    // P2 视角的视图（viewer=P2）
    const p2View: PlayerView = { ...makeView({ turn: 3, activePlayer: 'P1' }), viewer: 'P2' }

    const restoring = useLanStore.getState().restoreSaved()
    await flush()
    const fake = connections[0] as FakeLanConnection
    fake.accept()
    await flush()
    expect(fake.sent.find((f) => f.type === 'room' && f.op.name === 'resume')).toMatchObject({
      type: 'room',
      op: { name: 'resume', code: 'A1B2C3', token: 'tok-p2', lastSeq: null },
    })
    serverRoom(fake, 1, { name: 'resumed', seat: 'P2', replayed: 0 })
    await flush()
    serverSync(fake, snapshotOf({ seat: 'P2', view: p2View }), 2)
    await restoring
    await flush()

    const game = useGameStore.getState()
    expect(game.screen).toBe('battle')
    expect(game.remoteMode).toBe(true)
    expect(game.view?.viewer).toBe('P2')
    expect(game.view?.turn).toBe(3)
    expect(game.log.filter((e) => e.text.includes('对局开始'))).toHaveLength(0) // 中盘恢复不补造历史
    expect(useLanStore.getState().step).toBe('lobby')
  })

  it('恢复失败（房间已注销）：错误帧即时回表单并解释原因', async () => {
    const { connections, storage } = harness()
    storage.save({ url: 'ws://192.168.1.20:49321', code: 'A1B2C3', token: 'tok-x', seat: 'P1', lastSeq: null })
    useLanStore.getState().refreshSavedFlag()

    // 不 await：RoomApi 侧要等 8s 超时才 reject（net 层不因 error 帧拒绝请求，已登记）
    void useLanStore.getState().restoreSaved()
    await flush()
    ;(connections[0] as FakeLanConnection).accept()
    await flush()
    ;(connections[0] as FakeLanConnection).serverFrame({
      v: 1,
      seq: null,
      type: 'error',
      code: 'ROOM_GONE',
      message: 'room is gone',
    })
    await flush()
    expect(useLanStore.getState().step).toBe('form')
    expect(useLanStore.getState().error).toContain('房间已注销')
  })
})

describe('离开与状态清理', () => {
  it('主动离开：上行 leave、清凭据、此后断线不再触发重连', async () => {
    const { connections, storage } = harness()
    const fake = await createRoomFlow(connections)
    await useLanStore.getState().leaveToForm()

    expect(fake.sent.find((f) => f.type === 'room' && f.op.name === 'leave')).toBeDefined()
    expect(useLanStore.getState().step).toBe('form')
    expect(storage.box.data).toBeNull()

    fake.drop()
    await flush()
    expect(connections.length).toBe(1) // closedByUser：不重连
    expect(useLanStore.getState().step).toBe('form')
  })
  it('对局结束后离开：清会话并回主菜单（remoteMode 复位）', async () => {
    const { connections } = harness()
    const fake = await createRoomFlow(connections)
    serverStarted(fake)
    await flush()
    serverSync(fake, snapshotOf({ phase: 'ended', view: makeView({ phase: 'ended' }) }))
    await flush()
    // sync 直接落终局视图（恢复场景兜底）：result 生成 + result 屏
    expect(useGameStore.getState().screen).toBe('result')
    expect(useGameStore.getState().remoteMode).toBe(true)

    await useLanStore.getState().leaveAndBackToMenu()
    const game = useGameStore.getState()
    expect(game.screen).toBe('menu')
    expect(game.remoteMode).toBe(false)
    expect(game.view).toBeNull()
  })
})
