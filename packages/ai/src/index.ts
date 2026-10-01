/**
 * @siliconcard/ai — 内置人机（启发式）。
 *
 * 硬约束：只通过 core 公开接口博弈（getLegalActions + viewFor），
 * 禁止读取完整 GameState 作弊。难度分级 = 评估深度 / 噪声。
 *
 * 首个实现任务：M1-AI1 —— 见 docs/task-breakdown.md
 */
export const AI_VERSION = '0.0.1'
