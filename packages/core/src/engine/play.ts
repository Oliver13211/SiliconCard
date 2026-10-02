/**
 * PLAY_CARD —— 出牌合法性与结算（docs/rules.md §3 / §2.3 / §5，M1-ENG2）。
 *
 * 合法性依序校验（全部通过前不改任何状态）：
 *   轮到你（NOT_YOUR_TURN）→ 手牌含 uid（CARD_NOT_IN_HAND）→ cost ≤ mana
 *   （INSUFFICIENT_MANA，按光环修正后的手牌 cost）→ 目标合法性（INVALID_TARGET，
 *   detail 携带原因；敌方潜行未现身不可指定）→ gpu/accessory 入场需己方场上
 *   < BOARD_LIMIT（BOARD_FULL；driver 不占槽不受限）。
 *
 * 结算顺序：扣功耗 → 移出手牌 → CARD_PLAYED →（gpu/accessory）入场召唤
 * → battlecry/onPlay 步骤结算（effect 解释器）→ 胜负判定。
 *
 * 边界取舍（详见 M1-ENG2 汇报）：accessory 出牌后进场上（占扩展槽、受
 * BOARD_LIMIT 限制、按 0/1 身板入场、不可攻击），在场期间光环常驻。
 */

import { BOARD_LIMIT } from '../constants'
import { RuleError } from '../engine'
import type { Action } from '../types/actions'
import type { CardDefinition, InstanceId, TargetPool } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { GameState, HandCard, PlayerId, TargetRef } from '../types/state'
import { applyHandCosts } from './aura'
import { resolveEffectSteps, targetCandidates, type EffectContext } from './effects'
import type { Rng } from './prng'
import { getCardDefinition } from './registry'
import { checkGameEnd } from './turn'
import { countOwnUnits, summonUnit } from './units'

export type PlayCardAction = Extract<Action, { type: 'PLAY_CARD' }>

export function applyPlayCard(
  state: GameState,
  action: PlayCardAction,
  events: GameEvent[],
  rng: Rng,
): void {
  // —— 合法性闸门（顺序即 §3 表格次序）——
  if (action.playerId !== state.activePlayer) {
    throw new RuleError('NOT_YOUR_TURN', `当前是 ${state.activePlayer} 的回合，不能出牌`, {
      activePlayer: state.activePlayer,
      playerId: action.playerId,
    })
  }
  const player = state.players[action.playerId]
  const handIndex = player.hand.findIndex((c) => c.uid === action.uid)
  if (handIndex === -1) {
    throw new RuleError('CARD_NOT_IN_HAND', `手牌中没有 uid 为 ${action.uid} 的牌`, {
      playerId: action.playerId,
      uid: action.uid,
    })
  }
  const card = player.hand[handIndex] as HandCard
  const def = getCardDefinition(card.cardId)
  if (!def) {
    // initGame 已校验全部手牌来源的注册；对局中途注册表被清空属宿主环境错误，
    // 不是玩家可纠正的非法操作，故不抛 RuleError。
    throw new Error(`手牌 ${card.cardId} 无已注册定义（宿主环境错误：请勿在对局中途清空卡牌注册表）`)
  }
  if (card.cost > player.mana) {
    throw new RuleError('INSUFFICIENT_MANA', `供电不足：需要 ${card.cost}W，当前可用 ${player.mana}W`, {
      cost: card.cost,
      mana: player.mana,
    })
  }
  validateChosenTarget(state, action.playerId, def, action.target)
  if (def.type !== 'driver' && countOwnUnits(state, action.playerId) >= BOARD_LIMIT) {
    throw new RuleError('BOARD_FULL', `扩展槽已满（${BOARD_LIMIT}），无法再入场 ${def.type}`, {
      boardLimit: BOARD_LIMIT,
      ownUnits: countOwnUnits(state, action.playerId),
      cardType: def.type,
    })
  }

  // —— 结算 ——
  player.mana -= card.cost
  player.hand = player.hand.filter((_, i) => i !== handIndex)
  applyHandCosts(state)
  events.push({
    type: 'CARD_PLAYED',
    playerId: action.playerId,
    uid: action.uid,
    cardId: def.id,
    cost: card.cost,
    target: action.target ?? null,
  })

  // gpu / accessory 入场（board = 入场顺序末尾；合法性已保证有空位）
  let sourceUnitId: InstanceId | null = null
  if (def.type !== 'driver') {
    const unit = summonUnit(state, action.playerId, def, events, 'play')
    sourceUnitId = unit?.instanceId ?? null
  }

  // driver 出牌即结算 / gpu·accessory 入场战吼（§4 §5：onPlay 为主触发，battlecry 兼容）
  const effect = def.effect
  if (effect && (effect.trigger === 'battlecry' || effect.trigger === 'onPlay') && effect.steps) {
    const ctx: EffectContext = {
      state,
      events,
      actorId: action.playerId,
      sourceUnitId,
      sourceCardId: def.id,
      rng,
      chosenTarget: action.target ?? null,
    }
    resolveEffectSteps(ctx, effect.steps)
  }
  // effect.aura 不在此结算：光环由 aura.ts 按在场源投影（召唤时已随 withBoardAuras 生效）

  // TODO(M1-ENG4): overload（跳闸）关键词的 lockedMana 结算——数值来自卡牌效果定义（§7）
  // TODO(M1-ENG6): handler 逃生舱在 resolveEffectSteps 内接入

  checkGameEnd(state, events)
}

