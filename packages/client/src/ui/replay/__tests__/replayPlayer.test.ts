/**
 * 回放播放器定向单测（P2-UI3）：
 * - 重驱时间轴与引擎黄金回放 stableHash 对齐（plan 验收主路径）；
 * - seek 幂等：任意事件点来回跳转，视图投影与直达完全一致；
 * - 上帝视角切片：双方手牌全量可见（P2 切片的 you.hand 补上 P1 视图的盲区）；
 * - 关键事件标记与事件流一一对应；
 * - 卡池漂移（动作非法）：driveError + 「与当前卡池版本不符」横幅 + 截断只读；
 * - 3D 帧契约：批次演出一次一帧、对账帧 events 为 null（与 TableRenderer 契约同构）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  createEngine,
  REPLAY_SCHEMA_VERSION,
  runReplay,
  stableHash,
  type Action,
  type GameEvent,
  type PlayerId,
  type ReplayRecording,
} from '@siliconcard/core'
import { buildReplayTimeline, replaySlicesOf, stateIndexForCursor } from '../replayDriver'
import { onReplayFrames, useReplayPlayerStore, type ReplayFrame } from '../playerStore'
import { ensureContentRegistered } from '../../game/deckLoader'
import { deckOf } from '../../__tests__/fixtures'
import type { ReplayMeta } from '../types'

beforeEach(() => {
  ensureContentRegistered({ cards: {}, decks: {} })
  useReplayPlayerStore.getState().exit()
})

const SETUP = {
  seed: 4242,
  players: [
    { id: 'P1', faction: 'neutral', heroName: '你', deck: deckOf('demo-gt-1030') },
    { id: 'P2', faction: 'nvidia', heroName: '对面老哥', deck: deckOf('demo-gt-1030') },
  ],
} as const

/** 用引擎合法动作驱动一局「有出牌有攻击」的对局，产出录制体（确定性：seed 固定） */
function buildInterestingRecording(): ReplayRecording {
  const engine = createEngine()
  let state = engine.initGame(SETUP)
  const actions: Action[] = []
  const push = (action: Action): void => {
    state = engine.applyAction(state, action).state
    actions.push(action)
  }
  for (let guard = 0; guard < 24 && state.phase !== 'ended'; guard += 1) {
    const legal = engine.getLegalActions(state, state.activePlayer)
    const attack = legal.find((action): action is Extract<Action, { type: 'ATTACK' }> => action.type === 'ATTACK')
    if (attack) {
      push(attack)
      continue
    }
    const play = legal.find((action): action is Extract<Action, { type: 'PLAY_CARD' }> => action.type === 'PLAY_CARD')
    if (play) {
      push(play)
      continue
    }
    const end = legal.find((action): action is Extract<Action, { type: 'END_TURN' }> => action.type === 'END_TURN')
    if (end) {
      push(end)
      continue
    }
    break
  }
  if (state.phase !== 'ended') push({ type: 'CONCEDE', playerId: state.activePlayer })
  return { seed: SETUP.seed, players: SETUP.players, actions }
}

function metaFor(recording: ReplayRecording, winner: PlayerId | null): ReplayMeta {
  return {
    id: 'test-meta',
    savedAt: 0,
    schemaVersion: REPLAY_SCHEMA_VERSION,
    seed: recording.seed,
    factions: ['neutral', 'nvidia'],
    winner,
    viewer: 'P1',
    outcome: winner === null ? 'draw' : winner === 'P1' ? 'win' : 'loss',
    reason: 'concede',
    turns: 3,
    actionCount: recording.actions.length,
    durationMs: 1000,
    source: 'local',
  }
}

function endWinnerOf(events: readonly GameEvent[]): PlayerId | null {
  const end = [...events].reverse().find((event): event is Extract<GameEvent, { type: 'GAME_END' }> => event.type === 'GAME_END')
  return end?.winner ?? null
}

