/**
 * 结算画面数据（M1-UI3）—— 严格按 rules.md §9「结算信息完整性」：
 * GAME_END 事件（winner、reason）+ 终局 viewFor（turn / 双方 heroName、faction、
 * health、fatigue 等展示字段），不扩事件载荷。
 */

import type { PlayerView } from '@siliconcard/core'
import { factionDisplayName } from './fallbackContent'

export interface ResultSide {
  heroName: string
  faction: string
  health: number
  armor: number
  fatigue: number
  isWinner: boolean
}

export interface ResultData {
  winner: 'you' | 'opponent' | 'draw'
  reason: 'health_zero' | 'concede'
  turns: number
  headline: string
  subline: string
  you: ResultSide
  opponent: ResultSide
}

export function buildResult(view: PlayerView, gameEnd: { winner: string | null; reason: 'health_zero' | 'concede' }): ResultData {
  const youWon = gameEnd.winner === view.viewer
  const draw = gameEnd.winner === null
  const winner: ResultData['winner'] = draw ? 'draw' : youWon ? 'you' : 'opponent'

  const headline = draw ? '双双烧毁' : youWon ? '赢麻了' : 'R.I.P 烧了'
  const subline = buildSubline(view, winner, gameEnd.reason)

  return {
    winner,
    reason: gameEnd.reason,
    turns: view.turn,
    headline,
    subline,
    you: {
      heroName: view.you.heroName,
      faction: factionDisplayName(view.you.faction),
      health: view.you.health,
      armor: view.you.armor,
      fatigue: view.you.fatigue,
      isWinner: gameEnd.winner === view.viewer,
    },
    opponent: {
      heroName: view.opponent.heroName,
      faction: factionDisplayName(view.opponent.faction),
      health: view.opponent.health,
      armor: view.opponent.armor,
      fatigue: view.opponent.fatigue,
      isWinner: gameEnd.winner !== null && gameEnd.winner !== view.viewer,
    },
  }
}

function buildSubline(view: PlayerView, winner: ResultData['winner'], reason: 'health_zero' | 'concede'): string {
  if (winner === 'draw') return '两台 CPU 同时归零——按 §9 判平局，谁也别笑话谁'
  if (reason === 'concede') {
    return winner === 'you'
      ? `${view.opponent.heroName} 拔了电源（认输）`
      : `你亲手拔了电源（认输），${view.opponent.heroName} 白捡一胜`
  }
  return winner === 'you'
    ? `${view.opponent.heroName} 的 CPU 体质见底，当场烧毁`
    : `你的 CPU 体质见底，支撑了 ${view.turn} 个回合`
}