/** 收集卡牌效果中全部 chosen 选择器的目标池（多池取交集，v1 出牌仅携带单目标） */
function chosenPools(def: CardDefinition): TargetPool[] {
  const pools: TargetPool[] = []
  for (const step of def.effect?.steps ?? []) {
    if ('target' in step && step.target.kind === 'chosen') pools.push(step.target.pool)
  }
  return pools
}

export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  if (a.kind === 'unit' && b.kind === 'unit') return a.instanceId === b.instanceId
  if (a.kind === 'hero' && b.kind === 'hero') return a.playerId === b.playerId
  return false
}

/** chosen 目标校验：必须命中全部 chosen 池的候选交集；detail 携带原因（§3 总则） */
function validateChosenTarget(
  state: GameState,
  actorId: PlayerId,
  def: CardDefinition,
  target: TargetRef | undefined,
): void {
  const pools = chosenPools(def)
  if (pools.length === 0) return // 无 chosen 步骤：多余的 target 宽容忽略
  if (!target) {
    throw new RuleError('INVALID_TARGET', '该牌需要指定一个目标', {
      reason: 'target_required',
      pools,
    })
  }
  for (const pool of pools) {
    const candidates = targetCandidates(state, actorId, pool, null, { respectStealth: true })
    if (!candidates.some((candidate) => sameTarget(candidate, target))) {
      throw new RuleError('INVALID_TARGET', `目标对该牌不可选（pool=${pool}；敌方潜行单位现身前不可被指定）`, {
        reason: 'not_in_pool',
        pool,
        target,
      })
    }
  }
}

/**
 * getLegalActions 的出牌分支：枚举当前可出的全部 PLAY_CARD 动作。
 * 过滤：功耗不足 / gpu·accessory 场满 / 注册表缺失（环境异常，跳过而非崩溃）；
 * chosen 效果牌按候选交集逐目标展开（target_required 的牌在无候选时不产生动作）。
 */
export function legalPlayCardActions(state: Readonly<GameState>, playerId: PlayerId): Action[] {
  const player = state.players[playerId]
  const actions: Action[] = []
  for (const card of player.hand) {
    const def = getCardDefinition(card.cardId)
    if (!def) continue
    if (card.cost > player.mana) continue
    if (def.type !== 'driver' && countOwnUnits(state, playerId) >= BOARD_LIMIT) continue

    const pools = chosenPools(def)
    if (pools.length === 0) {
      actions.push({ type: 'PLAY_CARD', playerId, uid: card.uid })
      continue
    }
    let candidates = targetCandidates(state, playerId, pools[0] as TargetPool, null, {
      respectStealth: true,
    })
    for (const pool of pools.slice(1)) {
      const next = targetCandidates(state, playerId, pool, null, { respectStealth: true })
      candidates = candidates.filter((candidate) => next.some((n) => sameTarget(n, candidate)))
    }
    for (const target of candidates) {
      actions.push({ type: 'PLAY_CARD', playerId, uid: card.uid, target })
    }
  }
  return actions
}
