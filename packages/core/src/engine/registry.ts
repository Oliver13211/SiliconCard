/**
 * 卡牌定义注册表 —— CardDefinition 的运行时注入点。
 *
 * content 包的 JSON 数据在宿主进程启动时 registerCardDefinitions() 进来，
 * 引擎按 cardId 查询基础数值（手牌 cost、出牌类型/效果解析、光环源识别等）。
 *
 * 注册表是环境配置而非对局状态：不进入 GameState、不随状态序列化；
 * 确定性不受影响（同一 content + 同一 seed + 同一动作序列 → 同一状态）。
 *
 * M1-ENG2 补强：findCardDefinitionIssues 对引擎消费的字段做结构校验，
 * initGame 借此拒绝「未注册 / 定义不合法」的卡组（DECK_INVALID）。
 */

import { MAX_MANA } from '../constants'
import type { AuraSpec, CardDefinition, EffectSpec, EffectStep, Keyword, TargetSelector } from '../types/cards'

const registry = new Map<string, CardDefinition>()

/** 批量注册卡牌定义；同 id 重复注册时后写覆盖（便于热更新/测试覆盖） */
export function registerCardDefinitions(defs: readonly CardDefinition[]): void {
  for (const def of defs) registry.set(def.id, def)
}

export function getCardDefinition(cardId: string): CardDefinition | undefined {
  return registry.get(cardId)
}

/** 清空注册表（测试隔离用） */
export function clearCardDefinitions(): void {
  registry.clear()
}

const KNOWN_KEYWORDS: readonly Keyword[] = [
  'taunt',
  'divine_shield',
  'charge',
  'windfury',
  'deathrattle',
  'stealth',
  'overload',
]

const KNOWN_TRIGGERS: readonly EffectSpec['trigger'][] = [
  'battlecry',
  'deathrattle',
  'onPlay',
  'aura',
  'turnStart',
  'turnEnd',
  'onAttack',
  'onDamaged',
]

const KNOWN_POOLS: readonly TargetSelector['pool'][] = [
  'ownHero',
  'enemyHero',
  'ownUnits',
  'enemyUnits',
  'allUnits',
  'anyCharacter',
  'self',
  'sourceOwner',
  'opposingPlayer',
]

export { KNOWN_POOLS }

const KNOWN_AURA_STATS: readonly AuraSpec['stat'][] = ['attack', 'health', 'cost']
const KNOWN_AURA_SCOPES: readonly AuraSpec['scope'][] = ['ownUnits', 'enemyUnits', 'allUnits']

/**
 * 校验卡牌定义中引擎消费的字段（§4 schema 要点），返回第一条问题描述；合法返回 null。
 * 只校验引擎行为依赖（cost/type/attack/health/keywords/effect）与 name/faction 存在性；
 * 纯展示字段（flavor/art/rarity/tags）不在此列。
 */
export function findCardDefinitionIssues(def: CardDefinition): string | null {
  if (typeof def.id !== 'string' || !def.id) return 'id 缺失'
  if (typeof def.name !== 'string' || !def.name) return 'name 缺失'
  if (typeof def.faction !== 'string' || !def.faction) return 'faction 缺失'
  if (def.type !== 'gpu' && def.type !== 'driver' && def.type !== 'accessory') {
    return `未知卡牌类型 ${String(def.type)}`
  }
  if (!Number.isInteger(def.cost) || def.cost < 0 || def.cost > MAX_MANA) {
    return `cost 必须为 0..${MAX_MANA} 的整数`
  }
  if (def.type === 'gpu') {
    if (def.attack === undefined || !Number.isInteger(def.attack) || def.attack < 0) {
      return 'gpu 必须携带非负整数 attack'
    }
    if (def.health === undefined || !Number.isInteger(def.health) || def.health < 1) {
      return 'gpu 必须携带正整数 health'
    }
  } else if (def.attack !== undefined || def.health !== undefined) {
    // §4：attack/health 为 gpu 专属，其余类型出现即 schema 违例
    return `${def.type} 不允许携带 attack/health（§4 schema 违例）`
  }
  for (const keyword of def.keywords ?? []) {
    if (!KNOWN_KEYWORDS.includes(keyword)) return `未知关键词 ${String(keyword)}`
  }
  return findEffectSpecIssues(def.effect)
}

