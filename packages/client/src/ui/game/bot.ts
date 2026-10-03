/**
 * 对面 AI 的组装点（M1-AI1 接线）——策略本体在 @siliconcard/ai。
 *
 * 职责仅限：按对局参数创建/复用 AI 实例（实例内有决策 RNG 游标，
 * 一局一个，开局时由 gameStore 经 startBattle 重建）。
 * 决策时完整 state 由 BattleDriver 持有不经此处，AI 只经 core 公开接口
 * 观察（getLegalActions + viewFor，防作弊封印闸门在 ai 包内）。
 */

import { createAiPlayer, type AiPlayer } from '@siliconcard/ai'
import type { PlayerId } from '@siliconcard/core'

export function createBot(playerId: PlayerId = 'P2', seed?: number): AiPlayer {
  return createAiPlayer({ playerId, difficulty: 'normal', seed })
}
