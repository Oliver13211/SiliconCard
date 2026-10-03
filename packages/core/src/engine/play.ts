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
 * → battlecry/onPlay 步骤结算（effect 解释器，§5 全部 12 种原语，M1-ENG6 补全
 *   destroy / revive）→ overload 跳闸锁定（M1-ENG4）→ 胜负判定。
 *
 * 边界取舍（详见 M1-ENG2 汇报）：accessory 出牌后进场上（占扩展槽、受
 * BOARD_LIMIT 限制、按 0/1 身板入场、不可攻击），在场期间光环常驻。
 */

import { BOARD_LIMIT } from '../constants'
import { RuleError } from '../engine'
import type { Action } from '../types/actions'
import type { EffectStep, InstanceId, TargetPool, TargetSelector } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { GameState, HandCard, PlayerId, TargetRef } from '../types/state'
import { applyHandCosts } from './aura'
import { resolveEffectSteps, targetCandidates, type EffectContext } from './effects'
import type { Rng } from './prng'
import { getCardDefinition } from './registry'
import { checkGameEnd } from './turn'
import { applyOverloadForPlayedCard } from './triggers'
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
  validateChosenTargetAgainstSteps(state, action.playerId, def.effect?.steps, action.target, '该牌')
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

  // overload（跳闸，M1-ENG4）：带 overload 关键词的牌打出后锁定下回合功耗——
  // N 由 effect 的 lockMana 步骤给出（上方步骤结算时已累加 lockedMana），
  // 无 lockMana 步骤按默认值兜底；裁定细节见 triggers.ts 与 M1-ENG4 汇报。
  applyOverloadForPlayedCard(state, action.playerId, def, sourceUnitId, action.uid, events)
  // handler 逃生舱 / destroy / revive 等剩余原语经 resolveEffectSteps 结算（M1-ENG6 全量接通）

  checkGameEnd(state, events)
}

/** 收集效果步骤中全部 chosen 选择器（M1-ENG6：携带 tag 子类过滤，v1 出牌仅携带单目标） */
export function chosenSelectorsOfSteps(steps: readonly EffectStep[] | undefined): TargetSelector[] {
  const selectors: TargetSelector[] = []
  for (const step of steps ?? []) {
    if ('target' in step && step.target.kind === 'chosen') selectors.push(step.target)
  }
  return selectors
}

/** 收集效果步骤中全部 chosen 选择器的目标池（多池取交集，v1 出牌仅携带单目标） */
export function chosenPoolsOfSteps(steps: readonly EffectStep[] | undefined): TargetPool[] {
  return chosenSelectorsOfSteps(steps).map((selector) => selector.pool)
}

export function sameTarget(a: TargetRef, b: TargetRef): boolean {
  if (a.kind === 'unit' && b.kind === 'unit') return a.instanceId === b.instanceId
  if (a.kind === 'hero' && b.kind === 'hero') return a.playerId === b.playerId
  return false
}

/**
 * chosen 目标校验（对选择器集合；M1-ENG6 起为基准实现）：
 * 必须命中全部选择器候选的交集（池 + 可选 tag 子类过滤 + 敌方潜行过滤）；
 * detail 携带原因（§3 总则）。subject 为错误消息主语（出牌『该牌』/ 技能『技能「清灰」』）。
 */
export function validateChosenTargetInSelectors(
  state: GameState,
  actorId: PlayerId,
  selectors: readonly TargetSelector[],
  target: TargetRef | undefined,
  subject: string,
): void {
  if (selectors.length === 0) return // 无 chosen 步骤：多余的 target 宽容忽略
  if (!target) {
    throw new RuleError('INVALID_TARGET', `${subject}需要指定一个目标`, {
      reason: 'target_required',
      pools: selectors.map((selector) => selector.pool),
    })
  }
  for (const selector of selectors) {
    const candidates = targetCandidates(state, actorId, selector.pool, null, {
      respectStealth: true,
      tag: selector.tag,
    })
    if (!candidates.some((candidate) => sameTarget(candidate, target))) {
      throw new RuleError(
        'INVALID_TARGET',
        `目标对${subject}不可选（pool=${selector.pool}${selector.tag ? `；tag=${selector.tag}` : ''}；敌方潜行单位现身前不可被指定）`,
        {
          reason: 'not_in_pool',
          pool: selector.pool,
          ...(selector.tag ? { tag: selector.tag } : {}),
          target,
        },
      )
    }
  }
}

/** chosen 目标校验（对目标池集合；heroPower 等无 tag 场景的池粒度入口） */
export function validateChosenTargetInPools(
  state: GameState,
  actorId: PlayerId,
  pools: readonly TargetPool[],
  target: TargetRef | undefined,
  subject: string,
): void {
  validateChosenTargetInSelectors(
    state,
    actorId,
    pools.map((pool) => ({ kind: 'chosen', pool })),
    target,
    subject,
  )
}

/** chosen 目标校验（对效果步骤集合）：选择器取步骤内全部 chosen（含 tag） */
export function validateChosenTargetAgainstSteps(
  state: GameState,
  actorId: PlayerId,
  steps: readonly EffectStep[] | undefined,
  target: TargetRef | undefined,
  subject: string,
): void {
  validateChosenTargetInSelectors(state, actorId, chosenSelectorsOfSteps(steps), target, subject)
}

/** chosen 选择器交集的目标枚举（M1-ENG6 起为基准实现）：逐候选展开，潜行与 tag 过滤开启 */
export function expandChosenTargetsOfSelectors(
  state: Readonly<GameState>,
  actorId: PlayerId,
  selectors: readonly TargetSelector[],
): TargetRef[] {
  if (selectors.length === 0) return []
  // 三种选择器变体共享 pool/tag 字段：统一按候选枚举后取交集
  const candidatesOf = (selector: TargetSelector): TargetRef[] =>
    targetCandidates(state, actorId, selector.pool, null, {
      respectStealth: true,
      tag: selector.tag,
    })
  const [first, ...rest] = selectors
  let candidates = first ? candidatesOf(first) : []
  for (const selector of rest) {
    const next = candidatesOf(selector)
    candidates = candidates.filter((candidate) => next.some((n) => sameTarget(n, candidate)))
  }
  return candidates
}

/** chosen 池交集的目标枚举（getLegalActions 出牌 / 派系技能分支共用）：潜行过滤开启 */
export function expandChosenTargets(
  state: Readonly<GameState>,
  actorId: PlayerId,
  pools: readonly TargetPool[],
): TargetRef[] {
  return expandChosenTargetsOfSelectors(
    state,
    actorId,
    pools.map((pool) => ({ kind: 'chosen', pool })),
  )
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

    const selectors = chosenSelectorsOfSteps(def.effect?.steps)
    if (selectors.length === 0) {
      actions.push({ type: 'PLAY_CARD', playerId, uid: card.uid })
      continue
    }
    for (const target of expandChosenTargetsOfSelectors(state, playerId, selectors)) {
      actions.push({ type: 'PLAY_CARD', playerId, uid: card.uid, target })
    }
  }
  return actions
}
