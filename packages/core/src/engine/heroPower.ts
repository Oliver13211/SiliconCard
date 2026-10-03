/**
 * USE_HERO_POWER —— 派系技能（英雄技能）合法性与结算
 * （docs/rules.md §3 / §4 / §6 / §8，M1-ENG5）。
 *
 * 合法性闸门（依序即 §3 表格次序，全部通过前不改任何状态）：
 *   轮到你（NOT_YOUR_TURN）→ 本回合未用过 !heroPowerUsed（HERO_POWER_USED，
 *   M1-ENG7 additive 专属错误码，detail.reason='hero_power_used' 机读兼容）→
 *   技能 cost ≤ mana（INSUFFICIENT_MANA；cost 取技能定义，内置四技能均为
 *   HERO_POWER_COST=200）→ chosen 目标合法（INVALID_TARGET，与 PLAY_CARD 共用
 *   chosen 校验：池交集 + 敌方潜行过滤，detail.reason 携带原因）。
 *   对局已结束在 applyAction 入口统一拒绝（GAME_ENDED）。
 *
 * 结算顺序（§3 / §6 因果线性）：扣功耗 → heroPowerUsed = true →
 * HERO_POWER_USED{playerId, skillId, target}（技能演出，先于效果）→
 * 按技能 effect.steps 结算（与出牌共用效果解释器；heroPowerUsed 无需等回合开始
 * 重置——beginTurn 已置 false，ENG1 既有行为）→ 胜负判定收尾。
 *
 * RNG 语义：本动作闸门不消费 RNG；效果步骤内消费（ray_tracing_try 命中判定
 * 每次恰好一次 nextFloat，成败均消耗，见 effects/handlers.ts）。
 *
 * 目标缺省边界：目标池取 effect.steps 内 chosen 选择器，未声明时回退定义级
 * targetPool（chosen 藏在 handler 里的技能，如 ray_tracing_try）；两者皆无
 * （如 driver_update）时 action.target 宽容忽略（与 PLAY_CARD「多余的 target
 * 宽容忽略」同一取舍）。目标池无可候选时动作不存在（getLegalActions 不产生，
 * apply 收到即 INVALID_TARGET），功耗照常不扣。
 */

import { RuleError } from '../engine'
import type { Action } from '../types/actions'
import type { TargetPool } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { GameState, PlayerId, TargetRef } from '../types/state'
import { resolveEffectSteps, type EffectContext } from './effects'
import { getFactionSkill, type FactionSkillDefinition } from './factions'
import type { Rng } from './prng'
import {
  chosenPoolsOfSteps,
  expandChosenTargets,
  validateChosenTargetInPools,
} from './play'
import { checkGameEnd } from './turn'

export type UseHeroPowerAction = Extract<Action, { type: 'USE_HERO_POWER' }>

/**
 * 技能的目标池解析：effect.steps 内的 chosen 选择器优先；steps 未声明 chosen
 * （chosen 藏在 handler 里，如 ray_tracing_try）时回退定义级 targetPool。
 */
function heroPowerPools(skill: FactionSkillDefinition): TargetPool[] {
  const pools = chosenPoolsOfSteps(skill.effect.steps)
  if (pools.length === 0 && skill.targetPool !== undefined) return [skill.targetPool]
  return pools
}

export function applyUseHeroPower(
  state: GameState,
  action: UseHeroPowerAction,
  events: GameEvent[],
  rng: Rng,
): void {
  // —— 合法性闸门（顺序即 §3 表格次序）——
  if (action.playerId !== state.activePlayer) {
    throw new RuleError('NOT_YOUR_TURN', `当前是 ${state.activePlayer} 的回合，不能使用派系技能`, {
      activePlayer: state.activePlayer,
      playerId: action.playerId,
    })
  }
  const player = state.players[action.playerId]
  const skill = getFactionSkill(player.faction)
  if (!skill) {
    // initGame 已校验注册；对局中途注册表被清空属宿主环境错误，
    // 不是玩家可纠正的非法操作，故不抛 RuleError（与出牌路径同取舍）。
    throw new Error(
      `派系 ${player.faction} 无已注册技能（宿主环境错误：请勿在对局中途清空派系技能注册表）`,
    )
  }
  if (player.heroPowerUsed) {
    // 错误码（M1-ENG7 additive 扩容，契约评审授权项）：专属 HERO_POWER_USED——
    // 「该动作此刻不可用」的语义不再借位 INVALID_TARGET；detail.reason='hero_power_used'
    // 保留为机读字段（ENG5 消费方兼容），语义同错误码。
    throw new RuleError('HERO_POWER_USED', `本回合派系技能已使用（${skill.skillName}），每回合限一次`, {
      reason: 'hero_power_used',
      skillId: skill.skillId,
      playerId: action.playerId,
    })
  }
  if (skill.cost > player.mana) {
    throw new RuleError(
      'INSUFFICIENT_MANA',
      `供电不足：${skill.skillName} 需要 ${skill.cost}W，当前可用 ${player.mana}W`,
      { cost: skill.cost, mana: player.mana, skillId: skill.skillId },
    )
  }
  validateChosenTargetInPools(
    state,
    action.playerId,
    heroPowerPools(skill),
    action.target,
    `技能「${skill.skillName}」`,
  )

  // —— 结算（§3/§6：扣费 → 置位 → 事件 → 效果）——
  player.mana -= skill.cost
  player.heroPowerUsed = true
  events.push({
    type: 'HERO_POWER_USED',
    playerId: action.playerId,
    skillId: skill.skillId,
    target: action.target ?? null,
  })
  const ctx: EffectContext = {
    state,
    events,
    actorId: action.playerId,
    sourceUnitId: null, // 技能无场上实例：self 池自然为空
    sourceCardId: skill.skillId,
    rng,
    chosenTarget: action.target ?? null,
    // 技能伤害归因为 heroPower（§6 事件目录），dust_off / 光追命中的 DAMAGE_DEALT 由此携带
    damageSource: { kind: 'heroPower', playerId: action.playerId },
  }
  resolveEffectSteps(ctx, skill.effect.steps ?? [])
  checkGameEnd(state, events)
}

/**
 * getLegalActions 的派系技能分支：本回合未用且功耗足时枚举。
 * 目标池为空（无 chosen 步骤且无 targetPool）→ 单个无 target 动作；
 * 有目标池 → 按池交集逐目标展开（潜行过滤开启；池为空不产生动作，与出牌 chosen 池空同语义）。
 */
export function legalHeroPowerActions(state: Readonly<GameState>, playerId: PlayerId): Action[] {
  const player = state.players[playerId]
  if (player.heroPowerUsed) return []
  const skill = getFactionSkill(player.faction)
  if (!skill || skill.cost > player.mana) return []
  const pools = heroPowerPools(skill)
  if (pools.length === 0) return [{ type: 'USE_HERO_POWER', playerId }]
  const targets: TargetRef[] = expandChosenTargets(state, playerId, pools)
  return targets.map((target) => ({ type: 'USE_HERO_POWER', playerId, target }))
}
