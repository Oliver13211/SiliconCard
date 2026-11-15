/**
 * 过关判定与目标进度（P2-EDU1）—— 全部为事件流纯函数。
 *
 * 判定唯一事实源是引擎产出的 GameEvent 序列（架构铁律 3）：不读 store、
 * 不读完整 state，只做事件回放式归纳（实例登记表由 MINION_SUMMONED 事件构建）。
 * 每个判定配正反例单测（__tests__/objectives.test.ts）。
 */

import type { BoardUnit, GameEvent } from '@siliconcard/core'
import { cardIdOfInstance, ownerOfInstance, unitRegistryOf } from './types'

const PLAYER = 'P1'

/** 按回合切段：每个 TURN_START 开启新段（段首即该 TURN_START 事件） */
function segmentsByTurn(events: readonly GameEvent[]): GameEvent[][] {
  const segments: GameEvent[][] = []
  for (const event of events) {
    if (event.type === 'TURN_START' || segments.length === 0) segments.push([])
    segments.at(-1)?.push(event)
  }
  return segments
}

/** 单个 P1 回合段内 P1 打出的卡数（回合段 = 以 P1 的 TURN_START 开头） */
function p1PlaysInSegment(segment: readonly GameEvent[]): number {
  return segment.filter(
    (event) => event.type === 'CARD_PLAYED' && event.playerId === PLAYER,
  ).length
}

/** P1 单回合最多打出几张卡（关1 判定：一个回合内打出 3 张） */
export function maxPlaysInOnePlayerTurn(events: readonly GameEvent[]): number {
  let max = 0
  for (const segment of segmentsByTurn(events)) {
    if (segment[0]?.type === 'TURN_START' && segment[0].playerId === PLAYER) {
      max = Math.max(max, p1PlaysInSegment(segment))
    }
  }
  return max
}

/** 当前 P1 回合已打出几张（目标条"本回合 0/3"） */
export function playsInCurrentPlayerTurn(events: readonly GameEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as GameEvent
    if (event.type === 'TURN_START' && event.playerId === PLAYER) {
      return p1PlaysInSegment(events.slice(i))
    }
  }
  return 0
}

/** 敌方（P2）单位死亡（关2 判定：摧毁敌方一台显卡） */
export function enemyUnitDied(events: readonly GameEvent[]): boolean {
  return events.some((event) => event.type === 'MINION_DIED' && event.unit.ownerId !== PLAYER)
}

/** P1 打出过指定卡（步进判定/判定前置共用） */
export function playerPlayedCard(events: readonly GameEvent[], cardId: string): boolean {
  return events.some((event) => event.type === 'CARD_PLAYED' && event.playerId === PLAYER && event.cardId === cardId)
}

/** P1 使用派系技能次数（关4 判定：善用 3 次） */
export function playerHeroPowerUses(events: readonly GameEvent[]): number {
  return events.filter((event) => event.type === 'HERO_POWER_USED' && event.playerId === PLAYER).length
}

/** P1 在打出来源卡的同回合用该来源单位宣告过攻击（超频判定核心） */
function attackedInSummonTurn(
  events: readonly GameEvent[],
  attackerCardId: string,
  minTimes: number,
): boolean {
  const registry = unitRegistryOf(events)
  for (const segment of segmentsByTurn(events)) {
    if (segment[0]?.type !== 'TURN_START' || segment[0].playerId !== PLAYER) continue
    const attacks = segment.filter((event) => event.type === 'ATTACK_DECLARED')
    const attackedIds = new Set<string>()
    for (const attack of attacks) {
      if (attack.type !== 'ATTACK_DECLARED') continue
      if (cardIdOfInstance(registry, attack.attackerId) === attackerCardId) attackedIds.add(attack.attackerId)
    }
    // 段内该卡的出牌事件存在（同回合召唤）且该召唤实例发起过 ≥minTimes 次攻击
    const playedThisSegment = segment.some(
      (event) => event.type === 'CARD_PLAYED' && event.playerId === PLAYER && event.cardId === attackerCardId,
    )
    if (playedThisSegment && attackedIds.size >= minTimes) return true
  }
  return false
}

/** 指定卡的召唤实例在整段事件流中累计发起攻击次数（风怒判定用，分回合统计） */
function attackCountsBySummonTurn(
  events: readonly GameEvent[],
  attackerCardId: string,
): number[] {
  const registry = unitRegistryOf(events)
  const perTurn: number[] = []
  for (const segment of segmentsByTurn(events)) {
    if (segment[0]?.type !== 'TURN_START' || segment[0].playerId !== PLAYER) continue
    let count = 0
    for (const event of segment) {
      if (event.type === 'ATTACK_DECLARED' && cardIdOfInstance(registry, event.attackerId) === attackerCardId) {
        count += 1
      }
    }
    perTurn.push(count)
  }
  return perTurn
}

