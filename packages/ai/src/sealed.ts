/**
 * 状态封印（防作弊运行时闸门）。
 *
 * 预设硬约束：AI 决策只准经 engine.getLegalActions / engine.viewFor 观察局面，
 * 禁止直接读取 GameState 的任何原始字段（players / board / deck / rng…）。
 *
 * 机制：sealState 用 Proxy 包住 state，任何对顶层字段的属性访问都抛错；
 * player.ts 对传入 state 的唯一用法是 revealState(state) 后交给 engine 四函数
 * ——引擎拿到的是解封原件（合法消费），AI 决策代码一旦直接摸 state 即刻炸出。
 * 自对弈 harness 与防作弊单测经 sealState 注入封印状态，约束从「代码约定」
 * 升级为「测试可证的运行时不变量」。
 *
 * 生产调用方（client / server / harness）传裸 state 即可：revealState 对
 * 非 Proxy 输入是恒等函数，零开销路径。
 */

import type { GameState } from '@siliconcard/core'

/** GameState 的全部顶层字段——AI 视角下一概不可直接读取 */
const FORBIDDEN_KEYS: readonly string[] = [
  'turn',
  'activePlayer',
  'phase',
  'players',
  'board',
  'nextInstanceId',
  'rng',
  'winner',
  'endReason',
]

const rawByProxy = new WeakMap<object, GameState>()

/** 将 state 封印为「只可整体交给引擎」的不透明快照（自对弈 harness / 防作弊测试用） */
export function sealState(state: GameState): GameState {
  const proxy = new Proxy(state, {
    get(target, prop) {
      if (typeof prop === 'string' && FORBIDDEN_KEYS.includes(prop)) {
        throw new Error(
          `AI 作弊拦截：decideNextAction 禁止直接读取 GameState.${prop}（只准经 getLegalActions / viewFor 观察，见 @siliconcard/ai 预设硬约束）`,
        )
      }
      return Reflect.get(target, prop)
    },
  })
  rawByProxy.set(proxy, state)
  return proxy
}

/** 解封：封印快照 → 原件；裸 state → 原样返回（生产路径恒等） */
export function revealState(state: Readonly<GameState>): GameState {
  const raw = rawByProxy.get(state as GameState)
  return raw ?? (state as GameState)
}
