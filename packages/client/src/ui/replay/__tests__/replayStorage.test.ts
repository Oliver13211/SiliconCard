/**
 * 回放存储定向单测（P2-INF1）：内存后端基础语义、LRU 容量淘汰（第 51 局最旧出局）、
 * 删单局不伤邻座、内容寻址去重。IndexedDB 后端走同一 ReplayStorageBackend 接口，
 * 浏览器侧行为由接口契约保证（此处不做真实 IDB 集成）。
 */

import { describe, expect, it } from 'vitest'
import type { ReplayRecording } from '@siliconcard/core'
import {
  REPLAY_CAP,
  createMemoryBackend,
  evictIdsBeyondCap,
  replayIdOf,
  saveReplayWithCap,
} from '../storage'
import type { ReplayMeta } from '../types'

function recordingOf(seed: number): ReplayRecording {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'neutral', deck: { cards: [{ cardId: 'demo-gt-1030', count: 30 }] } },
      { id: 'P2', faction: 'nvidia', deck: { cards: [{ cardId: 'demo-gt-1030', count: 30 }] } },
    ],
    actions: [{ type: 'END_TURN', playerId: 'P1' }],
  }
}

function metaOf(id: string, savedAt: number, seed: number): ReplayMeta {
  return {
    id,
    savedAt,
    schemaVersion: 1,
    seed,
    factions: ['neutral', 'nvidia'],
    winner: 'P1',
    viewer: 'P1',
    outcome: 'win',
    reason: 'concede',
    turns: 2,
    actionCount: 1,
    durationMs: 1000,
    source: 'local',
  }
}

describe('replayStorage（IndexedDB 抽象 + LRU）', () => {
  it('内存后端：put/getAllMeta/getBody/delete 基础语义（meta 与 body 同键关联）', async () => {
    const backend = createMemoryBackend()
    const body = recordingOf(777)
    const id = replayIdOf(body)
    expect(await backend.getAllMeta()).toEqual([])
    expect(await backend.getBody(id)).toBeNull()

    await backend.put(metaOf(id, 1000, 777), body)
    expect(await backend.getAllMeta()).toHaveLength(1)
    expect((await backend.getBody(id))?.seed).toBe(777)

    await backend.delete(id)
    expect(await backend.getAllMeta()).toEqual([])
    expect(await backend.getBody(id)).toBeNull()
  })

  it('replayIdOf：内容寻址——同录制同 id，不同 seed 不同 id', () => {
    expect(replayIdOf(recordingOf(777))).toBe(replayIdOf(recordingOf(777)))
    expect(replayIdOf(recordingOf(777))).not.toBe(replayIdOf(recordingOf(778)))
  })

  it('evictIdsBeyondCap：按 savedAt 新→旧保留 cap 条；同刻按 id 兜底排序', () => {
    const metas = [
      metaOf('b', 2000, 2),
      metaOf('a', 2000, 1),
      metaOf('c', 3000, 3),
      metaOf('d', 1000, 4),
    ]
    // 新→旧排序为 [c, a, b, d]（同 savedAt=2000 时字典序 a 在 b 前）
    expect(evictIdsBeyondCap(metas, 2)).toEqual(['b', 'd'])
    expect(evictIdsBeyondCap(metas, 3)).toEqual(['d'])
    expect(evictIdsBeyondCap(metas, 50)).toEqual([])
  })

  it(`容量策略（cap=${REPLAY_CAP}）：连续落库 51 局，第 51 局完成时最旧一局被淘汰`, async () => {
    const backend = createMemoryBackend()
    for (let i = 0; i < REPLAY_CAP; i++) {
      const body = recordingOf(i + 1)
      await saveReplayWithCap(backend, metaOf(replayIdOf(body), 1000 + i, i + 1), body)
    }
    expect(await backend.getAllMeta()).toHaveLength(REPLAY_CAP)

    // 第 51 局：淘汰最旧（seed 1）
    const body51 = recordingOf(51)
    const { evicted } = await saveReplayWithCap(backend, metaOf(replayIdOf(body51), 1000 + REPLAY_CAP, 51), body51)
    expect(evicted).toEqual([replayIdOf(recordingOf(1))])
    const metas = await backend.getAllMeta()
    expect(metas).toHaveLength(REPLAY_CAP)
    expect(metas.some((m) => m.seed === 1)).toBe(false)
    expect(metas.some((m) => m.seed === 51)).toBe(true)
  })

  it('重复导入同一录制：内容寻址去重，只刷新 savedAt 不产生第二条', async () => {
    const backend = createMemoryBackend()
    const body = recordingOf(777)
    const id = replayIdOf(body)
    await saveReplayWithCap(backend, metaOf(id, 1000, 777), body)
    await saveReplayWithCap(backend, metaOf(id, 9999, 777), body)
    const metas = await backend.getAllMeta()
    expect(metas).toHaveLength(1)
    expect(metas[0]?.savedAt).toBe(9999)
  })

  it('删单局：其余记录完好（meta 与 body 同生共死）', async () => {
    const backend = createMemoryBackend()
    const ids = new Map<number, string>()
    for (const seed of [1, 2, 3]) {
      const body = recordingOf(seed)
      const id = replayIdOf(body)
      ids.set(seed, id)
      await saveReplayWithCap(backend, metaOf(id, seed * 1000, seed), body)
    }
    const removed = ids.get(2) as string
    const first = ids.get(1) as string
    const third = ids.get(3) as string
    await backend.delete(removed)
    const metas = await backend.getAllMeta()
    expect(metas.map((m) => m.seed).sort()).toEqual([1, 3])
    expect(await backend.getBody(removed)).toBeNull()
    expect((await backend.getBody(first))?.seed).toBe(1)
    expect((await backend.getBody(third))?.seed).toBe(3)
  })
})
