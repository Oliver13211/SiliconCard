/**
 * 本地对局落库端到端集成测试（P2-α 交付 3）——锁真链路，不走 driver 手搓对局：
 *
 *   gameStore.startBattle(seed) →（认输快速终局）→ battleDriver GAME_END →
 *   setMatchRecordingSink（AppRoot.tsx 同款接线）→ recordFinishedMatch →
 *   saveReplayWithCap → configureReplayBackend 注入的内存后端
 *
 * 断言：终局后后端恰有 1 条回放、meta 字段齐全且与对局一致、回放体可取回；
 * 再来一局（rematch 真路径）第二局认输后变 2 条且内容寻址 id 互异。
 * 附带：存储不可用时 saveState 置 failed、零入库、对局侧照常结算（零感知）。
 */

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { useGameStore } from '../../store/gameStore'
import { setMatchRecordingSink } from '../../game/battleDriver'
import {
  configureReplayBackend,
  createMemoryBackend,
  replayBackend,
  type ReplayStorageBackend,
} from '../storage'
import { recordFinishedMatch, setReplayBackendForTests, useReplayStore } from '../replayStore'
import type { ReplayMeta } from '../types'

beforeEach(() => {
  // 干净的对局驱动 / 存储后端 / 录制 sink / saveState
  useGameStore.getState()._resetForTests()
  setReplayBackendForTests(createMemoryBackend())
  setMatchRecordingSink(null)
})

afterEach(() => {
  setMatchRecordingSink(null)
})

/** 冲掉 sink → recordFinishedMatch 的异步落库链（内存后端全微任务，一跳宏任务足够） */
function flushSave(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** AppRoot.tsx「回放录制线」effect 的同款接线：sink 交付 → 静默落库 */
function wireSinkLikeAppRoot(): void {
  setMatchRecordingSink((match) => {
    void recordFinishedMatch(match)
  })
}

describe('本地对局落库端到端（gameStore → sink → recordFinishedMatch → 后端）', () => {
  it('startBattle(seed) + 认输终局：后端恰有 1 条回放，meta 字段齐全且与对局一致', async () => {
    wireSinkLikeAppRoot()
    useGameStore.getState().setDraftFaction('neutral')
    useGameStore.getState().setDraftOpponentFaction('nvidia')
    useGameStore.getState().startBattle({ seed: 20260101 })
    expect(useGameStore.getState().screen).toBe('battle')

    // 快速终局：P1 认输 → GAME_END(concede, winner=P2)
    useGameStore.getState().concede()
    expect(useGameStore.getState().screen).toBe('result')

    await flushSave()

    const metas = await replayBackend().getAllMeta()
    expect(metas).toHaveLength(1)
    const meta = metas[0] as ReplayMeta

    // meta 字段齐全（ReplayMeta 全字段逐项过）
    expect(meta.id).toMatch(/^[0-9a-f]{8}$/) // 内容寻址 stableHash
    expect(meta.savedAt).toBeGreaterThan(0)
    expect(meta.schemaVersion).toBe(1)
    expect(meta.seed).toBe(20260101)
    expect(meta.factions).toEqual(['neutral', 'nvidia'])
    expect(meta.winner).toBe('P2')
    expect(meta.viewer).toBe('P1')
    expect(meta.outcome).toBe('loss') // 录制视角 P1 认输 → 负
    expect(meta.reason).toBe('concede')
    expect(meta.turns).toBeGreaterThanOrEqual(1)
    expect(meta.actionCount).toBeGreaterThanOrEqual(1)
    expect(meta.durationMs).toBeGreaterThanOrEqual(0)
    expect(meta.source).toBe('local')

    // 回放体可取回且与对局一致：种子一致、含认输动作
    const body = await replayBackend().getBody(meta.id)
    expect(body?.seed).toBe(20260101)
    expect(body?.players.map((p) => p.faction)).toEqual(['neutral', 'nvidia'])
    expect(body?.actions.some((action) => action.type === 'CONCEDE')).toBe(true)

    // saveState 置位（ReplaySaveToast 的数据源）：saved + 携带最近一条 meta
    const saveState = useReplayStore.getState().saveState
    expect(saveState.kind).toBe('saved')
    if (saveState.kind === 'saved') expect(saveState.meta.id).toBe(meta.id)
  })

  it('再来一局（rematch）第二局认输后：后端变 2 条，内容寻址 id 互异', async () => {
    wireSinkLikeAppRoot()
    useGameStore.getState().setDraftOpponentFaction('nvidia')
    useGameStore.getState().startBattle({ seed: 20260101 })
    useGameStore.getState().concede()
    await flushSave()
    expect(await replayBackend().getAllMeta()).toHaveLength(1)

    // 「再来一局」真路径：rematch → startBattle（新种子新对局）→ 认输
    useGameStore.getState().rematch()
    expect(useGameStore.getState().screen).toBe('battle')
    useGameStore.getState().concede()
    expect(useGameStore.getState().screen).toBe('result')
    await flushSave()

    const metas = await replayBackend().getAllMeta()
    expect(metas).toHaveLength(2)
    const ids = new Set(metas.map((meta) => meta.id))
    expect(ids.size).toBe(2) // 确定性引擎：不同种子 → 不同录制体 → 不同 id
    // 两局的 saveState 都走到 saved（toast 数据源始终指向最近一局）
    const saveState = useReplayStore.getState().saveState
    expect(saveState.kind).toBe('saved')
    if (saveState.kind === 'saved') expect(ids.has(saveState.meta.id)).toBe(true)
  })

  it('存储不可用：零入库、saveState 置 failed（带原因），对局照常进结算（零感知）', async () => {
    const rejectingBackend: ReplayStorageBackend = {
      getAllMeta: () => Promise.resolve([]),
      getBody: () => Promise.resolve(null),
      put: () => Promise.reject(new Error('quota exceeded')),
      delete: () => Promise.resolve(),
    }
    configureReplayBackend(rejectingBackend)
    wireSinkLikeAppRoot()
    useGameStore.getState().startBattle({ seed: 20260101 })
    useGameStore.getState().concede()

    expect(useGameStore.getState().screen).toBe('result') // 对局/结算零感知
    await flushSave()

    expect(await replayBackend().getAllMeta()).toHaveLength(0)
    const saveState = useReplayStore.getState().saveState
    expect(saveState.kind).toBe('failed')
    if (saveState.kind === 'failed') expect(saveState.reason).toContain('quota')
  })
})
