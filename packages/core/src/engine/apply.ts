/**
 * applyAction / getLegalActions —— 动作入口与合法性闸门（docs/rules.md §3）。
 *
 * 实现进度：END_TURN / CONCEDE（M1-ENG1）、PLAY_CARD（M1-ENG2，见 play.ts）、
 * ATTACK（M1-ENG3，见 combat.ts）；USE_HERO_POWER（M1-ENG5）尚未实现，抛
 * UNKNOWN_ACTION（message 注明归属任务，供调用方等待后续里程碑）。
 *
 * 状态隔离：入口先深拷贝（GameState 为纯 JSON 数据，JSON 往返即安全深拷贝），
 * 非法动作抛 RuleError 时原状态保持不变。
 *
 * RNG 接管：每次 applyAction 从 state.rng.state 接管引擎 PRNG，动作结算完成后
 * 写回——效果 random 选择器等一切随机经此链路，保证 seed + 动作序列确定性（§11）。
 */

import { RuleError } from '../engine'
import type { EngineResult } from '../engine'
import type { Action } from '../types/actions'
import type { GameEvent } from '../types/events'
import type { GameState, PlayerId } from '../types/state'
import { applyAttack, legalAttackActions, type AttackAction } from './combat'
import { createRng } from './prng'
import { applyPlayCard, legalPlayCardActions, type PlayCardAction } from './play'
import { applyTurnEndEffects, beginTurn, burnExcessHand, opponentOf } from './turn'

export function cloneState(state: Readonly<GameState>): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState
}

const UNIMPLEMENTED_TASK: Partial<Record<Action['type'], string>> = {
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
  const rng = createRng(next.rng.state)

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
      next.rng = { state: rng.getState() }
      return { state: next, events }
    }
    case 'CONCEDE': {
      // 认输不要求轮到该玩家（§3 合法性仅要求对局未结束）
      const winner = opponentOf(action.playerId)
      next.phase = 'ended'
      next.winner = winner
      next.endReason = 'concede'
      events.push({ type: 'GAME_END', winner, reason: 'concede' })
      next.rng = { state: rng.getState() }
      return { state: next, events }
    }
    case 'PLAY_CARD': {
      applyPlayCard(next, action as PlayCardAction, events, rng)
      next.rng = { state: rng.getState() }
      return { state: next, events }
    }
    case 'ATTACK': {
      // 攻击无随机步骤，rng 原值写回（序列化状态保持逐字节一致）
      applyAttack(next, action as AttackAction, events)
      next.rng = { state: rng.getState() }
      return { state: next, events }
    }
    case 'USE_HERO_POWER': {
      throw new RuleError(
        'UNKNOWN_ACTION',
        `${action.type} 尚未实现（属 ${UNIMPLEMENTED_TASK[action.type]}）；当前支持 END_TURN / CONCEDE / PLAY_CARD / ATTACK`,
        { actionType: action.type },
      )
    }
    default: {
      throw new RuleError('UNKNOWN_ACTION', '未知动作结构')
    }
  }
}

/**
 * 合法动作集（AI / Agent / UI 可交互性共用）：
 * 未结束 → 当前行动玩家 [END_TURN, CONCEDE, PLAY_CARD…, ATTACK…]；否则 []。
 * PLAY_CARD 枚举规则见 play.ts legalPlayCardActions（功耗/场位过滤 + chosen 目标展开）；
 * ATTACK 枚举规则见 combat.ts legalAttackActions（可攻击判定 + taunt/潜行/目标展开）。
 */
export function getLegalActions(state: Readonly<GameState>, playerId: PlayerId): readonly Action[] {
  if (state.phase === 'ended') return []
  if (playerId !== state.activePlayer) return []
  return [
    { type: 'END_TURN', playerId },
    { type: 'CONCEDE', playerId },
    ...legalPlayCardActions(state, playerId),
    ...legalAttackActions(state, playerId),
  ]
}
