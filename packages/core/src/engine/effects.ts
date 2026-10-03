/**
 * 效果解释器核心（docs/rules.md §5，M1-ENG2 范围）。
 *
 * - EffectStep 按数组顺序逐步结算；每步产生对应目录事件（伤害→DAMAGE_DEALT 等）；
 * - TargetSelector：chosen（出牌 action.target 携带，合法性在出牌闸门校验）/
 *   random（引擎种子 RNG）/ all；
 * - 随机语义：按步骤数组顺序、目标池按 board 顺序（anyCharacter 的英雄排在全部
 *   单位之后，先源拥有者后对手——确定性固定序）；池为空时不消耗 RNG；
 * - 潜行（§7）：「不可被指定」只约束玩家指定（chosen 的合法性校验与枚举），
 *   random / all 类非指定效果照常命中——与「指定」语义一致的边界取舍；
 * - buff / grantKeyword / removeKeyword 无对应目录事件，改动经状态可见。
 *
 * M1-ENG2 覆盖原语：damage / heal / buff / grantKeyword / removeKeyword / draw /
 * summon / gainArmor；M1-ENG4 增补：lockMana（跳闸数值通道，overload 关键词裁定见
 * triggers.ts）。M1-ENG5 接线 handler 逃生舱（§5 命名 handler，注册表见
 * effects/handlers.ts，首个内置 handler 为开光追试试 ray_tracing_try）；
 * M1-ENG6 补全剩余原语：destroy（§7 质保不抵挡，经 removeUnitFromBoard(cause
 * 'destroy') 走既有死亡管线：亡语触发、进墓地、光环重算）与 revive（从 sourceOwner
 * 墓地复活，pick: lastOwnedGpu | random；新实例语义见 reviveFromGraveyard）。
 * 至此 §5 的 12 种原语全部实装。
 */

import type { CardType, EffectStep, InstanceId, TargetPool, TargetSelector } from '../types/cards'
import type { DamageSource, GameEvent } from '../types/events'
import type { BoardUnit, GameState, PlayerId, TargetRef } from '../types/state'
import { BOARD_LIMIT } from '../constants'
import { getEffectHandler } from '../effects/handlers'
import type { Rng } from './prng'
import { getCardDefinition } from './registry'
import { damageHero, drawCard, opponentOf } from './turn'
import { buffUnit, countOwnUnits, damageUnit, findUnit, healHero, healUnit, removeUnitFromBoard, summonUnit } from './units'

export interface EffectContext {
  state: GameState
  events: GameEvent[]
  /** 效果结算归属方（出牌者 / 技能使用者 / 触发效果的单位拥有者） */
  actorId: PlayerId
  /** 效果源实例（gpu/accessory 战吼等）；driver 出牌或亡语快照外无源实例为 null */
  sourceUnitId: InstanceId | null
  sourceCardId: string
  rng: Rng
  /** chosen 选择器的目标（来自 PLAY_CARD action.target；触发型效果恒 null） */
  chosenTarget: TargetRef | null
  /**
   * 触发链嵌套深度（M1-ENG4）：顶层动作效果为 0（缺省），每进入一层触发结算 +1；
   * 传给伤害/增益原语，供死亡管线与 onDamaged 触发续接（上限见 triggers.ts）。
   */
  triggerDepth?: number
  /**
   * 伤害归因覆盖（M1-ENG5）：缺省 { kind:'effect', ref: sourceCardId }；
   * 派系技能（USE_HERO_POWER）传 { kind:'heroPower', playerId }——§6 事件目录
   * 的技能伤害归因通道，dust_off / 光追命中的 DAMAGE_DEALT 由此携带。
   */
  damageSource?: DamageSource
}

/** 按数组顺序结算效果步骤（§5：深度优先、单层队列，嵌套触发即同步展开） */
export function resolveEffectSteps(ctx: EffectContext, steps: readonly EffectStep[]): void {
  for (const step of steps) resolveEffectStep(ctx, step)
}

function effectDamageSource(ctx: EffectContext): DamageSource {
  return ctx.damageSource ?? { kind: 'effect', ref: ctx.sourceCardId }
}