describe('重驱时间轴：stableHash 对齐与开局事件', () => {
  it('终态 stableHash 与引擎黄金回放一致；事件数 = 引擎事件 + 合成开局 2 条', () => {
    const recording = buildInterestingRecording()
    const timeline = buildReplayTimeline(recording)
    expect(timeline.driveError).toBeNull()
    expect(recording.actions.length).toBeGreaterThanOrEqual(4) // 前置：录制体确实打出了动作

    const golden = runReplay(createEngine(), recording)
    expect(timeline.finalStateHash).toBe(golden.stateHash)
    expect(stableHash(timeline.states[timeline.states.length - 1])).toBe(golden.stateHash)
    expect(timeline.events.length).toBe(golden.events.length + 2)
    expect(timeline.states.length).toBe(recording.actions.length + 1)
    expect(timeline.stateIndexOfEvent.length).toBe(timeline.events.length)

    expect(timeline.events[0]?.type).toBe('GAME_START')
    expect(timeline.events[1]?.type).toBe('TURN_START')
  })

  it('开局事件归属初始态批次；动作事件归属各自批次终态', () => {
    const timeline = buildReplayTimeline(buildInterestingRecording())
    expect(stateIndexForCursor(timeline, 0)).toBe(0)
    expect(stateIndexForCursor(timeline, 2)).toBe(0) // 只播了开局 2 条 → 仍在初始态
    expect(stateIndexForCursor(timeline, 3)).toBe(1) // 第 3 条事件来自第 1 个动作
    expect(stateIndexForCursor(timeline, timeline.events.length)).toBe(timeline.states.length - 1)
  })

  it('关键事件标记与事件流一一对应（攻击/召唤/终局计数）', () => {
    const timeline = buildReplayTimeline(buildInterestingRecording())
    const countOf = (type: GameEvent['type']): number => timeline.events.filter((event) => event.type === type).length
    const markerCount = (kind: string): number => timeline.markers.filter((marker) => marker.kind === kind).length
    expect(markerCount('attack')).toBe(countOf('ATTACK_DECLARED'))
    expect(markerCount('summon')).toBe(
      timeline.events.filter((event) => event.type === 'MINION_SUMMONED' && event.source === 'play').length,
    )
    expect(markerCount('end')).toBe(countOf('GAME_END'))
    expect(timeline.markers.length).toBeGreaterThan(0)
    for (const marker of timeline.markers) {
      expect(marker.eventIndex).toBeLessThan(timeline.events.length)
    }
  })
})

describe('上帝视角切片（不改 core：双官方 viewFor 组合）', () => {
  it('双方手牌全量可见：P1 盲区（对手手牌内容）由 P2 切片补齐', () => {
    const timeline = buildReplayTimeline(buildInterestingRecording())
    const midState = timeline.states[Math.floor(timeline.states.length / 2)] as (typeof timeline.states)[number]
    const slices = replaySlicesOf(midState)

    // 对局视角的盲区：P1 视图只给 handSize 计数（PublicPlayerState 无 hand 字段）
    expect('hand' in slices.p1.opponent).toBe(false)
    expect(slices.p1.opponent.handSize).toBeGreaterThan(0)
    // 上帝视角：P2 切片的 you.hand 与 P1 视图的对手计数一致，且与完整 state 一致
    expect(slices.p2.you.hand.length).toBe(slices.p1.opponent.handSize)
    expect(slices.p1.you.hand.length).toBe(slices.p2.opponent.handSize)
    expect(slices.p2.you.hand).toEqual(midState.players.P2.hand)
    expect(slices.p1.you.hand).toEqual(midState.players.P1.hand)
    // 场上信息本就公开：两份切片 board 完全一致
    expect(slices.p1.board).toEqual(slices.p2.board)
    // 回合/阶段/胜者等全局字段两切片同源
    expect(slices.p1.turn).toBe(slices.p2.turn)
    expect(slices.p1.phase).toBe(slices.p2.phase)
    expect(slices.p1.activePlayer).toBe(slices.p2.activePlayer)
  })
})

