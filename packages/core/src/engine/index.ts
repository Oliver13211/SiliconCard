/**
 * 引擎实现装配 —— 对外唯一入口 createEngine(): Engine（架构铁律 3：
 * 一切交互经 initGame / applyAction / getLegalActions / viewFor 四函数）。
 *
 * 实现进度：M1-ENG1（回合机）+ M1-ENG2（出牌结算：PLAY_CARD / 效果解释器 /
 * 光环投影）+ M1-ENG3（攻击结算：ATTACK / taunt / 攻击次数 / 召唤失调）+
 * M1-ENG4（关键词系统：亡语死亡管线 / onAttack·onDamaged 触发 / overload 跳闸 /
 * lockMana 原语，见 triggers.ts）；派系技能（M1-ENG5）后续接入。
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
