/**
 * lanStore —— 局域网对战流 zustand store（M2-UI4）。
 *
 * 职责边界：只管「房间层」的界面状态（主机地址/扫描结果/大厅席位/重连提示）；
 * 对局事实一律经 LanClient（net 层 RemoteBattleDriver）落地进 gameStore
 * （applyRemoteFrame），本 store 不持有任何对局数据（架构铁律 3）。
 *
 * 发现路径（docs/protocol.md §6）：浏览器无 mDNS 能力——主路径为手动 IP:port
 * 直连 + HTTP 房间列表（fetchLanRooms）；扫描失败/无列表时手输房间码的硬回退
 * 永远可达。
 */

import { create } from 'zustand'
import type { Action, FactionId } from '@siliconcard/core'
import {
  fetchLanRooms,
  type AiDifficulty,
  type DeckDto,
  type ProtocolSeat,
  type RoomPhase,
  type RoomSummaryDto,
  type SeatMap,
} from '../../net'
import {
  LanClient,
  createSessionStorage,
  normalizeLanHost,
  type LanClientCallbacks,
  type LanClientOptions,
  type LanStorage,
  type SavedLanSession,
} from '../net/lanClient'
import { bindRemoteDispatch, useGameStore } from './gameStore'
import { deckOptions, ensureContentRegistered, resolveDeckChoice, RANDOM_DECK_ID } from '../game/deckLoader'
import { FACTION_DISPLAY } from '../game/fallbackContent'

export type LanStep = 'form' | 'connecting' | 'lobby' | 'reconnecting'

export interface LanLobby {
  roomCode: string | null
  seat: ProtocolSeat | null
  seats: SeatMap | null
  phase: RoomPhase | null
  url: string
}

interface LanStoreState {
  step: LanStep
  host: string
  discovered: RoomSummaryDto[]
  scanStatus: 'idle' | 'scanning' | 'ok' | 'failed'
  scanError: string | null
  /** 房间/协议级错误（建房/加入/开局失败等；对局内规则违规走 gameStore.lastError） */
  error: string | null
  busy: string | null
  lobby: LanLobby | null
  reconnectAttempt: number
  /** sessionStorage 中存在可恢复凭据（页面刷新后的「恢复上次对局」入口） */
  savedSession: SavedLanSession | null
  // 出装草稿（建房/加入共用）
  draftFaction: FactionId
  draftDeckId: string
  draftRoomName: string
  draftFillAi: boolean
  draftJoinCode: string
  draftAiDifficulty: AiDifficulty

  setHost: (host: string) => void
  scanRooms: () => Promise<void>
  setDraftFaction: (faction: FactionId) => void
  setDraftDeck: (deckId: string) => void
  setDraftRoomName: (name: string) => void
  setDraftFillAi: (fill: boolean) => void
  setDraftJoinCode: (code: string) => void
  setDraftAiDifficulty: (difficulty: AiDifficulty) => void
  createLanRoom: () => Promise<void>
  joinLanRoom: (code: string) => Promise<void>
  startLanGame: () => Promise<void>
  addAiToSeat: () => Promise<void>
  leaveToForm: () => Promise<void>
  /** 对局结束（result 屏）后的离开：清会话 + 回主菜单 */
  leaveAndBackToMenu: () => Promise<void>
  /** 页面刷新后恢复上次对局（凭据来自 sessionStorage） */
  restoreSaved: () => Promise<void>
  refreshSavedFlag: () => void
  dismissError: () => void
  /** LanClient 回调：房间/席位状态更新后同步大厅视图（内部语义，经 ensureClient 使用） */
  handleRoomChanged: () => void
  /** LanClient 回调：服务端 error 帧归类（规则违规 → 对局错误条，其余 → 房间层错误） */
  handleServerError: (frame: { code: string; message: string; ruleCode?: string }) => void
  /** 测试隔离：销毁会话并清空状态（非 UI 语义） */
  _resetForTests: () => void
}

// —— 模块级会话：store 重建（reset）之外的生命周期由 LanClient 自管 ——