function effectPlayerId(ctx: EffectContext, player: 'sourceOwner' | 'opposingPlayer'): PlayerId {
  return player === 'sourceOwner' ? ctx.actorId : opponentOf(ctx.actorId)
}

/** revive 原语只捞回显卡（§2.5 两张复活示例牌均为「复活显卡」；配件不可复活，边界裁定见汇报） */
const REVIVE_CARD_TYPE: CardType = 'gpu'

/**
 * 从 sourceOwner（actorId）墓地复活一张显卡（M1-ENG6）。
 *
 * 边界裁定（详见 M1-ENG6 汇报）：
 * - **只捞 gpu**：墓地条目经卡牌定义解析类型，非显卡（accessory）跳过——两张复活
 *   示例牌（矿卡重生 / 性价比真香）语义均为「复活显卡」，lastOwnedGpu 命名同此口径；
 * - **lastOwnedGpu**：墓地按死亡顺序追加，取末位 = 最近死亡的显卡；**random**：
 *   种子 RNG 选一（候选为 gpu 条目，board 无关、按墓地顺序固定候选序）；
 *   墓地无显卡时返回 false 且**不消耗 RNG**（与 resolveSelector 池空语义一致）；
 * - **新实例**：经 summonUnit 复活为全新在场实例——新 instanceId、summoning
 *   sickness 重置、keywords/身板从卡牌定义恢复、光环随 withBoardAuras 重算；
 *   阵亡时快照与永久 buff 不带回（死亡即清零，复活 ≠ 治疗在场单位）；
 * - **场满静默截断**：己方场上已满（BOARD_LIMIT）时不召唤、不消墓地、不消耗 RNG
 *   （既有「效果召唤场满静默截断」取舍），返回 false 终止本次 revive；
 * - **复活即离墓**：墓地 =「当前处于死亡状态」的单位集合（graveyardSize 对外
 *   计数保持真实）；复活后再死亡会作为新条目重新入墓，不产生重复条目。
 *
 * @returns 是否实际复活了一张（false = 墓地无显卡或场满）
 */
function reviveFromGraveyard(ctx: EffectContext, pick: 'lastOwnedGpu' | 'random'): boolean {
  const player = ctx.state.players[ctx.actorId]
  // 场满前置检查：与「效果召唤场满静默截断」同语义——不召唤、不消墓地、不消耗 RNG
  if (countOwnUnits(ctx.state, ctx.actorId) >= BOARD_LIMIT) return false
  const candidates = player.graveyard.filter(
    (entry) => getCardDefinition(entry.cardId)?.type === REVIVE_CARD_TYPE,
  )
  if (candidates.length === 0) return false
  const picked =
    pick === 'lastOwnedGpu'
      ? candidates[candidates.length - 1]
      : candidates[ctx.rng.nextInt(candidates.length)]
  if (!picked) return false
  const def = getCardDefinition(picked.cardId)
  if (!def) return false
  const unit = summonUnit(ctx.state, ctx.actorId, def, ctx.events, 'effect')
  if (!unit) return false // 双保险（召唤中途场满的理论兜底）：墓地条目保留，复活未发生
  player.graveyard = player.graveyard.filter((entry) => entry !== picked)
  return true
}

