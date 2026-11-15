/**
 * 脚本对手（P2-EDU1）—— 按回合触发的轻规则，禁用 AI 随机性。
 *
 * 定位：与 BattleDriver 托管 AI 同一架构位置（对局驱动方）。为精确编排教学
 * 关卡需要读完整 state 生成动作——这是 driver 层的合法职责（AI 包同款特权），
 * 玩家侧 HUD 仍只经 viewFor 视图观察，不越权。
 *
 * 确定性：全部规则只做确定性扫描（board 序 / 手牌序 / 最低血 tie-break board 序），
 * 不用任何 RNG。动作解析失败（卡不在手 / 付不起电 / 攻不了）一律跳过——
 * 对引擎与 seed 的变化（含并行期 P2 起手多一张电费抵扣券）保持防御性。
 */

import type { Action, BoardUnit, GameState, TargetRef } from '@siliconcard/core'
import { getCardDefinition } from '@siliconcard/core'
import type { P2Profile } from './types'

const SCRIPT_PLAYER = 'P2'
const HUMAN_PLAYER = 'P1'

function ownUnits(state: Readonly<GameState>, owner: string): BoardUnit[] {
  return state.board.filter((unit) => unit.ownerId === owner)
}

function enemyUnits(state: Readonly<GameState>, owner: string): BoardUnit[] {
  return state.board.filter((unit) => unit.ownerId !== owner)
}

/** 通用攻击目标优先级：嘲讽 → 质保 → 最脆皮（无潜行） → CPU（board 序 tie-break） */
export function genericAttackTarget(state: Readonly<GameState>, attacker: BoardUnit): TargetRef | null {
  const enemies = enemyUnits(state, attacker.ownerId)
  const taunt = enemies.find((unit) => unit.keywords.includes('taunt') && !unit.keywords.includes('stealth'))
  if (taunt) return { kind: 'unit', instanceId: taunt.instanceId }
  const shielded = enemies.find((unit) => unit.keywords.includes('divine_shield'))
  if (shielded) return { kind: 'unit', instanceId: shielded.instanceId }
  const hittable = enemies.filter((unit) => !unit.keywords.includes('stealth'))
  if (hittable.length > 0) {
    const weakest = [...hittable].sort((a, b) => a.health - b.health)[0] as BoardUnit
    return { kind: 'unit', instanceId: weakest.instanceId }
  }
  return { kind: 'hero', playerId: HUMAN_PLAYER }
}

function findReadyUnit(state: Readonly<GameState>): BoardUnit | null {
  return ownUnits(state, SCRIPT_PLAYER).find((unit) => unit.attacksRemaining > 0) ?? null
}

/** 打出指定卡（手牌序第一个可付起的匹配项；卡组约定不带 chosen 目标，无需 target） */
function resolvePlay(state: Readonly<GameState>, cardId: string): Action | null {
  const player = state.players[SCRIPT_PLAYER]
  const card = player.hand.find((entry) => entry.cardId === cardId && entry.cost <= player.mana)
  if (!card) return null
  const def = getCardDefinition(cardId)
  if (def && def.type !== 'driver' && ownUnits(state, SCRIPT_PLAYER).length >= 7) return null
  return { type: 'PLAY_CARD', playerId: SCRIPT_PLAYER, uid: card.uid }
}

function resolveAttack(state: Readonly<GameState>, attacker: BoardUnit, target: TargetRef): Action {
  return { type: 'ATTACK', playerId: SCRIPT_PLAYER, attackerId: attacker.instanceId, target }
}

const END_TURN: Action = { type: 'END_TURN', playerId: SCRIPT_PLAYER }

function withEndTurn(actions: readonly Action[]): Action[] {
  const last = actions.at(-1)
  if (last?.type === 'END_TURN') return [...actions]
  return [...actions, END_TURN]
}

/** L4 毕业战陪练：每回合最多打 2 张最便宜的卡（付得起、无 chosen 需求），然后按通用目标优先级攻击 */
function sparringTurn(state: Readonly<GameState>): readonly Action[] {
  const player = state.players[SCRIPT_PLAYER]
  const actions: Action[] = []
  let plannedMana = player.mana
  let plays = 0
  for (const card of [...player.hand].sort((a, b) => a.cost - b.cost)) {
    if (plays >= 2) break
    if (card.cost > plannedMana) continue
    const def = getCardDefinition(card.cardId)
    if (def && def.type !== 'driver' && ownUnits(state, SCRIPT_PLAYER).length + plays >= 7) continue
    actions.push({ type: 'PLAY_CARD', playerId: SCRIPT_PLAYER, uid: card.uid })
    plannedMana -= card.cost
    plays += 1
  }
  for (const unit of ownUnits(state, SCRIPT_PLAYER)) {
    if (unit.attacksRemaining <= 0) continue
    const target = genericAttackTarget(state, unit)
    if (target) actions.push(resolveAttack(state, unit, target))
  }
  return withEndTurn(actions)
}

/**
 * 解析 P2 本回合的完整动作序列（含收尾 END_TURN）。
 * 规则失败的动作被静默跳过——脚本永远能"结束回合"，不会卡死对局。
 */
export function resolveP2Turn(profile: P2Profile, state: Readonly<GameState>): readonly Action[] {
  switch (profile.kind) {
    case 'passer':
      return [END_TURN]
    case 'spawner': {
      const spawn = ownUnits(state, SCRIPT_PLAYER).length === 0 ? resolvePlay(state, profile.cardId) : null
      return withEndTurn(spawn ? [spawn] : [])
    }
    case 'aggressive': {
      const actions: Action[] = []
      if (ownUnits(state, SCRIPT_PLAYER).length === 0) {
        const spawn = resolvePlay(state, profile.cardId)
        if (spawn) actions.push(spawn)
      }
      const attacker = findReadyUnit(state)
      if (attacker) {
        const target = genericAttackTarget(state, attacker)
        if (target) actions.push(resolveAttack(state, attacker, target))
      }
      return withEndTurn(actions)
    }
    case 'shieldDemo': {
      const actions: Action[] = []
      if (ownUnits(state, SCRIPT_PLAYER).length === 0) {
        const spawn = resolvePlay(state, profile.cardId)
        if (spawn) actions.push(spawn)
      } else {
        // 仅当对方亮出三年质保单位才攻击它（质保"挡一刀"的编排来源）
        const shielded = enemyUnits(state, SCRIPT_PLAYER).find((unit) => unit.keywords.includes('divine_shield'))
        const attacker = findReadyUnit(state)
        if (shielded && attacker && !shielded.keywords.includes('stealth')) {
          actions.push(resolveAttack(state, attacker, { kind: 'unit', instanceId: shielded.instanceId }))
        }
      }
      return withEndTurn(actions)
    }
    case 'sparring':
      return sparringTurn(state)
  }
}
