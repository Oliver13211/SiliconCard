/**
 * 触发型效果接线（M1-ENG4）—— deathrattle（蓝屏/传家宝亡语）、onAttack / onDamaged
 * 触发时点与 overload（跳闸）关键词的落地点（docs/rules.md §5 / §7）。
 *
 * - 亡语：removeUnitFromBoard 以阵亡快照调用 resolveDeathrattle（§5：死亡后、进入墓地前；
 *   §7：一次死亡只触发一次，被 destroy 同样触发）。效果上下文 actorId = 阵亡单位拥有者、
 *   sourceUnitId = 阵亡快照 instanceId——单位已离场，self 池自然为空（亡者不可再被指定），
 *   事件的 DamageSource.ref 等载荷携带的正是阵亡时快照（cardId）。
 * - onAttack：攻击宣告（ATTACK_DECLARED）后结算攻击者效果；onDamaged：单位受到实际伤害
 *   且存活时结算（§7 质保完全抵挡、血量归零阵亡均不算"受伤"——阵亡走亡语）。
 * - 触发链（§5 嵌套结算）：深度优先、单层队列，同步递归展开；triggerDepth 计数嵌套层级，
 *   超 TRIGGER_CHAIN_LIMIT 响亮抛错（§5「无限连锁保护」；触发即 content 数据缺陷信号）。
 * - overload（M1-ENG4 裁定）：跳闸数值 N 由卡牌 effect 的 lockMana 步骤给出——打出时随
 *   步骤结算累加 lockedMana（lockMana 原语在 effects.ts 实装，ENG6 范围相应缩减）；
 *   带 overload 关键词但出牌时点（onPlay/battlecry）无 lockMana 步骤的牌按
 *   DEFAULT_OVERLOAD_LOCK 处理，可叠加，下回合 §2.2 BURN_OUT 结算后清零（turn.ts 已有）。
 *   注意：非出牌时点（deathrattle/turnStart/…）触发的 lockMana 步骤不作为 N 的来源
 *   （其步骤不会随出牌结算，若据此豁免兜底会出现"关键词可见却锁定 0W"的空洞）。
 *
 * 边界取舍（详见 M1-ENG4 汇报）：
 *   - 触发型效果没有出牌者输入：chosen 选择器解析为空（content 触发效果应使用
 *     random / all / self 池）；
 *   - buff 致死走 removeUnitFromBoard（无 DAMAGE_DEALT 事件），不触发 onDamaged；
 *   - onAttack / onDamaged 非 §7 关键词，触发本身不发 KEYWORD_TRIGGERED（步骤自产事件）；
 *     deathrattle / overload 是关键词生效，发可读 detail 的事件供战报；
 *   - driver 无场上实例：overload 事件的 instanceId 以手牌 uid 标识来源。
 */

import type { CardDefinition, EffectTrigger, InstanceId } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { BoardUnit, GameState, PlayerId } from '../types/state'
import { resolveEffectSteps, type EffectContext } from './effects'
import type { Rng } from './prng'
import { getCardDefinition } from './registry'

/** 触发链嵌套深度上限（§5 无限连锁保护）：超限响亮失败，不静默截断 */
export const TRIGGER_CHAIN_LIMIT = 100

/** overload 关键词无 lockMana 步骤时的默认锁定功耗（rules.md §7：按新功耗刻度取值） */
export const DEFAULT_OVERLOAD_LOCK = 100

function assertChainDepth(triggerDepth: number): void {
  if (triggerDepth > TRIGGER_CHAIN_LIMIT) {
    throw new Error(
      `触发链深度超过上限 ${TRIGGER_CHAIN_LIMIT}（疑似无限连锁：请检查 content 的 deathrattle / onDamaged 等触发效果是否自激）`,
    )
  }
}

function triggerContext(
  state: GameState,
  events: GameEvent[],
  rng: Rng,
  actorId: PlayerId,
  sourceUnitId: InstanceId | null,
  sourceCardId: string,
  triggerDepth: number,
): EffectContext {
  return {
    state,
    events,
    actorId,
    sourceUnitId,
    sourceCardId,
    rng,
    chosenTarget: null,
    triggerDepth,
  }
}