/** 校验 EffectSpec 中引擎消费的字段；派系技能定义（factions.ts）复用 */
export function findEffectSpecIssues(effect: EffectSpec | undefined): string | null {
  if (!effect) return null
  if (!KNOWN_TRIGGERS.includes(effect.trigger)) return `未知效果触发时点 ${String(effect.trigger)}`
  for (const step of effect.steps ?? []) {
    const issue = findEffectStepIssues(step)
    if (issue) return issue
  }
  const aura = effect.aura
  if (aura) {
    if (!KNOWN_AURA_STATS.includes(aura.stat)) return `未知光环属性 ${String(aura.stat)}`
    if (!Number.isInteger(aura.delta)) return '光环 delta 必须为整数'
    if (!KNOWN_AURA_SCOPES.includes(aura.scope)) return `未知光环作用域 ${String(aura.scope)}`
  }
  return null
}

function findEffectStepIssues(step: EffectStep): string | null {
  switch (step.op) {
    case 'damage':
    case 'heal':
      if (!Number.isInteger(step.amount) || step.amount < 0) return `${step.op} amount 必须为非负整数`
      return targetSelectorIssue(step.target)
    case 'buff':
      // buff 允许负值（如「矿难」全场 -2/-2）
      if (step.attack !== undefined && !Number.isInteger(step.attack)) return 'buff attack 必须为整数'
      if (step.health !== undefined && !Number.isInteger(step.health)) return 'buff health 必须为整数'
      return targetSelectorIssue(step.target)
    case 'grantKeyword':
    case 'removeKeyword':
      if (!KNOWN_KEYWORDS.includes(step.keyword)) return `未知关键词 ${String(step.keyword)}`
      return targetSelectorIssue(step.target)
    case 'draw':
      if (!Number.isInteger(step.count) || step.count < 0) return 'draw count 必须为非负整数'
      return null
    case 'summon':
      if (!Number.isInteger(step.count) || step.count < 1) return 'summon count 必须为正整数'
      return null
    case 'destroy':
      return targetSelectorIssue(step.target)
    case 'revive': {
      // 结构校验（TS 类型在编译期把关，content JSON 需运行期闸门，M1-ENG6）
      if (step.pick !== 'lastOwnedGpu' && step.pick !== 'random') {
        return `未知 revive pick ${String(step.pick)}`
      }
      if (step.to !== 'sourceOwnerBoard') return `未知 revive 目标 ${String(step.to)}`
      if (step.count !== undefined && (!Number.isInteger(step.count) || step.count < 1)) {
        return 'revive count 必须为正整数'
      }
      return null
    }
    case 'gainArmor':
    case 'lockMana':
      if (!Number.isInteger(step.amount) || step.amount < 0) return `${step.op} amount 必须为非负整数`
      return null
    case 'handler':
      if (typeof step.name !== 'string' || !step.name) return 'handler name 缺失'
      return null
  }
}

function targetSelectorIssue(selector: TargetSelector): string | null {
  if (selector.kind !== 'chosen' && selector.kind !== 'random' && selector.kind !== 'all') {
    return `未知目标选择器 ${String((selector as { kind?: unknown }).kind)}`
  }
  if (!KNOWN_POOLS.includes(selector.pool)) return `未知目标池 ${String(selector.pool)}`
  // M1-ENG6 additive tag 过滤：出现时必须为非空字符串（卡牌定义 tags 的子类标记）
  if (selector.tag !== undefined && (typeof selector.tag !== 'string' || !selector.tag)) {
    return '目标选择器 tag 必须为非空字符串'
  }
  return null
}