// —— 关1..5 判定 ——

/** 关1：一个回合内打出 3 张卡 */
export function level1Objective(events: readonly GameEvent[]): boolean | null {
  return maxPlaysInOnePlayerTurn(events) >= 3 ? true : null
}

/** 关2：摧毁敌方一台显卡（任意击杀路径：技能削血+平砍 / 直接换血均算） */
export function level2Objective(events: readonly GameEvent[]): boolean | null {
  return enemyUnitDied(events) ? true : null
}

/** 关4：善用 3 次派系技能 */
export function level4Objective(events: readonly GameEvent[]): boolean | null {
  return playerHeroPowerUses(events) >= 3 ? true : null
}

// —— 关3 分节判定 ——

/** s1 信仰充值：P2 的攻击被迫打在 P1 的嘲讽单位上（演示"看住了"） */
export function sectionTauntObjective(events: readonly GameEvent[]): boolean | null {
  const registry = unitRegistryOf(events)
  const taunts = new Set(
    [...registry.values()].filter((unit) => unit.ownerId === PLAYER && unit.keywords.includes('taunt')).map((u) => u.instanceId),
  )
  if (taunts.size === 0) return null
  return events.some(
    (event) =>
      event.type === 'ATTACK_DECLARED' &&
      event.target.kind === 'unit' &&
      taunts.has(event.target.instanceId) &&
      ownerOfInstance(registry, event.attackerId) !== PLAYER,
  )
    ? true
    : null
}

/** s2 三年质保：AppleCare+ 打给己方单位后，该护盾真实吃掉一次伤害 */
export function sectionShieldObjective(events: readonly GameEvent[]): boolean | null {
  const playedIndex = events.findIndex(
    (event) => event.type === 'CARD_PLAYED' && event.playerId === PLAYER && event.cardId === 'apple-applecare-plus',
  )
  if (playedIndex === -1) return null
  return events
    .slice(playedIndex + 1)
    .some((event) => event.type === 'DAMAGE_DEALT' && event.shieldConsumed === true && event.target.kind === 'unit')
    ? true
    : null
}

/** s3 超频：天玑 9300 入场当回合即攻击（召唤失调豁免的活演示） */
export function sectionChargeObjective(events: readonly GameEvent[]): boolean | null {
  return attackedInSummonTurn(events, 'arm-dimensity-9300', 1) ? true : null
}

/** s4 双芯 GPU：M1 Ultra 同一回合砍出两刀 */
export function sectionWindfuryObjective(events: readonly GameEvent[]): boolean | null {
  return attackCountsBySummonTurn(events, 'apple-m1-ultra').some((count) => count >= 2) ? true : null
}

/** s5 蓝屏/传家宝：Helio G99 死亡且亡语召唤出公版亮机卡 */
export function sectionDeathrattleObjective(events: readonly GameEvent[]): boolean | null {
  const diedIndex = events.findIndex(
    (event) => event.type === 'MINION_DIED' && event.unit.cardId === 'arm-helio-g99' && event.unit.ownerId === PLAYER,
  )
  if (diedIndex === -1) return null
  return events
    .slice(diedIndex + 1)
    .some(
      (event) =>
        event.type === 'MINION_SUMMONED' &&
        event.source === 'effect' &&
        event.unit.cardId === 'arm-mali-reference' &&
        event.unit.ownerId === PLAYER,
    )
    ? true
    : null
}

/** s6 无输出亮机：玩家用 MacBook Air M2 主动现身（攻击） */
export function sectionStealthObjective(events: readonly GameEvent[]): boolean | null {
  const registry = unitRegistryOf(events)
  return events.some(
    (event) =>
      event.type === 'ATTACK_DECLARED' &&
      cardIdOfInstance(registry, event.attackerId) === 'apple-macbook-air-m2' &&
      ownerOfInstance(registry, event.attackerId) === PLAYER,
  )
    ? true
    : null
}

/** s7 跳闸：Exynos 8895 打出后，下个回合开始吃 BURN_OUT（供电被锁） */
export function sectionOverloadObjective(events: readonly GameEvent[]): boolean | null {
  const playedIndex = events.findIndex(
    (event) => event.type === 'CARD_PLAYED' && event.playerId === PLAYER && event.cardId === 'arm-exynos-8895',
  )
  if (playedIndex === -1) return null
  return events
    .slice(playedIndex + 1)
    .some((event) => event.type === 'BURN_OUT' && event.playerId === PLAYER)
    ? true
    : null
}

/** 单元测试辅助：事件流里登记过的实例快照 */
export function registeredUnitsOf(events: readonly GameEvent[]): BoardUnit[] {
  return [...unitRegistryOf(events).values()]
}
