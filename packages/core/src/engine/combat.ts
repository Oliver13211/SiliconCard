/**
 * ATTACK —— 攻击宣告与结算（docs/rules.md §2.4 / §3 / §6 / §7 / §9，M1-ENG3）。
 *
 * 合法性闸门（依序，全部通过前不改任何状态）：
 *   轮到你（NOT_YOUR_TURN）→ attacker 在你场上（UNIT_NOT_ON_BOARD，含"存在但属于对手"）
 *   → 可攻击判定（UNIT_CANNOT_ATTACK，detail.reason 区分：accessory_cannot_attack /
 *   zero_attack / summoning_sickness / no_attacks_remaining）→ 敌方存在已现身 taunt
 *   （信仰充值）时 target 必须是其一（TAUNT_BLOCKING）→ target 合法（INVALID_TARGET，
 *   detail.reason：unit_not_on_board / not_enemy_unit / stealth_hidden / own_hero）。
 *   对局已结束在 applyAction 入口统一拒绝（GAME_ENDED）。
 *
 * 结算顺序（§6 因果线性，死亡由 damageUnit/damageHero 内联处理）：
 *   charge 预算授予（召唤回合超频豁免）→ ATTACK_DECLARED → 双向伤害交换
 *   （先攻→防守、防守→先攻；对 CPU 护甲先于体质；三年质保各自消耗）→
 *   攻击者潜行现身（移除关键词 + KEYWORD_TRIGGERED）→ attacksRemaining -1 /
 *   attackedThisTurn = true → checkGameEnd（同时归零平局，§9）。
 *
 * 边界取舍（详见 M1-ENG3 汇报）：
 *   - 双向伤害为「同时结算」语义（炉石骨架）：防守方反击力取宣告时快照，即使被
 *     先手伤害击杀仍结算反击（快照规避阵亡剥离光环后的脏值）；防守方为 CPU 不反击；
 *   - charge 单位召唤回合的攻击预算在首次攻击结算时按 windfury 与否授予（2 / 1），
 *     复用 attacksRemaining 通道，不引入新状态字段；回合开始重置（turn.ts）不受影响；
 *   - 配件（accessory）一律不可发起攻击（§4「attacksRemaining 恒 0」），即使光环
 *     叠加出正攻击值；可被攻击、质保与死亡照常（0 攻防守方不反击）；
 *   - taunt × stealth 冲突（§7）：未现身的 stealth 单位其 taunt 无效——不拦截、
 *     也不可作为 target；防守方 stealth 过滤与 effects.ts targetCandidates 一致，
 *     以关键词存在为准（攻击即现身移除关键词，无需再查 attackedThisTurn）；
 *   - 潜行攻击者若在交换中阵亡，不再发「现身」事件（阵亡快照已定格）。
 */

import { RuleError } from '../engine'
import type { Action } from '../types/actions'
import type { DamageSource, GameEvent } from '../types/events'
import type { BoardUnit, GameState, PlayerId, TargetRef } from '../types/state'
import { getCardDefinition } from './registry'
import { checkGameEnd, damageHero, opponentOf } from './turn'
import { damageUnit, findUnit } from './units'

export type AttackAction = Extract<Action, { type: 'ATTACK' }>

/**
 * 单位本回合能否发起攻击：返回 null 表示可攻，否则为不可攻原因（供 detail.reason）。
 * 闸门与 getLegalActions 枚举共用本判定，保证「枚举无幽灵动作」不变量（fuzz 守护）。
 */
function attackBlockReason(state: Readonly<GameState>, unit: BoardUnit): string | null {
  if (getCardDefinition(unit.cardId)?.type === 'accessory') return 'accessory_cannot_attack'
  if (unit.attack <= 0) return 'zero_attack'
  const summonTurn = unit.summonedOnTurn === state.turn
  const hasCharge = unit.keywords.includes('charge')
  if (summonTurn && !hasCharge) return 'summoning_sickness'
  // charge 召唤回合：首次攻击前 attacksRemaining 为 0（createBoardUnit），预算待授予
  const pendingChargeBudget =
    summonTurn && hasCharge && !unit.attackedThisTurn && unit.attacksRemaining <= 0
  if (!pendingChargeBudget && unit.attacksRemaining <= 0) return 'no_attacks_remaining'
  return null
}

function canUnitAttack(state: Readonly<GameState>, actorId: PlayerId, unit: BoardUnit): boolean {
  return unit.ownerId === actorId && attackBlockReason(state, unit) === null
}

/** 敌方「已现身」的 taunt 单位（§7 冲突规则：stealth 未现身者 taunt 无效），board 序 */
function visibleEnemyTaunts(state: Readonly<GameState>, actorId: PlayerId): BoardUnit[] {
  return state.board.filter(
    (u) => u.ownerId !== actorId && u.keywords.includes('taunt') && !u.keywords.includes('stealth'),
  )
}

function unitRef(unit: BoardUnit): TargetRef {
  return { kind: 'unit', instanceId: unit.instanceId }
}

/**
 * 攻击目标的合法集合（§3 / §7）：有已现身 taunt → 仅 taunt 单位（多个任选其一）；
 * 否则敌方单位（board 序，滤未现身潜行）+ 敌方 CPU（末位）。
 */
export function legalAttackTargets(state: Readonly<GameState>, actorId: PlayerId): TargetRef[] {
  const taunts = visibleEnemyTaunts(state, actorId)
  if (taunts.length > 0) return taunts.map(unitRef)
  const targets: TargetRef[] = state.board
    .filter((u) => u.ownerId !== actorId && !u.keywords.includes('stealth'))
    .map(unitRef)
  targets.push({ kind: 'hero', playerId: opponentOf(actorId) })
  return targets
}

