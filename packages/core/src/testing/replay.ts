/**
 * 黄金回放框架 —— 回归守门工具（测试策略见 docs/rules.md §12）。
 * 用法：把「seed + 双方卡组 + 动作序列」录制成 ReplayRecording，
 * 对最终状态哈希做断言；引擎规则任何变化导致的漂移都会在测试中显性暴露。
 */

import type { Engine } from '../engine'
import type { Action } from '../types/actions'
import type { GameEvent } from '../types/events'
import type { GameSetup, GameState } from '../types/state'
import { stableHash } from './hash'

export interface ReplayRecording {
  seed: number
  players: GameSetup['players']
  actions: readonly Action[]
}

export interface ReplayResult {
  finalState: GameState
  events: readonly GameEvent[]
  stateHash: string
}

export function recordReplay(setup: GameSetup, actions: readonly Action[]): ReplayRecording {
  return { seed: setup.seed, players: setup.players, actions }
}

export function runReplay(engine: Engine, recording: ReplayRecording): ReplayResult {
  const setup: GameSetup = { seed: recording.seed, players: recording.players }
  let state = engine.initGame(setup)
  const events: GameEvent[] = []
  for (const action of recording.actions) {
    const result = engine.applyAction(state, action)
    state = result.state
    events.push(...result.events)
  }
  return { finalState: state, events, stateHash: stableHash(state) }
}

/** 哈希不匹配即抛错——测试中作为断言使用；漂移归因流程见 WF-ENGINE */
export function assertGoldenReplay(
  engine: Engine,
  recording: ReplayRecording,
  expectedHash: string,
): ReplayResult {
  const result = runReplay(engine, recording)
  if (result.stateHash !== expectedHash) {
    throw new Error(
      `黄金回放漂移：expected ${expectedHash}, got ${result.stateHash}（动作数 ${recording.actions.length}）`,
    )
  }
  return result
}
