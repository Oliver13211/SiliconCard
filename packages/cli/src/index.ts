/**
 * @siliconcard/cli — Agent 对战接口（JSON 行协议）。
 *
 * 硬约束：站在"从没见过这个游戏的外部 agent"视角设计——
 * 输出 { state, legalActions } 自解释，接收 { action }，
 * 错误信息必须能指导 agent 自行重试。
 *
 * 首个实现任务：M3-AGT1 —— 见 docs/task-breakdown.md
 */
export const CLI_VERSION = '0.0.1'
