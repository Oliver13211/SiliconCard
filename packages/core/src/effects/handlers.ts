/**
 * 命名 handler 逃生舱（docs/rules.md §5）—— EffectStep 原语组合表达不了的逻辑，
 * 在 core/src/effects/ 按 name 注册，经 { op: 'handler', name } 引用；注册处必须配单测。
 *
 * M1-ENG5 接线首个 handler：ray_tracing_try（开光追试试的 30% 失败判定）。
 * M1-ENG6 将继续接入 content 侧 handler（如「12VHPWR 熔毁」特殊条件）。
 *
 * 模块加载即注册内置 handler（与卡牌/派系技能注册表同模式）；宿主可用
 * registerEffectHandler 追加。注册表是环境配置而非对局状态，不随状态序列化。
 */

import type { DamageSource } from '../types/events'
import type { EffectContext } from '../engine/effects'
import { damageHero } from '../engine/turn'
import { damageUnit, findUnit } from '../engine/units'

export type EffectHandler = (ctx: EffectContext) => void

const handlers = new Map<string, EffectHandler>()

/** 注册命名 handler；同 name 重复注册时后写覆盖（便于热更新/测试覆盖） */
export function registerEffectHandler(name: string, handler: EffectHandler): void {
  if (typeof name !== 'string' || !name) {
    throw new Error('registerEffectHandler: name 必须为非空字符串')
  }
  if (typeof handler !== 'function') {
    throw new Error(`registerEffectHandler: handler ${name} 必须为函数`)
  }
  handlers.set(name, handler)
}

export function getEffectHandler(name: string): EffectHandler | undefined {
  return handlers.get(name)
}

/** 清空注册表（测试隔离用；内置 handler 由 resetBuiltinEffectHandlers 恢复） */
export function clearEffectHandlers(): void {
  handlers.clear()
}

/** 清空后重新注册内置 handler（测试隔离用） */
export function resetEffectHandlers(): void {
  clearEffectHandlers()
  registerBuiltinEffectHandlers()
}

// —— 内置 handler ——

/** 开光追试试命中判定阈值（docs/rules.md §8：RNG < 0.7 成功） */
export const RAY_TRACING_SUCCESS_RATE = 0.7

/**
 * ray_tracing_try（amd 派系技能「开光追试试」，§8）：
 *
 * - **RNG 语义（确定性契约）**：无论成败，每次调用恰好消耗一次 rng.nextFloat()——
 *   判定先行、目标缺席（触发型误用）也不例外，保证「seed + 动作序列」下 RNG 流
 *   只由动作次数决定，不因结果分支漂移；
 * - 命中（roll < 0.7）：对 chosen 目标结算 1 点伤害，DamageSource = heroPower
 *   （§6 事件目录的技能伤害归因）；
 * - 失败：发 KEYWORD_TRIGGERED{detail:'光追失败'} 且**无事发生**（不改任何状态）。
 *   keyword 取值属边界裁定：事件目录 Keyword 为封闭七值、types/ 契约本次不动，
 *   取 'overload'（跳闸）——「开光追把机器整跳闸」的梗最贴合失败演出，且不携带
 *   deathrattle 的死亡语义；真实语义由 detail 携带供 UI 分流。instanceId 以
 *   skillId 标识（技能无场上实例）。若 UI 需要独立演出，走 WF-ENGINE 提案扩目录。
 */
function rayTracingTry(ctx: EffectContext): void {
  const roll = ctx.rng.nextFloat()
  const target = ctx.chosenTarget
  if (!target) return // 技能路径 chosen 校验保证有目标；触发型误用（chosen 恒空）则无事发生
  if (roll < RAY_TRACING_SUCCESS_RATE) {
    const source: DamageSource = ctx.damageSource ?? { kind: 'heroPower', playerId: ctx.actorId }
    if (target.kind === 'unit') {
      const unit = findUnit(ctx.state, target.instanceId)
      if (unit) damageUnit(ctx.state, unit, 1, source, ctx.events, ctx.rng, ctx.triggerDepth ?? 0)
    } else {
      damageHero(ctx.state, target.playerId, 1, source, ctx.events)
    }
    return
  }
  ctx.events.push({
    type: 'KEYWORD_TRIGGERED',
    keyword: 'overload',
    instanceId: ctx.sourceCardId,
    detail: '光追失败',
  })
}

function registerBuiltinEffectHandlers(): void {
  registerEffectHandler('ray_tracing_try', rayTracingTry)
}

registerBuiltinEffectHandlers()