let client: LanClient | null = null
let storage: LanStorage = createSessionStorage()
let createConnectionOverride: LanClientOptions['createConnection'] | undefined
let initialDeckId = deckOptions().find((d) => !d.degraded)?.id ?? RANDOM_DECK_ID

/** 对局上行口绑定：gameStore.remoteMode 下动作经此发往服务端（一次即可） */
bindRemoteDispatch((action: Action) => {
  if (client) client.dispatch(action)
})

function ensureClient(): LanClient {
  if (client) return client
  const callbacks: LanClientCallbacks = {
    onRoomChanged: () => useLanStore.getState().handleRoomChanged(),
    onBattleFrame: (frame) => useGameStore.getState().applyRemoteFrame(frame),
    onConnectionLost: () => {
      // 大厅/对局中断线：进入重连态（BattleScreen 据此盖重连提示层）
      if (useGameStore.getState().remoteMode) return // 对局中：屏不动，仅重连提示
      useLanStore.setState({ step: 'reconnecting' })
    },
    onReconnectAttempt: (attempt) => useLanStore.setState({ reconnectAttempt: attempt, step: 'reconnecting' }),
    onRestored: () => useLanStore.setState({ step: 'lobby', reconnectAttempt: 0, error: null, busy: null }),
    onError: (frame) => useLanStore.getState().handleServerError(frame),
  }
  client = new LanClient({ callbacks, storage, createConnection: createConnectionOverride })
  return client
}

/** 服务端 error 帧 → 界面文案：规则违规进对局错误条，其余归房间层错误（梗化映射见 LAN_ERROR_TEXT） */
const LAN_ERROR_TEXT: Record<string, string> = {
  ROOM_NOT_FOUND: '房间不存在或已解散——检查房间码，或让对方重新建房',
  ROOM_FULL: '房间满员了（这个码已经有两个人）',
  ROOM_NOT_FULL: '房间还没满员，先等对手就座或让房主开 AI 托管',
  INVALID_TOKEN: '重连凭据失效了，需要重新加入房间',
  ROOM_GONE: '房间已注销（断线超过宽限期），只能重开一局',
  NOT_HOST: '只有房主能干这事',
  ALREADY_SEATED: '你已经在座位上了',
  SEAT_EMPTY: '那个座位还空着',
  AI_SEAT_TAKEN: 'AI 已经坐下了，别挤',
  DECK_INVALID: '卡组没过服务端校验（卡牌未注册或张数不对），换一套再试',
  GAME_ALREADY_STARTED: '对局已经开了',
  GAME_NOT_STARTED: '对局还没开（房主尚未点开始）',
  WRONG_SEAT: '这不是你的座位（协议越权）',
  NOT_IN_GAME: '你不在对局里',
  VERSION_MISMATCH: '协议版本不一致：请刷新页面后重连',
  PROTOCOL_ERROR: '协议异常：与服务端的对话对不上号，请重连',
}

function describeServerError(frame: { code: string; message: string; ruleCode?: string }): string {
  if (frame.code === 'RULE_VIOLATION') {
    // 与 gameStore.friendlyRuleError 同一处理：剥错误码前缀 + 统一「供电不够」口吻
    const bare = frame.message.replace(/^\[[A-Z_]+\]\s*/, '')
    return bare.replaceAll('供电不足', '供电不够')
  }
  return LAN_ERROR_TEXT[frame.code] ?? frame.message
}

/** 出装草稿 → 协议 DeckDto（卡池注册 + 预组/随机卡组解析，与本地 startBattle 同源） */
function buildDeckDto(draftFaction: FactionId, draftDeckId: string): DeckDto {
  const report = ensureContentRegistered()
  const seed = (Math.floor(Math.random() * 0x7fffffff) ^ 0x1a7d3b) >>> 0
  const choice = resolveDeckChoice(draftDeckId, seed, report)
  return { faction: draftFaction, heroName: '你', cards: choice.spec.cards }
}

