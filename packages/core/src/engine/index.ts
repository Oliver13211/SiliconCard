/**
 * 引擎实现装配 —— 对外唯一入口 createEngine(): Engine（架构铁律 3：
 * 一切交互经 initGame / applyAction / getLegalActions / viewFor 四函数）。
 *
 * 实现进度（引擎链 M1-ENG1..7 已闭环，见 docs/task-breakdown.md 与各任务汇报）：
 * ENG1 回合机 / ENG2 出牌结算 / ENG3 攻击结算 / ENG4 关键词与死亡管线 /
 * ENG5 派系技能 / ENG6 效果原语全量（12 种）与回合时点触发 /
 * ENG7 胜负收口终审（endgame.test.ts）+ 回放序列化（testing/replaySerialize）+
 * 黄金基线锁定（__golden__/，四局风格各异，CI 即门禁）。
 */

import type { Engine } from '../engine'
import { applyAction, getLegalActions } from './apply'
import { initGame } from './init'
import { viewFor } from './view'

/** 创建无头规则引擎实例 */
export function createEngine(): Engine {
  return {
    initGame,
    applyAction,
    getLegalActions,
    viewFor,
  }
}
