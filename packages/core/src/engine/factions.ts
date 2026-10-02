/**
 * 派系技能注册表 —— FactionSkillDefinition 的运行时注入点（docs/rules.md §4 / §8，M1-ENG5）。
 *
 * 「派系技能不是卡牌」（§4）：由 factions/<id>.json 定义
 * { factionId, skillName, skillId, cost, effect: EffectSpec }，宿主启动时
 * registerFactionSkills() 注入；引擎按 PlayerState.faction 查询技能，经
 * USE_HERO_POWER 结算（heroPower.ts）。
 *
 * 注册表是环境配置而非对局状态：不进入 GameState、不随状态序列化；
 * 确定性不受影响（同一技能注册 + 同一 seed + 同一动作序列 → 同一状态）。
 *
 * 内置默认技能：§8 M1 前四系（nvidia/amd/intel/neutral）的数据在
 * factions/builtin.ts，于本模块加载时自动注册——core 自带的测试 / 黄金回放 /
 * fuzz 均使用这些派系，initGame 的「双方 faction 必须已注册技能」校验因此开箱即用；
 * content 包就绪后可对同 factionId 后写覆盖（与卡牌注册表同语义）。
 */

import { MAX_MANA } from '../constants'
import { BUILTIN_FACTION_SKILLS } from '../factions/builtin'
import type { EffectSpec, TargetPool } from '../types/cards'
import { findEffectSpecIssues, KNOWN_POOLS } from './registry'

/**
 * 派系技能定义（§4 既定形态；types/ 契约未收录，属 core 内部注入 API，
 * content 包 JSON 校验通过本结构）。
 */
export interface FactionSkillDefinition {
  /** 派系 id，与 PlayerState.faction / CardDefinition.faction 同一命名空间 */
  factionId: string
  /** 展示名（如「开光追试试」） */
  skillName: string
  /** 技能稳定 id（HERO_POWER_USED.skillId 携带，全局唯一） */
  skillId: string
  /** 功耗（W）；内置四技能均为 HERO_POWER_COST（§1/§3） */
  cost: number
  /** 技能效果：USE_HERO_POWER 时点结算，trigger 统一约定 'onPlay' */
  effect: EffectSpec
  /**
   * 目标池声明（M1-ENG5）：effect.steps 内的 chosen 选择器决定默认目标池；
   * 当 chosen 藏在 handler 步骤里（如 ray_tracing_try 的命中判定）时，
   * handler 步骤无 target 字段无法声明——由本字段显式补 declaring，
   * USE_HERO_POWER 闸门与 getLegalActions 枚举按同一池校验/展开（§3 目标合法性总则）。
   */
  targetPool?: TargetPool
}

const registry = new Map<string, FactionSkillDefinition>()
/** skillId → factionId 归属（HERO_POWER_USED.skillId 是事件契约，必须全局可归因） */
const skillIdOwners = new Map<string, string>()

/**
 * 批量注册派系技能；同 factionId 重复注册时后写覆盖（便于热更新/测试覆盖）。
 * 同一 skillId 被两个不同 factionId 声明属数据缺陷（事件无法归因），响亮抛错。
 */
export function registerFactionSkills(defs: readonly FactionSkillDefinition[]): void {
  for (const def of defs) {
    const issue = findFactionSkillIssues(def)
    if (issue) {
      throw new Error(`派系技能定义不合法（${def.factionId ?? '<无 factionId>'}）：${issue}`)
    }
    const previousOwner = skillIdOwners.get(def.skillId)
    if (previousOwner !== undefined && previousOwner !== def.factionId) {
      throw new Error(
        `skillId ${def.skillId} 已被派系 ${previousOwner} 注册，不能同时归属派系 ${def.factionId}（HERO_POWER_USED.skillId 需全局可归因）`,
      )
    }
    const previous = registry.get(def.factionId)
    if (previous && previous.skillId !== def.skillId) skillIdOwners.delete(previous.skillId)
    registry.set(def.factionId, def)
    skillIdOwners.set(def.skillId, def.factionId)
  }
}

export function getFactionSkill(factionId: string): FactionSkillDefinition | undefined {
  return registry.get(factionId)
}

/** 清空注册表并重新注册内置四系技能（测试隔离用：clear 后恢复 §8 基线） */
export function resetFactionSkills(): void {
  clearFactionSkills()
  registerFactionSkills(BUILTIN_FACTION_SKILLS)
}

/** 清空注册表（测试隔离用；initGame 将拒绝未注册派系） */
export function clearFactionSkills(): void {
  registry.clear()
  skillIdOwners.clear()
}

// —— 结构校验（仿 findCardDefinitionIssues：只校验引擎行为依赖的字段） ——

/**
 * 校验派系技能定义中引擎消费的字段，返回第一条问题描述；合法返回 null。
 * trigger 强制 'onPlay'：USE_HERO_POWER 时点结算的唯一约定（§3 表格无独立触发时点，
 * 复用 onPlay 语义「动作结算时立即生效」，避免 content 误标 battlecry/deathrattle）。
 */
export function findFactionSkillIssues(def: FactionSkillDefinition): string | null {
  if (!def || typeof def !== 'object') return '定义缺失'
  if (typeof def.factionId !== 'string' || !def.factionId) return 'factionId 缺失'
  if (typeof def.skillId !== 'string' || !def.skillId) return 'skillId 缺失'
  if (typeof def.skillName !== 'string' || !def.skillName) return 'skillName 缺失'
  if (!Number.isInteger(def.cost) || def.cost < 0 || def.cost > MAX_MANA) {
    return `cost 必须为 0..${MAX_MANA} 的整数`
  }
  const effect = def.effect
  if (!effect || typeof effect !== 'object') return 'effect 缺失'
  if (effect.trigger !== 'onPlay') {
    return `派系技能 effect.trigger 必须为 'onPlay'（USE_HERO_POWER 时点结算约定），收到 ${String(effect.trigger)}`
  }
  if (def.targetPool !== undefined && !KNOWN_POOLS.includes(def.targetPool)) {
    return `未知 targetPool ${String(def.targetPool)}`
  }
  return findEffectSpecIssues(effect)
}

// —— 内置基线：模块加载即注册（理由见文件头） ——

registerFactionSkills(BUILTIN_FACTION_SKILLS)