export const useLanStore = create<LanStoreState>()((set, get) => ({
  step: 'form',
  host: '',
  discovered: [],
  scanStatus: 'idle',
  scanError: null,
  error: null,
  busy: null,
  lobby: null,
  reconnectAttempt: 0,
  savedSession: null,
  draftFaction: FACTION_DISPLAY[0]?.id ?? 'neutral',
  draftDeckId: initialDeckId,
  draftRoomName: '',
  draftFillAi: false,
  draftJoinCode: '',
  draftAiDifficulty: 'normal',

  setHost: (host) => set({ host }),
  setDraftFaction: (faction) => set({ draftFaction: faction }),
  setDraftDeck: (deckId) => set({ draftDeckId: deckId }),
  setDraftRoomName: (name) => set({ draftRoomName: name }),
  setDraftFillAi: (fill) => set({ draftFillAi: fill }),
  setDraftJoinCode: (code) => set({ draftJoinCode: code.toUpperCase() }),
  setDraftAiDifficulty: (difficulty) => set({ draftAiDifficulty: difficulty }),

  /** HTTP 房间列表（mDNS 的浏览器替代路径）；失败时提示硬回退（手输房间码永远可用） */
  scanRooms: async () => {
    let url: string
    try {
      url = normalizeLanHost(get().host)
    } catch (error) {
      set({ scanStatus: 'failed', scanError: error instanceof Error ? error.message : String(error) })
      return
    }
    set({ scanStatus: 'scanning', scanError: null })
    try {
      const rooms = await fetchLanRooms(url)
      set({ discovered: rooms, scanStatus: 'ok', host: url })
    } catch (error) {
      set({
        discovered: [],
        scanStatus: 'failed',
        scanError: `${error instanceof Error ? error.message : String(error)}——扫不出来就直接手输房间码加入（手动直连永远可用）`,
      })
    }
  },

  createLanRoom: async () => {
    set({ step: 'connecting', busy: '正在建房…', error: null })
    try {
      const deck = buildDeckDto(get().draftFaction, get().draftDeckId)
      const lan = ensureClient()
      await lan.connectAndCreate(get().host, {
        roomName: get().draftRoomName.trim() || undefined,
        deck,
        fillWithAi: get().draftFillAi,
      })
      const snap = lan.snapshot
      set({
        step: 'lobby',
        busy: null,
        host: snap.url,
        lobby: { roomCode: snap.roomCode, seat: snap.seat, seats: snap.seats, phase: snap.phase, url: snap.url },
      })
    } catch (error) {
      // 服务端 error 帧若已给出具体原因（更可读），保留之：RoomApi 只能超时报错（net 层不因 error 帧拒绝请求）
      set({ step: 'form', busy: null, error: get().error ?? (error instanceof Error ? error.message : String(error)) })
    }
  },

  joinLanRoom: async (code) => {
    set({ step: 'connecting', busy: `正在加入 ${code.toUpperCase()}…`, error: null })
    try {
      const deck = buildDeckDto(get().draftFaction, get().draftDeckId)
      const lan = ensureClient()
      await lan.connectAndJoin(get().host, code, deck)
      const snap = lan.snapshot
      set({
        step: 'lobby',
        busy: null,
        host: snap.url,
        lobby: { roomCode: snap.roomCode, seat: snap.seat, seats: snap.seats, phase: snap.phase, url: snap.url },
      })
    } catch (error) {
      set({ step: 'form', busy: null, error: get().error ?? (error instanceof Error ? error.message : String(error)) })
    }
  },

  startLanGame: async () => {
    set({ busy: '正在开局…', error: null })
    try {
      await ensureClient().startGame()
      set({ busy: null })
    } catch (error) {
      set({ busy: null, error: error instanceof Error ? error.message : String(error) })
    }
  },

  addAiToSeat: async () => {
    set({ busy: '正在请 AI 上机…', error: null })
    try {
      await ensureClient().addAi(get().draftAiDifficulty)
      set({ busy: null })
    } catch (error) {
      set({ busy: null, error: error instanceof Error ? error.message : String(error) })
    }
  },

  /** 离开房间回表单（大厅/等待中的主动退出；对局结束后的退出走 leaveAndBackToMenu） */
  leaveToForm: async () => {
    await client?.leave()
    set({ step: 'form', lobby: null, busy: null, reconnectAttempt: 0, error: null, discovered: [], scanStatus: 'idle' })
    useLanStore.getState().refreshSavedFlag()
  },

  /** 对局结束（result 屏）后的离开：清会话 + 经 gameStore 回主菜单（顺带清 remoteMode） */
  leaveAndBackToMenu: async () => {
    await client?.leave()
    set({ step: 'form', lobby: null, busy: null, reconnectAttempt: 0, error: null, discovered: [], scanStatus: 'idle' })
    useGameStore.getState().backToMenu()
    useLanStore.getState().refreshSavedFlag()
  },

  /** 页面刷新后恢复：凭据来自 sessionStorage；成功后帧流自动续上大厅/对局 */
  restoreSaved: async () => {
    const saved = get().savedSession
    if (!saved) return
    set({ step: 'connecting', busy: '正在恢复上次对局…', error: null, host: saved.url })
    try {
      await ensureClient().restoreSaved()
      set({ busy: null })
    } catch (error) {
      // 房间多半已超宽限期销毁：清凭据回表单（服务端 error 帧已给出可读原因时保留之）
      storage.clear()
      set({
        step: 'form',
        busy: null,
        savedSession: null,
        error:
          get().error ??
          `${error instanceof Error ? error.message : String(error)}（房间可能已超过 60s 宽限期被注销，只能重开一局）`,
      })
    }
  },

  refreshSavedFlag: () => set({ savedSession: storage.get() }),

  dismissError: () => set({ error: null }),

  handleRoomChanged: () => {
    const lan = client
    if (!lan) return
    const snap = lan.snapshot
    set({
      lobby: { roomCode: snap.roomCode, seat: snap.seat, seats: snap.seats, phase: snap.phase, url: snap.url },
      // 大厅/等待视图跟随服务端相位；已在对局屏（remoteMode）时不动屏（BattleScreen 消费帧）
      step: useGameStore.getState().remoteMode ? 'lobby' : get().step === 'reconnecting' ? 'reconnecting' : 'lobby',
    })
  },

  handleServerError: (frame) => {
    const message = describeServerError(frame)
    if (frame.code === 'RULE_VIOLATION' || frame.code === 'WRONG_SEAT') {
      // 对局内规则违规：走 battle 屏的错误提示条（状态不动、对局继续——协议 §4）
      useGameStore.setState({ lastError: { code: frame.code, message } })
      return
    }
    set({
      error: message,
      busy: null,
      // 建房/加入等待回执期间被服务端拒（如房间码错）：立刻回表单，不等 RoomApi 超时
      step: get().step === 'connecting' ? 'form' : get().step,
    })
  },

  _resetForTests: () => {
    client?.leave().catch(() => undefined)
    client = null
    set({
      step: 'form',
      host: '',
      discovered: [],
      scanStatus: 'idle',
      scanError: null,
      error: null,
      busy: null,
      lobby: null,
      reconnectAttempt: 0,
      savedSession: null,
      draftFaction: FACTION_DISPLAY[0]?.id ?? 'neutral',
      draftDeckId: initialDeckId,
      draftRoomName: '',
      draftFillAi: false,
      draftJoinCode: '',
      draftAiDifficulty: 'normal',
    })
  },
}))

/** 测试注入：存储与连接工厂（默认 sessionStorage + 原生 WebSocket；测试传内存/fake 实现） */
export function __setLanDependenciesForTests(options: { storage?: LanStorage; createConnection?: LanClientOptions['createConnection'] }): void {
  if (options.storage) storage = options.storage
  createConnectionOverride = options.createConnection
  // LanClient 在 ensureClient 时读取模块级注入，重置 client 后生效
  client = null
  initialDeckId = deckOptions().find((d) => !d.degraded)?.id ?? RANDOM_DECK_ID
}
