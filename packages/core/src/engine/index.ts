/**
 * 引擎实现装配 —— 对外唯一入口 createEngine(): Engine（架构铁律 3：
 * 一切交互经 initGame / applyAction / getLegalActions / viewFor 四函数）。
 *
 * 实现进度：M1-ENG1（回合机）+ M1-ENG2（出牌结算：PLAY_CARD / 效果解释器 /
 * 光环投影）；攻击（M1-ENG3）/ 关键词系统（M1-ENG4）/ 派系技能（M1-ENG5）后续接入。
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
