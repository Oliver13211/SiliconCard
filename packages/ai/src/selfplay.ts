/**
 * 自对弈 harness（M1-AI1 核心验收工具）。
 *
 * 双方各挂一个 AI 实例、同一引擎实例、可配 seed 的确定性对局循环：
 * 引擎实例与 state 由本 harness 持有，AI 只经 decideNextAction(engine, state)
 * 观察（内部走 getLegalActions + viewFor），harness 侧做三重护栏：
 * 1. 成员校验：AI 返回的动作必须是当前合法动作集的成员（JSON 深比较），
 *    违例计入 illegalActions 并以 END_TURN 兜底继续；
 * 2. 引擎闸门：applyAction 抛 RuleError（理论不可能，AI 只从合法集里选）
 *    计入 illegalActions 并以 END_TURN 兜底继续——单点 bug 不放大成连环崩溃；
 * 3. 动作上限：单局动作数到 maxActions 仍未见胜负则标记 timedOut（判平处理），
 *    防 死循环拖垮测试。
 *
 * 确定性：同 seed → 同对局（双方 AI 决策种子由 game seed 派生，见 deriveAiSeed）。
 * 复用场景：M1 验收测试、M2-NET3 服务端虚拟玩家的离线回归、M4 平衡管线。
 */

import type {
  Action,
  DeckSpec,
  Engine,
  FactionId,
  GameSetup,
  GameState,
  PlayerId,
} from '@siliconcard/core'
import { RuleError } from '@siliconcard/core'
import { makeAiDeckSpec } from './cardPool'
import { createAiPlayer, type AiPlayer, type Difficulty } from './player'
import { deriveAiSeed } from './rng'

/** 单局动作数上限（防死循环；正常对局远低于此值） */
export const DEFAULT_MAX_ACTIONS = 2000

export interface SelfPlaySideConfig {
  difficulty?: Difficulty
  faction?: FactionId
  deck?: DeckSpec
}

export interface SelfPlayConfig {
  /** 对局种子（引擎 RNG 基准；AI 决策种子由它确定性派生） */
  seed: number
  /** 单局动作数上限，缺省 2000 */
  maxActions?: number
  /** 双方各自的难度 / 派系 / 卡组（缺省：Normal、镜像合成卡组、P1 nvidia / P2 amd） */
  sides?: { P1?: SelfPlaySideConfig; P2?: SelfPlaySideConfig }
}

export interface SelfPlayResult {
  seed: number
  /** null = 平局（同时归零或打满动作上限） */
  winner: PlayerId | null
  endReason: 'health_zero' | 'concede' | null
  /** 终局全局回合号 */
  turns: number
  actionsApplied: number
  /** 达到动作上限仍未分出胜负（验收要求记录比例，理想为 0） */
  timedOut: boolean
  /** AI 选出非法动作的次数（验收要求为 0） */
  illegalActions: number
  /** 其它异常事件（AI 返回 null 等，验收要求为空） */
  anomalies: string[]
  /** 逐动作 JSON 记录（确定性回归 / 调试用） */
  actionLog: string[]
}

function actionKey(action: Action): string {
  return JSON.stringify(action)
}

function isActionInList(action: Action, legal: readonly Action[]): boolean {
  const key = actionKey(action)
  return legal.some((candidate) => actionKey(candidate) === key)
}

function endTurnOf(legal: readonly Action[], playerId: PlayerId): Action {
  return (
    legal.find((a): a is Extract<Action, { type: 'END_TURN' }> => a.type === 'END_TURN') ?? {
      type: 'END_TURN',
      playerId,
    }
  )
}

/**
 * 跑一局完整自对弈。未捕获异常直接向外抛（「零崩溃」由调用方测试以
 * 不抛异常断言）；AI 层面的非法操作被计数兜底（「零非法操作」以计数为 0 断言）。
 */
export function runSelfPlayGame(engine: Engine, config: SelfPlayConfig): SelfPlayResult {
  const maxActions = config.maxActions ?? DEFAULT_MAX_ACTIONS
  const sides = config.sides ?? {}
  const setup: GameSetup = {
    seed: config.seed,
    players: [
      {
        id: 'P1',
        faction: sides.P1?.faction ?? 'nvidia',
        deck: sides.P1?.deck ?? makeAiDeckSpec(),
      },
      {
        id: 'P2',
        faction: sides.P2?.faction ?? 'amd',
        deck: sides.P2?.deck ?? makeAiDeckSpec(),
      },
    ],
  }

  let state: GameState = engine.initGame(setup)
  const ais: Record<PlayerId, AiPlayer> = {
    P1: createAiPlayer({
      playerId: 'P1',
      difficulty: sides.P1?.difficulty ?? 'normal',
      seed: deriveAiSeed(config.seed, 'P1'),
    }),
    P2: createAiPlayer({
      playerId: 'P2',
      difficulty: sides.P2?.difficulty ?? 'normal',
      seed: deriveAiSeed(config.seed, 'P2'),
    }),
  }

  const anomalies: string[] = []
  const actionLog: string[] = []
  let actionsApplied = 0
  let illegalActions = 0
  let timedOut = false

  /** 兜底收尾：结算一个 END_TURN 并推进状态；失败（对局已结束）返回 false */
  const forceEndTurn = (playerId: PlayerId): boolean => {
    const legal = engine.getLegalActions(state, playerId)
    if (legal.length === 0) return false
    const fallback = endTurnOf(legal, playerId)
    state = engine.applyAction(state, fallback).state
    actionsApplied += 1
    actionLog.push(actionKey(fallback))
    return true
  }

  while (state.phase !== 'ended') {
    if (actionsApplied >= maxActions) {
      timedOut = true
      break
    }
    const who = state.activePlayer
    const legal = engine.getLegalActions(state, who)
    if (legal.length === 0) {
      anomalies.push(`turn ${state.turn}: ${who} 无合法动作却未终局`)
      break
    }

    let action = ais[who].decideNextAction(engine, state)
    if (!action) {
      anomalies.push(`turn ${state.turn}: ${who} 的 AI 在其行动回合返回 null`)
      action = endTurnOf(legal, who)
    } else if (!isActionInList(action, legal)) {
      illegalActions += 1
      anomalies.push(`turn ${state.turn}: ${who} 的 AI 选出合法集之外的动作 ${actionKey(action)}`)
      action = endTurnOf(legal, who)
    }

    try {
      state = engine.applyAction(state, action).state
      actionsApplied += 1
      actionLog.push(actionKey(action))
    } catch (error) {
      if (!(error instanceof RuleError)) throw error // 非 RuleError 属环境/引擎 bug，响亮外抛
      illegalActions += 1
      anomalies.push(
        `turn ${state.turn}: ${who} 的动作被引擎拒绝（${error.code}）${actionKey(action)}`,
      )
      if (!forceEndTurn(who)) break
    }
  }

  return {
    seed: config.seed,
    winner: state.winner,
    endReason: state.endReason,
    turns: state.turn,
    actionsApplied,
    timedOut,
    illegalActions,
    anomalies,
    actionLog,
  }
}
