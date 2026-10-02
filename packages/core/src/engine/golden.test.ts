/**
 * 黄金回放接通（M1-ENG1 范围）：用真实引擎跑一局纯 END_TURN 对局，
 * 打到疲劳分出胜负；同 seed + 动作两次运行 stableHash 一致。
 * 全量快照基线（__golden__/）属 M1-ENG7，本文件不锁基线哈希。
 */

import { describe, expect, it } from 'vitest'
import type { Action } from '../types/actions'
import type { GameSetup } from '../types/state'
import { makeDistinctDeckSpec, TEST_SEED } from '../testing/state'
import { recordReplay, runReplay, assertGoldenReplay } from '../testing/replay'
import { createEngine } from './index'

const engine = createEngine()

/** 30 张互不相同的卡（让洗牌参与哈希），只出 END_TURN 直到疲劳终局 */
function pureEndTurnSetup(seed: number): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: makeDistinctDeckSpec() },
      { id: 'P2', faction: 'amd', deck: makeDistinctDeckSpec() },
    ],
  }
}

function pureEndTurnActions(count: number): Action[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'END_TURN',
    playerId: i % 2 === 0 ? 'P1' : 'P2',
  }))
}

// 期望节奏：起手 3 张后牌库 27。P1 首回合不抽（自身回合 2..28 抽 27 张，turn 57 起疲劳）；
// P2 首回合即抽（自身回合 1..27 抽 27 张抽空，turn 56 起疲劳）——P2 的疲劳序列早 P1 一步。
// 疲劳 8 次累计伤害 36 ≥ 30 → P2 在全局 turn 70（自身第 35 回合）倒下，P1 获胜
// → 恰好 69 次 END_TURN，第 70 个动作会因对局已结束被拒绝。
const FULL_GAME_ACTIONS = 69

describe('黄金回放：纯 END_TURN 疲劳对局（真实引擎）', () => {
  const setup = pureEndTurnSetup(TEST_SEED)
  const actions = pureEndTurnActions(FULL_GAME_ACTIONS)
  const recording = recordReplay(setup, actions)

  it('一局纯 END_TURN 对局能打到疲劳分出胜负', () => {
    const { finalState, events } = runReplay(engine, recording)
    expect(finalState.phase).toBe('ended')
    expect(finalState.endReason).toBe('health_zero')
    expect(finalState.winner).toBe('P1') // P2 不跳过首回合抽牌，牌库先耗尽、先疲劳
    expect(finalState.players.P2.fatigue).toBe(8)
    expect(finalState.players.P2.health).toBe(0)
    expect(finalState.players.P1.fatigue).toBe(7)
    expect(finalState.players.P1.health).toBe(2)
    expect(finalState.turn).toBe(70)
    // 终局事件以 GAME_END 收尾
    expect(events.at(-1)).toMatchObject({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
    // 对局途中经历了手牌超限烧牌（各自第 9 回合起手牌 11 张）
    expect(events.filter((e) => e.type === 'CARD_BURNED').length).toBeGreaterThan(0)
  })

  it('确定性：同 seed + 动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('异 seed 异哈希（洗牌差异进入状态）', () => {
    const other = runReplay(engine, recordReplay(pureEndTurnSetup(TEST_SEED + 1), actions))
    const base = runReplay(engine, recording)
    expect(other.stateHash).not.toBe(base.stateHash)
    // 结构节奏不受 seed 影响：同样打到 turn 70、同样的胜负
    expect(other.finalState.turn).toBe(base.finalState.turn)
    expect(other.finalState.winner).toBe('P1')
  })

  it('前缀动作产生不同哈希（动作序列参与决定状态）', () => {
    const prefix = runReplay(engine, recordReplay(setup, actions.slice(0, 40)))
    const full = runReplay(engine, recording)
    expect(prefix.finalState.phase).toBe('main') // 40 动作后仍在进行
    expect(prefix.stateHash).not.toBe(full.stateHash)
  })

  it('assertGoldenReplay 命中路径（M1-ENG7 将以此锁基线）', () => {
    const { stateHash } = runReplay(engine, recording)
    // 用本局自身哈希走一次断言，验证框架与真实引擎接通
    expect(() => assertGoldenReplay(engine, recording, stateHash)).not.toThrow()
  })
})
