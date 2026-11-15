/**
 * 动作白名单门控（P2-EDU1）—— 可交互性 = getLegalActions 收窄（架构对齐 legal.ts）。
 *
 * 两层收窄职责：
 * 1. gateDecision：UI 入口拦截（tryPlayCard / tryAttack / tryHeroPower / endTurn /
 *    confirmTarget / concede 的包装器先问门控，拦下就出教学提示，不进引擎）；
 * 2. narrowActionTargets：把白名单目标投影进 legalActions（只收窄"目标候选"，
 *    不隐藏可用性——手牌/按钮的禁用原因保持引擎原话，教程提示走气泡）。
 *
 * 门控全部纯函数：输入只有 StepGate（levels 数据）+ view（引擎视图投影）。
 * 原则：门控只"教学性拦截"，绝不制造死局——放行语义宁可 fail-open。
 */

import type { Action, GameEvent, PlayerView, TargetRef } from '@siliconcard/core'
import type { StepGate } from './types'

export interface GateDecision {
  allowed: boolean
  /** 拦截原因（教学提示，气泡区闪红） */
  reason?: string
}

export const DEFAULT_BLOCK_COPY = '先跟着气泡走——这一步还轮不到它'
export const CONCEDE_BLOCK_COPY = '教程里不用拔电源——想重来点「重新来过」就行'

function idAllowed(list: readonly string[] | 'all' | undefined, id: string | null): boolean {
  if (list === undefined || list === 'all') return true
  if (id === null) return true // 归属不明宁可放行（fail-open，不制造假死局）
  return list.includes(id)
}

/** 手牌 uid → cardId（视图投影，不读完整 state） */
export function cardIdByUid(view: PlayerView, uid: string): string | null {
  return view.you.hand.find((card) => card.uid === uid)?.cardId ?? null
}

/** 场上实例 → cardId（视图投影） */
export function cardIdByInstance(view: PlayerView, instanceId: string): string | null {
  return view.board.find((unit) => unit.instanceId === instanceId)?.cardId ?? null
}

/** 出牌门控 */
export function gatePlay(gate: StepGate | undefined, view: PlayerView, uid: string): GateDecision {
  const cardId = cardIdByUid(view, uid)
  if (idAllowed(gate?.allowPlayCardIds, cardId)) return { allowed: true }
  return { allowed: false, reason: gate?.blockCopy ?? DEFAULT_BLOCK_COPY }
}

/** 攻击宣告门控（attackerId 按 cardId 归属） */
export function gateAttack(gate: StepGate | undefined, view: PlayerView, attackerId: string): GateDecision {
  if (idAllowed(gate?.allowAttackCardIds, cardIdByInstance(view, attackerId))) return { allowed: true }
  return { allowed: false, reason: gate?.blockCopy ?? DEFAULT_BLOCK_COPY }
}

/** 派系技能门控 */
export function gateHeroPower(gate: StepGate | undefined): GateDecision {
  if ((gate?.allowHeroPower ?? true) && gate?.allowHeroPower !== false) return { allowed: true }
  return { allowed: false, reason: gate?.blockCopy ?? DEFAULT_BLOCK_COPY }
}

/** 结束回合门控（谓词可表达"素材未到手时放行 / 打出前不许收工"） */
export function gateEndTurn(
  gate: StepGate | undefined,
  view: PlayerView,
  events: readonly GameEvent[] = [],
): GateDecision {
  const allow = gate?.allowEndTurn ? gate.allowEndTurn(view, events) : true
  if (allow) return { allowed: true }
  return { allowed: false, reason: gate?.blockCopy ?? DEFAULT_BLOCK_COPY }
}

/** 目标确认门控（confirmTarget 终闸：候选高亮已被收窄，这里兜底） */
export function gateTarget(gate: StepGate | undefined, view: PlayerView, target: TargetRef): GateDecision {
  const allow = gate?.allowTarget ? gate.allowTarget(target, view) : true
  if (allow) return { allowed: true }
  return { allowed: false, reason: gate?.blockCopy ?? DEFAULT_BLOCK_COPY }
}

/** 认输：教程内一律拦截（失败走「重新来过」，不走对局认输） */
export function gateConcede(): GateDecision {
  return { allowed: false, reason: CONCEDE_BLOCK_COPY }
}

/**
 * 目标候选收窄：step.allowTarget 存在时，把 legalActions 中的 target 候选
 * 裁剪到白名单内（动作本身保留——按钮/手牌可用性不受影响）。
 * 若裁剪后某动作没有任何合法目标，保留动作原样（目标层 fail-open，
 * 由 confirmTarget 终闸兜底），避免目标栏出现"0 个候选"的死提示。
 */
export function narrowActionTargets(gate: StepGate | undefined, actions: readonly Action[], view: PlayerView): Action[] {
  if (!gate?.allowTarget) return [...actions]
  const allowTarget = gate.allowTarget
  return actions.map((action) => {
    switch (action.type) {
      case 'PLAY_CARD':
      case 'ATTACK':
      case 'USE_HERO_POWER': {
        if (!action.target) return action
        return allowTarget(action.target, view) ? action : null
      }
      default:
        return action
    }
  }).filter((action): action is Action => action !== null)
}
