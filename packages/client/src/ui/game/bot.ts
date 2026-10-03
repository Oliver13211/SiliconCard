/**
 * 对面对局占位（M1-UI1..3）——「简易托管」。
 *
 * ⚠️ 占位说明：正式内置人机是 M1-AI1（@siliconcard/ai，game-ai 预设），本模块
 * 只为菜单闭环提供一个不闹事的对手：只消费 getLegalActions 输出（引擎公开接口，
 * 不读完整 state 作弊），策略为「能出就出、能打就打、打完收工」。
 * M1-AI1 落地后由集成侧替换，本文件随之下岗。
 */

import type { Action } from '@siliconcard/core'

/**
 * 从合法动作里挑一个（每次返回一个动作，由调用方结算后再取下一个）。
 * 结束回合后返回 null。
 */
export function pickBotAction(legal: readonly Action[]): Action | null {
  const cards = legal.filter((a): a is Extract<Action, { type: 'PLAY_CARD' }> => a.type === 'PLAY_CARD')
  if (cards.length > 0) {
    // 无目标的牌优先（保证有牌可出绝不卡流程）；动作不携带 cost，排序交给引擎展开顺序
    const withoutTarget = cards.filter((a) => !a.target)
    return (withoutTarget[0] ?? cards[0]) ?? null
  }

  const attacks = legal.filter((a): a is Extract<Action, { type: 'ATTACK' }> => a.type === 'ATTACK')
  if (attacks.length > 0) {
    // 猜脸优先：直伤 CPU，尽快结束对局（对玩家友好的占位强度）
    const face = attacks.find((a) => a.target.kind === 'hero')
    return face ?? attacks[0] ?? null
  }

  const powers = legal.filter((a): a is Extract<Action, { type: 'USE_HERO_POWER' }> => a.type === 'USE_HERO_POWER')
  if (powers.length > 0) {
    return powers[0] ?? null
  }

  const endTurn = legal.find((a): a is Extract<Action, { type: 'END_TURN' }> => a.type === 'END_TURN')
  return endTurn ?? null
}
