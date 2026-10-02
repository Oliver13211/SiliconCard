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
 * summon / gainArmor；destroy / revive / lockMana / handler 逃生舱留 M1-ENG6
 * （命中即抛错，宁可响亮失败也不静默吞步骤）。
 */

import type { EffectStep, InstanceId, TargetPool, TargetSelector } from '../types/cards'
import type { DamageSource, GameEvent } from '../types/events'
import type { BoardUnit, GameState, PlayerId, TargetRef } from '../types/state'
import type { Rng } from './prng'
import { getCardDefinition } from './registry'
import { damageHero, drawCard, opponentOf } from './turn'
import { buffUnit, damageUnit, findUnit, healHero, healUnit, summonUnit } from './units'

export interface EffectContext {
  state: GameState
  events: GameEvent[]
  /** 效果结算归属方（出牌者 / 技能使用者） */
  actorId: PlayerId
  /** 效果源实例（gpu/accessory 战吼等）；driver 出牌无源实例为 null */
  sourceUnitId: InstanceId | null
  sourceCardId: string
  rng: Rng
  /** chosen 选择器的目标（来自 PLAY_CARD action.target） */
  chosenTarget: TargetRef | null
}

/** 按数组顺序结算效果步骤（§5：深度优先、单层队列，嵌套触发即同步展开） */
export function resolveEffectSteps(ctx: EffectContext, steps: readonly EffectStep[]): void {
  for (const step of steps) resolveEffectStep(ctx, step)
}

function effectDamageSource(ctx: EffectContext): DamageSource {
  return { kind: 'effect', ref: ctx.sourceCardId }
}

function effectPlayerId(ctx: EffectContext, player: 'sourceOwner' | 'opposingPlayer'): PlayerId {
  return player === 'sourceOwner' ? ctx.actorId : opponentOf(ctx.actorId)
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
          if (unit) damageUnit(ctx.state, unit, step.amount, source, ctx.events)
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
        if (unit) buffUnit(ctx.state, unit, attack, health, ctx.events)
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
    case 'destroy':
    case 'revive':
    case 'lockMana':
      // TODO(M1-ENG6): 实现剩余原语 destroy / revive / lockMana（12VHPWR 熔毁、矿卡重生、跳闸）。
      throw new Error(`效果原语 ${step.op} 属 M1-ENG6 范围，尚未实现`)
    case 'handler':
      // TODO(M1-ENG6): 命名 handler 逃生舱——core/src/effects 按 name 注册后在此分发。
      throw new Error(`handler 逃生舱（${step.name}）属 M1-ENG6 范围，尚未实现`)
  }
}

/** 解析一个目标选择器为具体目标列表（按 board 顺序；random 恰取一枚） */
function resolveSelector(ctx: EffectContext, selector: TargetSelector): TargetRef[] {
  switch (selector.kind) {
    case 'chosen':
      // chosen 由 action.target 携带，合法性已在出牌闸门校验；此处仅映射
      return ctx.chosenTarget ? [ctx.chosenTarget] : []
    case 'random': {
      const candidates = targetCandidates(ctx.state, ctx.actorId, selector.pool, ctx.sourceUnitId)
      if (candidates.length === 0) return [] // 池空不消耗 RNG（状态确定，整体序列仍确定）
      const picked = candidates[ctx.rng.nextInt(candidates.length)]
      return picked ? [picked] : []
    }
    case 'all':
      return targetCandidates(ctx.state, ctx.actorId, selector.pool, ctx.sourceUnitId)
  }
}

/**
 * 目标池候选枚举（§3 总则）：
 * - respectStealth（chosen 校验/枚举用）：过滤「对 actor 隐身」的敌方潜行单位；
 * - 默认不过滤（random / all 等非指定效果可命中潜行单位）；
 * - ownUnits / enemyUnits / allUnits 保持 board 顺序；anyCharacter 在全部单位后
 *   依次追加源拥有者英雄、对手英雄（固定序）。
 */
export function targetCandidates(
  state: Readonly<GameState>,
  actorId: PlayerId,
  pool: TargetPool,
  sourceUnitId: InstanceId | null,
  options: { respectStealth?: boolean } = {},
): TargetRef[] {
  const respectStealth = options.respectStealth ?? false
  const visible = (unit: BoardUnit): boolean =>
    !respectStealth || unit.ownerId === actorId || !unit.keywords.includes('stealth')
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
      return state.board.filter((u) => u.ownerId === actorId && visible(u)).map(toRef)
    case 'enemyUnits':
      return state.board.filter((u) => u.ownerId !== actorId && visible(u)).map(toRef)
    case 'allUnits':
      return state.board.filter((u) => visible(u)).map(toRef)
    case 'anyCharacter':
      return [
        ...state.board.filter((u) => visible(u)).map(toRef),
        heroRef(actorId),
        heroRef(opponentOf(actorId)),
      ]
    case 'self': {
      if (!sourceUnitId) return []
      return state.board.some((u) => u.instanceId === sourceUnitId)
        ? [{ kind: 'unit', instanceId: sourceUnitId }]
        : []
    }
  }
}