/** getLegalActions 的攻击分支：合法 attacker（board 序）× 合法 target 展开 */
export function legalAttackActions(state: Readonly<GameState>, playerId: PlayerId): Action[] {
  const actions: Action[] = []
  for (const unit of state.board) {
    if (!canUnitAttack(state, playerId, unit)) continue
    for (const target of legalAttackTargets(state, playerId)) {
      actions.push({ type: 'ATTACK', playerId, attackerId: unit.instanceId, target })
    }
  }
  return actions
}

export function applyAttack(state: GameState, action: AttackAction, events: GameEvent[]): void {
  // —— 合法性闸门（顺序即 §3 表格次序）——
  if (action.playerId !== state.activePlayer) {
    throw new RuleError('NOT_YOUR_TURN', `当前是 ${state.activePlayer} 的回合，不能攻击`, {
      activePlayer: state.activePlayer,
      playerId: action.playerId,
    })
  }
  const attacker = findUnit(state, action.attackerId)
  if (!attacker || attacker.ownerId !== action.playerId) {
    throw new RuleError('UNIT_NOT_ON_BOARD', `你的场上没有攻击单位 ${action.attackerId}`, {
      attackerId: action.attackerId,
      playerId: action.playerId,
    })
  }
  const blocked = attackBlockReason(state, attacker)
  if (blocked !== null) {
    throw new RuleError('UNIT_CANNOT_ATTACK', `单位 ${attacker.instanceId} 当前无法攻击`, {
      attackerId: attacker.instanceId,
      reason: blocked,
    })
  }

  const target = action.target
  const taunts = visibleEnemyTaunts(state, action.playerId)
  const targetIsVisibleTaunt =
    target.kind === 'unit' && taunts.some((t) => t.instanceId === target.instanceId)
  if (taunts.length > 0 && !targetIsVisibleTaunt) {
    throw new RuleError('TAUNT_BLOCKING', '敌方存在信仰充值（taunt）单位，必须先攻击它', {
      taunts: taunts.map(unitRef),
      target,
    })
  }

  // 防守方解析（unit / hero 二选一；合法性 detail 带原因供 UI 提示 / Agent 重试）
  let defenderUnit: BoardUnit | null = null
  let defenderHeroId: PlayerId | null = null
  if (target.kind === 'unit') {
    const unit = findUnit(state, target.instanceId)
    if (!unit) {
      throw new RuleError('INVALID_TARGET', `攻击目标 ${target.instanceId} 不在场上`, {
        reason: 'unit_not_on_board',
        target,
      })
    }
    if (unit.ownerId === action.playerId) {
      throw new RuleError('INVALID_TARGET', '攻击目标必须是敌方单位', {
        reason: 'not_enemy_unit',
        target,
      })
    }
    if (unit.keywords.includes('stealth')) {
      throw new RuleError('INVALID_TARGET', '敌方潜行单位（无输出亮机）现身前不可被攻击', {
        reason: 'stealth_hidden',
        target,
      })
    }
    defenderUnit = unit
  } else if (target.playerId === action.playerId) {
    throw new RuleError('INVALID_TARGET', '不能攻击己方 CPU', { reason: 'own_hero', target })
  } else {
    defenderHeroId = target.playerId
  }

  // —— 结算 ——
  // charge（超频）召唤回合：授予攻击预算（windfury 2 / 其余 1），与回合开始重置共用通道
  if (
    attacker.attacksRemaining <= 0 &&
    !attacker.attackedThisTurn &&
    attacker.summonedOnTurn === state.turn &&
    attacker.keywords.includes('charge')
  ) {
    attacker.attacksRemaining = attacker.keywords.includes('windfury') ? 2 : 1
  }

  events.push({ type: 'ATTACK_DECLARED', attackerId: attacker.instanceId, target })

  // 双向伤害交换（同时结算语义）：反击力先取快照，规避防守方阵亡剥离光环后的脏值
  const attackerSource: DamageSource = { kind: 'unit', instanceId: attacker.instanceId }
  const retaliation = defenderUnit !== null ? defenderUnit.attack : 0
  if (defenderUnit !== null) {
    damageUnit(state, defenderUnit, attacker.attack, attackerSource, events)
    if (retaliation > 0) {
      damageUnit(
        state,
        attacker,
        retaliation,
        { kind: 'unit', instanceId: defenderUnit.instanceId },
        events,
      )
    }
  } else if (defenderHeroId !== null) {
    damageHero(state, defenderHeroId, attacker.attack, attackerSource, events)
  }

  // 攻击者潜行现身（§7：攻击后立即现身）；交换中阵亡则不再发现身事件
  if (attacker.keywords.includes('stealth') && findUnit(state, attacker.instanceId)) {
    attacker.keywords = attacker.keywords.filter((k) => k !== 'stealth')
    events.push({
      type: 'KEYWORD_TRIGGERED',
      keyword: 'stealth',
      instanceId: attacker.instanceId,
      detail: '攻击后现身（无输出亮机解除）',
    })
  }

  attacker.attacksRemaining = Math.max(0, attacker.attacksRemaining - 1)
  attacker.attackedThisTurn = true

  // 胜负判定收尾（§9：同时归零 → winner null 平局），保证 GAME_END 收尾于事件流
  checkGameEnd(state, events)
}