describe('播放器 store：seek 幂等与光标语义', () => {
  it('任意事件点来回 seek，视图投影与直达完全一致（幂等）', () => {
    const recording = buildInterestingRecording()
    const timeline = buildReplayTimeline(recording)
    const store = useReplayPlayerStore.getState()
    store.load(metaFor(recording, endWinnerOf(timeline.events)), recording)

    const direct = (cursor: number) => {
      useReplayPlayerStore.getState().seekToCursor(cursor)
      return useReplayPlayerStore.getState().viewP1
    }
    const at8 = direct(8)
    expect(at8).not.toBeNull()
    // 8 → 3 → 8：两次落点逐字段一致（seek 幂等）
    expect(direct(3)).not.toEqual(at8)
    expect(direct(8)).toEqual(at8)
    // seek 到终点 = 全片播完的视图
    const end = direct(timeline.events.length)
    expect(end?.phase).toBe('ended')
    // 越界钳制
    expect(useReplayPlayerStore.getState().cursor).toBe(timeline.events.length)
    useReplayPlayerStore.getState().seekToCursor(999)
    expect(useReplayPlayerStore.getState().cursor).toBe(timeline.events.length)
    useReplayPlayerStore.getState().seekToCursor(-5)
    expect(useReplayPlayerStore.getState().cursor).toBe(0)
  })

  it('advance 逐事件推进、批次内不重复发演出帧；到尾自动停', () => {
    const recording = buildInterestingRecording()
    const timeline = buildReplayTimeline(recording)
    const frames: ReplayFrame[] = []
    const unsubscribe = onReplayFrames((frame) => frames.push(frame))
    try {
      const store = useReplayPlayerStore.getState()
      store.load(metaFor(recording, endWinnerOf(timeline.events)), recording)
      // load 只发初始对账帧
      expect(frames).toHaveLength(1)
      expect(frames[0]?.events).toBeNull()
      expect(frames[0]?.view.viewer).toBe('P1')

      const batchCount = new Set(timeline.stateIndexOfEvent).size
      for (let i = 0; i < timeline.events.length; i += 1) useReplayPlayerStore.getState().advance()
      // 每个批次恰好一帧演出帧 + 初始对账帧；对账帧 events 恒为 null，演出帧非空
      expect(frames).toHaveLength(batchCount + 1)
      const batchFrames = frames.slice(1)
      expect(batchFrames.every((frame) => (frame.events?.length ?? 0) > 0)).toBe(true)
      // 播完自动停
      expect(useReplayPlayerStore.getState().playing).toBe(false)
      expect(useReplayPlayerStore.getState().cursor).toBe(timeline.events.length)
    } finally {
      unsubscribe()
    }
  })
})

describe('卡池漂移：只读开放与版本提示', () => {
  it('动作非法时截断重驱 + versionNotice 提示「与当前卡池版本不符」', () => {
    const corrupted: ReplayRecording = {
      seed: 4242,
      players: SETUP.players,
      actions: [{ type: 'PLAY_CARD', playerId: 'P1', uid: 'nope' }],
    }
    const timeline = buildReplayTimeline(corrupted)
    expect(timeline.driveError).not.toBeNull()
    expect(timeline.driveError).toContain('与当前卡池版本不符')
    // 开局 2 条合成事件仍可播（只读开放已重驱部分）
    expect(timeline.events.length).toBe(2)

    useReplayPlayerStore.getState().load(metaFor(corrupted, null), corrupted)
    expect(useReplayPlayerStore.getState().versionNotice).toContain('与当前卡池版本不符')
    // 截断处之后不可步进
    const store = useReplayPlayerStore.getState()
    store.advance()
    store.advance()
    expect(useReplayPlayerStore.getState().cursor).toBe(2)
    expect(useReplayPlayerStore.getState().playing).toBe(false)
  })

  it('schemaVersion 不符或终局不一致同样亮「与当前卡池版本不符」', () => {
    const recording = buildInterestingRecording()
    const timeline = buildReplayTimeline(recording)
    const badVersion = { ...metaFor(recording, endWinnerOf(timeline.events)), schemaVersion: REPLAY_SCHEMA_VERSION + 1 }
    useReplayPlayerStore.getState().load(badVersion, recording)
    expect(useReplayPlayerStore.getState().versionNotice).toContain('与当前卡池版本不符')

    useReplayPlayerStore.getState().exit()
    const badWinner = metaFor(recording, endWinnerOf(timeline.events) === 'P1' ? 'P2' : 'P1')
    useReplayPlayerStore.getState().load(badWinner, recording)
    expect(useReplayPlayerStore.getState().versionNotice).toContain('与当前卡池版本不符')

    useReplayPlayerStore.getState().exit()
    useReplayPlayerStore.getState().load(metaFor(recording, endWinnerOf(timeline.events)), recording)
    expect(useReplayPlayerStore.getState().versionNotice).toBeNull()
  })
})
