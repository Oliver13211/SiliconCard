/**
 * applyAction / getLegalActions —— 动作入口与合法性闸门（docs/rules.md §3）。
 *
 * M1-ENG1 范围：END_TURN / CONCEDE 完整实现；
 * PLAY_CARD（M1-ENG2）/ ATTACK（M1-ENG3）/ USE_HERO_POWER（M1-ENG5）尚未实现，
 * 一律抛 UNKNOWN_ACTION（message 注明归属任务，供调用方等待后续里程碑）。
 *
 * 状态隔离：入口先深拷贝（GameState 为纯 JSON 数据，JSON 往返即安全深拷贝），
 * 非法动作抛 RuleError 时原状态保持不变。
 */

import { RuleError } from '../engine'
import type { EngineResult } from '../engine'
import type { Action } from '../types/actions'
import type { GameEvent } from '../types/events'
import type { GameState, PlayerId } from '../types/state'
import { applyTurnEndEffects, beginTurn, burnExcessHand, opponentOf } from './turn'

export function cloneState(state: Readonly<GameState>): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState
}

const UNIMPLEMENTED_TASK: Partial<Record<Action['type'], string>> = {
  PLAY_CARD: 'M1-ENG2（出牌结算）',
  ATTACK: 'M1-ENG3（攻击结算）',
  USE_HERO_POWER: 'M1-ENG5（派系技能）',
}

export function applyAction(state: Readonly<GameState>, action: Action): EngineResult {
  // 对局结束后一切动作拒绝（§3），原样返回会被误解为成功，必须抛错
  if (state.phase === 'ended') {
    throw new RuleError('GAME_ENDED', '对局已结束，不再接受任何动作', {
      winner: state.winner,
      endReason: state.endReason,
    })
  }
  const next = cloneState(state)
  const events: GameEvent[] = []

  switch (action.type) {
    case 'END_TURN': {
      if (action.playerId !== next.activePlayer) {
        throw new RuleError('NOT_YOUR_TURN', `当前是 ${next.activePlayer} 的回合`, {
          activePlayer: next.activePlayer,
          playerId: action.playerId,
        })
      }
      events.push({ type: 'TURN_END', turn: next.turn, playerId: action.playerId })
      applyTurnEndEffects(next, action.playerId, events)
      burnExcessHand(next, action.playerId, events)
      const nextPlayer = opponentOf(action.playerId)
      next.activePlayer = nextPlayer
      beginTurn(next, nextPlayer, events)
      return { state: next, events }
    }
    case 'CONCEDE': {
      // 认输不要求轮到该玩家（§3 合法性仅要求对局未结束）
      const winner = opponentOf(action.playerId)
      next.phase = 'ended'
      next.winner = winner
      next.endReason = 'concede'
      events.push({ type: 'GAME_END', winner, reason: 'concede' })
      return { state: next, events }
    }
    case 'PLAY_CARD':
    case 'ATTACK':
    case 'USE_HERO_POWER': {
      throw new RuleError(
        'UNKNOWN_ACTION',
        `${action.type} 尚未实现（属 ${UNIMPLEMENTED_TASK[action.type]}）；当前仅支持 END_TURN / CONCEDE`,
        { actionType: action.type },
      )
    }
    default: {
      throw new RuleError('UNKNOWN_ACTION', '未知动作结构')
    }
  }
}

/** 合法动作集（AI / Agent / UI 可交互性共用）：未结束 → 当前行动玩家 [END_TURN, CONCEDE]；否则 [] */
export function getLegalActions(state: Readonly<GameState>, playerId: PlayerId): readonly Action[] {
  if (state.phase === 'ended') return []
  if (playerId !== state.activePlayer) return []
  return [
    { type: 'END_TURN', playerId },
    { type: 'CONCEDE', playerId },
  ]
}
