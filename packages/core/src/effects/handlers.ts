/**
 * M1-ENG5 接线首个 handler：ray_tracing_try（开光追试试的 30% 失败判定）。
 * M1-ENG6 增补 double_attack（攻击翻倍，§2.5 示例牌「DLSS 4」/帧生成）。
 *
 * 模块加载即注册内置 handler（与卡牌/派系技能注册表同模式）；宿主可用
 * registerEffectHandler 追加。注册表是环境配置而非对局状态，不随状态序列化。
 */

import type { DamageSource } from '../types/events'
import type { EffectContext } from '../engine/effects'
import { damageHero } from '../engine/turn'
import { buffUnit, damageUnit, findUnit } from '../engine/units'

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
 *   **光追失败事件定稿（M1-ENG7 契约评审裁决：维持借位）**：keyword 取 'overload'
 *   （跳闸）——「开光追把机器整跳闸」与失败演出梗义完全贴合；instanceId 以 skillId
 *   标识（技能无场上实例）；消费端以 detail:'光追失败' 分流（KEYWORD_TRIGGERED 本就是
 *   「关键词特效 + detail 战报」双通道）。评审结论：不为单一技能的失败演出扩目录
 *   （17→18 会诱发 content 逐技能要专属事件，目录应保持封闭原语集）；借位的唯一代价
 *   是 keyword 字段语义外溢（统计 overload 次数需按 detail 过滤），v1 无此分析需求。
 *   定稿记录见 rules.md §5，下游（client-ui / client-3d）已随 M1-ENG7 汇报通报。
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
  registerEffectHandler('double_attack', doubleAttack)
}

/**
 * double_attack（M1-ENG6）：目标单位攻击翻倍（§2.5 示例牌「DLSS 4」，帧生成）。
 *
 * - **翻倍式 buff**：delta = 当前有效攻击（含光环贡献），经 buffUnit 走既有永久
 *   增益通道（attack 下限 0、无目录事件）——0 攻单位翻倍无事发生；
 * - **目标**：chosen 目标（出牌闸门已校验池/tag/潜行）；触发型效果 chosen 恒空 →
 *   无事发生（与 ray_tracing_try 的触发误用同取舍）；
 * - **边界裁定（详见 M1-ENG6 汇报）**：设计文案「本回合攻击翻倍」的时效性在 v1
 *   不可表达——GameState 无临时增益字段（契约外），buff 为永久增量。本 handler
 *   按永久翻倍实装，"到回合末衰减"需要契约提案（临时 buff 机制），见遗留问题。
 */
function doubleAttack(ctx: EffectContext): void {
  const target = ctx.chosenTarget
  if (!target || target.kind !== 'unit') return
  const unit = findUnit(ctx.state, target.instanceId)
  if (!unit) return // 结算中途已阵亡
  buffUnit(ctx.state, unit, unit.attack, 0, ctx.events, ctx.rng, ctx.triggerDepth ?? 0)
}

registerBuiltinEffectHandlers()