function resolveEffectStep(ctx: EffectContext, step: EffectStep): void {
  switch (step.op) {
    case 'damage': {
      if (step.amount <= 0) return
      const source = effectDamageSource(ctx)
      for (const target of resolveSelector(ctx, step.target)) {
        if (target.kind === 'unit') {
          const unit = findUnit(ctx.state, target.instanceId)
          // 结算中途已阵亡的目标自动跳过（池每步按当前状态重新解析）
          if (unit) damageUnit(ctx.state, unit, step.amount, source, ctx.events, ctx.rng, ctx.triggerDepth ?? 0)
        } else {
          damageHero(ctx.state, target.playerId, step.amount, source, ctx.events)
        }
      }
      return
    }
    case 'heal': {
      for (const target of resolveSelector(ctx, step.target)) {
        if (target.kind === 'unit') {
          const unit = findUnit(ctx.state, target.instanceId)
          if (unit) healUnit(unit, step.amount, ctx.events)
        } else {
          healHero(ctx.state, target.playerId, step.amount, ctx.events)
        }
      }
      return
    }
    case 'buff': {
      const attack = step.attack ?? 0
      const health = step.health ?? 0
      if (attack === 0 && health === 0) return
      for (const target of resolveSelector(ctx, step.target)) {
        // buff 只作用于场上单位（CPU 无攻血属性，命中即跳过）
        if (target.kind !== 'unit') continue
        const unit = findUnit(ctx.state, target.instanceId)
        if (unit) buffUnit(ctx.state, unit, attack, health, ctx.events, ctx.rng, ctx.triggerDepth ?? 0)
      }
      return
    }
    case 'grantKeyword': {
      for (const target of resolveSelector(ctx, step.target)) {
        if (target.kind !== 'unit') continue
        const unit = findUnit(ctx.state, target.instanceId)
        if (unit && !unit.keywords.includes(step.keyword)) {
          unit.keywords = [...unit.keywords, step.keyword]
        }
      }
      return
    }
    case 'removeKeyword': {
      for (const target of resolveSelector(ctx, step.target)) {
        if (target.kind !== 'unit') continue
        const unit = findUnit(ctx.state, target.instanceId)
        if (unit) unit.keywords = unit.keywords.filter((k) => k !== step.keyword)
      }
      return
    }
    case 'draw': {
      const playerId = effectPlayerId(ctx, step.player)
      for (let i = 0; i < step.count; i++) drawCard(ctx.state, playerId, ctx.events)
      return
    }
    case 'summon': {
      for (let i = 0; i < step.count; i++) {
        const def = getCardDefinition(step.cardId)
        if (!def) throw new Error(`summon 原语引用未注册的卡牌定义 ${step.cardId}（content 数据错误）`)
        if (def.type !== 'gpu') throw new Error(`summon 原语仅支持 gpu，卡牌 ${step.cardId} 类型为 ${def.type}`)
        // 场满时 summonUnit 返回 null：召唤静默截断（§5 嵌套结算的既定语义）
        summonUnit(ctx.state, ctx.actorId, def, ctx.events, 'effect')
      }
      return
    }
    case 'gainArmor': {
      if (step.amount <= 0) return
      const playerId = effectPlayerId(ctx, step.player)
      const player = ctx.state.players[playerId]
      player.armor += step.amount
      ctx.events.push({ type: 'ARMOR_GAINED', playerId, amount: step.amount, totalArmor: player.armor })
      return
    }
    case 'lockMana': {
      // 跳闸锁定（M1-ENG4 提前实装，ENG6 范围缩减）：累加进目标方 lockedMana，
      // 下回合 §2.2 BURN_OUT 结算后清零；可叠加（多张/多步累加）。无目录事件——
      // overload 关键词的生效由 play.ts 经 applyOverloadForPlayedCard 发 KEYWORD_TRIGGERED。
      if (step.amount <= 0) return
      const playerId = effectPlayerId(ctx, step.player)
      ctx.state.players[playerId].lockedMana += step.amount
      return
    }
    case 'destroy': {
      // 摧毁（§7）：三年质保不抵挡 destroy/移除类效果；照常走死亡管线
      // （MINION_DIED cause='destroy' → 移场重算光环 → 亡语 → 进墓地）。
      // 英雄目标跳过（摧毁 CPU 非规则书语义，胜负只由 §9 血量/认输通道裁决）。
      for (const target of resolveSelector(ctx, step.target)) {
        if (target.kind !== 'unit') continue
        const unit = findUnit(ctx.state, target.instanceId)
        // 结算中途已阵亡的目标自动跳过（池每步按当前状态重新解析）
        if (unit) removeUnitFromBoard(ctx.state, unit, 'destroy', ctx.events, ctx.rng, ctx.triggerDepth ?? 0)
      }
      return
    }
    case 'revive': {
      // 复活（M1-ENG6）：从 sourceOwner 墓地捞回显卡，count 次或 until 池空/场满。
      for (let i = 0; i < (step.count ?? 1); i++) {
        if (!reviveFromGraveyard(ctx, step.pick)) break
      }
      return
    }
    case 'handler': {
      // 命名 handler 逃生舱（§5，M1-ENG5 接线）：注册表见 effects/handlers.ts。
      // 未注册的 name 属 content 数据缺陷或未实装，响亮抛错，不静默吞步骤。
      const handler = getEffectHandler(step.name)
      if (!handler) {
        throw new Error(`效果 handler「${step.name}」未注册（core/src/effects/handlers.ts §5 逃生舱）`)
      }
      handler(ctx)
      return
    }
  }
}

