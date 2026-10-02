/**
 * 引擎实现装配 —— 对外唯一入口 createEngine(): Engine（架构铁律 3：
 * 一切交互经 initGame / applyAction / getLegalActions / viewFor 四函数）。
 *
 * 实现进度：M1-ENG1（回合机）；出牌/攻击/派系技能随 M1-ENG2/3/5 接入。
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
