/**
 * 黄金基线门禁（M1-ENG7，rules.md §12）—— 加载本目录 `*.golden.json` 基线
 * （recording = seed+players+actions 存档；expected = 终局哈希 + 终局事实 + 事件计数），
 * 逐一 assertGoldenReplay：终局状态哈希不命中即「黄金回放漂移」，CI（yarn test）即锁。
 *
 * 基线由确定性探针生成（同 ENG1..6 前例，探针见 fixtures.ts），四局风格各异：
 *   - combat.health-zero.nvidia-amd      出牌+贪心攻击 → 战斗分胜负；
 *   - fatigue.health-zero.intel-neutral  纯 END_TURN → 疲劳分胜负；
 *   - concede.amd-intel                  技能互拼后认输 → concede 结局；
 *   - draw.health-zero.neutral           全场炸机 → 双方同时归零平局（§9）。
 * 规则变更后的漂移归因（预期变更 → 用探针重生成基线 / 意外回归 → 修复）见 WF-ENGINE。
 *
 * 本测试同时是回放序列化（testing/replaySerialize）的真实消费方：基线 recording
 * 一律经 deserializeReplay 结构闸门进入回放。
 */

import { describe, expect, it } from 'vitest'
import combatBaseline from './combat.health-zero.nvidia-amd.golden.json'
import fatigueBaseline from './fatigue.health-zero.intel-neutral.golden.json'
import concedeBaseline from './concede.amd-intel.golden.json'
import drawBaseline from './draw.health-zero.neutral.golden.json'
import type { Action } from '../types/actions'
import type { GameSetup } from '../types/state'
import type { GameEvent } from '../types/events'
import './fixtures' // 注册基线卡池（gd-*），模块加载即生效
import { assertGoldenReplay, runReplay, type ReplayRecording } from '../testing/replay'
import { deserializeReplay, serializeReplay } from '../testing/replaySerialize'
import { createEngine } from '../engine/index'

/** 基线文件契约（*.golden.json 的顶层形状；recording 即序列化存档形态，结构由 deserializeReplay 校验） */
interface GoldenBaselineFile {
  name: string
  description: string
  probe: string
  recording: { schemaVersion: number; seed: number; players: GameSetup['players']; actions: readonly Action[] }
  expected: {
    stateHash: string
    winner: string | null
    endReason: string | null
    finalTurn: number
    eventCounts: Record<string, number>
  }
}

// JSON 导入的结构完整性由运行期 deserializeReplay 闸门校验（结构信息不在编译期断言）
const BASELINES = [combatBaseline, fatigueBaseline, concedeBaseline, drawBaseline] as unknown as GoldenBaselineFile[]

const engine = createEngine()

function countEvents(events: readonly GameEvent[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const event of events) counts[event.type] = (counts[event.type] ?? 0) + 1
  return counts
}

describe('黄金基线门禁（M1-ENG7）：*.golden.json（rules.md §12）', () => {
  it('基线清单：≥3 局、名称唯一、探针字段在案、四类结算风格全覆盖', () => {
    expect(BASELINES.length).toBeGreaterThanOrEqual(3)
    expect(new Set(BASELINES.map((b) => b.name)).size).toBe(BASELINES.length)
    for (const baseline of BASELINES) {
      expect(baseline.probe).toBeTruthy()
      expect(baseline.description).toBeTruthy()
      expect(baseline.expected.stateHash).toMatch(/^[0-9a-f]{8}$/)
    }
    const styles = new Set(BASELINES.map((b) => b.name.split('.')[0] as string))
    expect(styles).toEqual(new Set(['combat', 'fatigue', 'concede', 'draw']))
    // §9 结局类型：health_zero 分胜负 / health_zero 平局 / concede
    expect(new Set(BASELINES.map((b) => `${b.expected.endReason}:${String(b.expected.winner)}`))).toEqual(
      new Set(['health_zero:P1', 'health_zero:P2', 'health_zero:null', 'concede:P1']),
    )
  })

  for (const baseline of BASELINES) {
    describe(`基线：${baseline.name}`, () => {
      // 基线 recording 经回放序列化结构闸门进入引擎（存档格式即回放格式，§12）
      const recording: ReplayRecording = deserializeReplay(JSON.stringify(baseline.recording))

      it('recording 通过 deserializeReplay 结构校验（seed+players+actions 完整）', () => {
        expect(recording.seed).toBe(baseline.recording.seed)
        expect(recording.players.length).toBe(2)
        expect(recording.actions.length).toBe(baseline.recording.actions.length)
      })

      it('录制序列化逐字节稳定（canonicalJson 存档形态）', () => {
        const once = serializeReplay(recording)
        expect(serializeReplay(deserializeReplay(once))).toBe(once)
      })

      it('assertGoldenReplay：终局状态哈希命中基线（漂移即「黄金回放漂移」报错）', () => {
        const result = assertGoldenReplay(engine, recording, baseline.expected.stateHash)
        expect(result.finalState.phase).toBe('ended')
        expect(result.stateHash).toBe(baseline.expected.stateHash)
      })

      it('确定性：同 seed+动作两次运行哈希与事件流逐字节一致', () => {
        const a = runReplay(engine, recording)
        const b = runReplay(engine, recording)
        expect(a.stateHash).toBe(b.stateHash)
        expect(a.events).toEqual(b.events)
      })

      it('终局事实与基线一致：winner / endReason / 回合数，GAME_END 恰好一次且收尾', () => {
        const { finalState, events } = runReplay(engine, recording)
        expect(finalState.winner).toBe(baseline.expected.winner)
        expect(finalState.endReason).toBe(baseline.expected.endReason)
        expect(finalState.turn).toBe(baseline.expected.finalTurn)
        // 结算信息完整性（§6/§9）：GAME_END 是终局动作事件流的收尾、恰好一次
        expect(events.at(-1)?.type).toBe('GAME_END')
        expect(events.filter((e) => e.type === 'GAME_END').length).toBe(1)
      })

      it('关键事件计数与基线逐项一致（事件目录语义变更必然显性漂移）', () => {
        const { events } = runReplay(engine, recording)
        expect(countEvents(events)).toEqual(baseline.expected.eventCounts)
      })
    })
  }
})
