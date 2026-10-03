/**
 * @siliconcard/core — 无头规则引擎，全项目唯一事实源。
 *
 * 对外契约（架构铁律，违反即打回，见 AGENTS.md 与 docs/rules.md）：
 * - 纯 TypeScript、零运行时依赖；
 * - GameState 是可 JSON 序列化的纯数据；一切随机走种子 RNG；
 * - 一切交互经 Engine 四函数：initGame / applyAction / getLegalActions / viewFor；
 * - 一切产出经 GameEvent 事件流。
 */
export const CORE_VERSION = '0.1.0' // M1-ENG7：引擎链（ENG1..7）闭环

export * from './constants'
export * from './types/cards'
export * from './types/actions'
export * from './types/state'
export * from './types/events'
export * from './engine'
export { createEngine } from './engine/index'
// —— 派系技能注册（M1-ENG5）：宿主注入/覆盖派系技能（内置四系见 factions/builtin.ts，
// 随 engine/factions.ts 模块加载自动注册；content 包就绪后同 factionId 后写覆盖）——
export {
  registerFactionSkills,
  getFactionSkill,
  clearFactionSkills,
  resetFactionSkills,
  findFactionSkillIssues,
} from './engine/factions'
export type { FactionSkillDefinition } from './engine/factions'
// —— 卡牌定义注册表（M1-ENG2 宿主注入点）：与派系技能注入同模式 additive 导出
// （经编排方授权补导出面，M1-UI1..3；WF-ENGINE additive，由编排方向下游通报）——
export {
  registerCardDefinitions,
  getCardDefinition,
  clearCardDefinitions,
  findCardDefinitionIssues,
} from './engine/registry'
// —— 命名 handler 逃生舱（§5）：content 侧特殊逻辑按 name 注册后经 { op:'handler' } 引用 ——
export { registerEffectHandler } from './effects/handlers'
export type { EffectHandler } from './effects/handlers'
export * from './testing/hash'
export * from './testing/replay'
// —— 回放序列化（M1-ENG7）：ReplayRecording ⇄ JSON（seed+actions 存档/分享/回放地基）——
export * from './testing/replaySerialize'
