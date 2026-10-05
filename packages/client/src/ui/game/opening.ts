/**
 * 开局演出事件合成（M2-UI4 抽取共用）。
 *
 * 引擎 initGame 不携带事件流（rules.md §2.1 签名裁决）：本地路径由 BattleDriver.start
 * 按初始 state 合成；联机路径服务端 sync 帧同样只有视图没有开局事件，按同一裁决
 * 从视图合成（无信息增量：seed/turn/activePlayer/maxMana 视图字段齐备）。
 * 仅在 turn===1 且 main 阶段时合成——断线恢复/回放进对局中盘不补造历史事件。
 */

import type { GameEvent, PlayerView } from '@siliconcard/core'

/** 按初始视图合成开局演出事件（与 BattleDriver.start 的 openingEvents 同构，rules.md §2.1/§6） */
export function synthesizeOpeningEvents(view: PlayerView, seed: number): readonly GameEvent[] {
  if (view.turn !== 1 || view.phase !== 'main') return []
  const activeMana = view.activePlayer === view.viewer ? view.you.maxMana : view.opponent.maxMana
  return [
    { type: 'GAME_START', seed, firstPlayer: view.activePlayer },
    {
      type: 'TURN_START',
      turn: view.turn,
      playerId: view.activePlayer,
      maxMana: activeMana,
      drawCount: 0,
    },
  ]
}
