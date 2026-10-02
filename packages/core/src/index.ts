/**
 * @siliconcard/core — 无头规则引擎，全项目唯一事实源。
 *
 * 对外契约（架构铁律，违反即打回，见 agent.md 与 docs/rules.md）：
 * - 纯 TypeScript、零运行时依赖；
 * - GameState 是可 JSON 序列化的纯数据；一切随机走种子 RNG；
 * - 一切交互经 Engine 四函数：initGame / applyAction / getLegalActions / viewFor；
 * - 一切产出经 GameEvent 事件流。
 */
export const CORE_VERSION = '0.0.1'

export * from './constants'
export * from './types/cards'
export * from './types/actions'
export * from './types/state'
export * from './types/events'
export * from './engine'
export { createEngine } from './engine/index'
export * from './testing/hash'
export * from './testing/replay'