/**
 * 解析一个目标选择器为具体目标列表（按 board 顺序；random 恰取一枚）。
 * selector.tag（M1-ENG6 additive）：非空时按卡牌定义 tags 过滤候选（chosen 的
 * tag 合法性在出牌闸门校验，此处 random / all 直接生效）。
 */
function resolveSelector(ctx: EffectContext, selector: TargetSelector): TargetRef[] {
  switch (selector.kind) {
    case 'chosen':
      // chosen 由 action.target 携带，合法性已在出牌闸门校验；此处仅映射
      return ctx.chosenTarget ? [ctx.chosenTarget] : []
    case 'random': {
      const candidates = targetCandidates(ctx.state, ctx.actorId, selector.pool, ctx.sourceUnitId, {
        tag: selector.tag,
      })
      if (candidates.length === 0) return [] // 池空不消耗 RNG（状态确定，整体序列仍确定）
      const picked = candidates[ctx.rng.nextInt(candidates.length)]
      return picked ? [picked] : []
    }
    case 'all':
      return targetCandidates(ctx.state, ctx.actorId, selector.pool, ctx.sourceUnitId, {
        tag: selector.tag,
      })
  }
}

/**
 * 目标池候选枚举（§3 总则）：
 * - respectStealth（chosen 校验/枚举用）：过滤「对 actor 隐身」的敌方潜行单位；
 * - 默认不过滤（random / all 等非指定效果可命中潜行单位）；
 * - tag（M1-ENG6）：非空时仅保留卡牌定义 tags 含该标记的单位——英雄无卡牌定义，
 *   tag 过滤下天然排除；
 * - ownUnits / enemyUnits / allUnits 保持 board 顺序；anyCharacter 在全部单位后
 *   依次追加源拥有者英雄、对手英雄（固定序）。
 */
export function targetCandidates(
  state: Readonly<GameState>,
  actorId: PlayerId,
  pool: TargetPool,
  sourceUnitId: InstanceId | null,
  options: { respectStealth?: boolean; tag?: string } = {},
): TargetRef[] {
  const respectStealth = options.respectStealth ?? false
  const tag = options.tag
  const visible = (unit: BoardUnit): boolean =>
    !respectStealth || unit.ownerId === actorId || !unit.keywords.includes('stealth')
  const tagged = (unit: BoardUnit): boolean =>
    !tag || (getCardDefinition(unit.cardId)?.tags?.includes(tag) ?? false)
  const toRef = (unit: BoardUnit): TargetRef => ({ kind: 'unit', instanceId: unit.instanceId })
  const heroRef = (playerId: PlayerId): TargetRef => ({ kind: 'hero', playerId })

  switch (pool) {
    case 'ownHero':
    case 'sourceOwner':
      return [heroRef(actorId)]
    case 'enemyHero':
    case 'opposingPlayer':
      return [heroRef(opponentOf(actorId))]
    case 'ownUnits':
      return state.board.filter((u) => u.ownerId === actorId && visible(u) && tagged(u)).map(toRef)
    case 'enemyUnits':
      return state.board.filter((u) => u.ownerId !== actorId && visible(u) && tagged(u)).map(toRef)
    case 'allUnits':
      return state.board.filter((u) => visible(u) && tagged(u)).map(toRef)
    case 'anyCharacter': {
      const units = state.board.filter((u) => visible(u) && tagged(u)).map(toRef)
      // tag 过滤下英雄不可命中（无卡牌定义、无 tags），池收窄为纯单位列表
      if (tag) return units
      return [...units, heroRef(actorId), heroRef(opponentOf(actorId))]
    }
    case 'self': {
      if (!sourceUnitId) return []
      const self = state.board.find((u) => u.instanceId === sourceUnitId)
      if (!self || !tagged(self)) return []
      return [{ kind: 'unit', instanceId: sourceUnitId }]
    }
  }
}