/**
 * 亡语结算：以阵亡快照解析卡牌定义的 trigger='deathrattle' 步骤并深度优先展开。
 * 由 removeUnitFromBoard 在 MINION_DIED + 移场重算光环之后、进墓地之前调用；
 * 死亡来源（战斗伤害 / buff 致死 / destroy / 效果伤害）全覆盖，一次死亡只触发一次。
 */
export function resolveDeathrattle(
  state: GameState,
  snapshot: BoardUnit,
  events: GameEvent[],
  rng: Rng,
  triggerDepth: number,
): void {
  assertChainDepth(triggerDepth)
  const def = getCardDefinition(snapshot.cardId)
  const effect = def?.effect
  if (!effect || effect.trigger !== 'deathrattle' || !effect.steps?.length) return
  events.push({
    type: 'KEYWORD_TRIGGERED',
    keyword: 'deathrattle',
    instanceId: snapshot.instanceId,
    detail: `蓝屏/传家宝：${def.name}（${snapshot.cardId}）亡语生效`,
  })
  resolveEffectSteps(
    triggerContext(
      state,
      events,
      rng,
      snapshot.ownerId,
      snapshot.instanceId,
      snapshot.cardId,
      triggerDepth + 1,
    ),
    effect.steps,
  )
}

/**
 * 单位触发型效果（onAttack / onDamaged）：解析该单位卡牌定义对应触发时点的步骤。
 * 触发型效果没有出牌者输入：chosen 解析为空、chosenTarget 恒 null。
 */
export function resolveUnitTrigger(
  state: GameState,
  unit: BoardUnit,
  trigger: Extract<EffectTrigger, 'onAttack' | 'onDamaged'>,
  events: GameEvent[],
  rng: Rng,
  triggerDepth: number,
): void {
  assertChainDepth(triggerDepth)
  const effect = getCardDefinition(unit.cardId)?.effect
  if (!effect || effect.trigger !== trigger || !effect.steps?.length) return
  resolveEffectSteps(
    triggerContext(state, events, rng, unit.ownerId, unit.instanceId, unit.cardId, triggerDepth + 1),
    effect.steps,
  )
}

/**
 * overload（跳闸）结算（PLAY_CARD 收尾调用）：带 overload 关键词的牌打出后锁定下回合功耗。
 * N 由卡牌 effect 在出牌时点（onPlay / battlecry）结算的 lockMana 步骤给出（步骤结算时
 * 已累加进 lockedMana，多步即叠加）；出牌时点无有效 lockMana 步骤按 DEFAULT_OVERLOAD_LOCK
 * 兜底（amount ≤ 0 的步骤被解释器忽略，同样不计入）。overload 牌发 KEYWORD_TRIGGERED
 * （detail 供战报）；非 overload 牌的 lockMana 步骤只结算、不发关键词事件。
 */
export function applyOverloadForPlayedCard(
  state: GameState,
  playerId: PlayerId,
  def: CardDefinition,
  sourceUnitId: InstanceId | null,
  handUid: string,
  events: GameEvent[],
): void {
  if (!def.keywords?.includes('overload')) return
  const effect = def.effect
  const resolvesAtPlay = effect !== undefined && (effect.trigger === 'onPlay' || effect.trigger === 'battlecry')
  const hasLockStep =
    resolvesAtPlay &&
    (effect.steps ?? []).some((step) => step.op === 'lockMana' && step.amount > 0)
  if (!hasLockStep) {
    state.players[playerId].lockedMana += DEFAULT_OVERLOAD_LOCK
  }
  events.push({
    type: 'KEYWORD_TRIGGERED',
    keyword: 'overload',
    instanceId: sourceUnitId ?? handUid,
    detail: hasLockStep
      ? '跳闸：下回合功耗被锁定（lockMana 步骤已结算）'
      : `跳闸：下回合锁定 ${DEFAULT_OVERLOAD_LOCK}W 功耗`,
  })
}
