/**
 * @siliconcard/core — 无头规则引擎，全项目唯一事实源。
 *
 * 设计约束（docs/design-report.md §3.2，违反即打回）：
 * - 纯 TypeScript、零运行时依赖；
 * - (state, action) => { state', events[] }；一切随机走种子 RNG，
 *   seed + 动作序列可完整复现对局；
 * - GameState 是可 JSON 序列化的纯数据；
 * - 对外仅暴露 initGame / applyAction / getLegalActions / viewFor。
 *
 * 首个实现任务：M0-ENG1（类型定义）—— 见 docs/task-breakdown.md
 */
export const CORE_VERSION = '0.0.1'
