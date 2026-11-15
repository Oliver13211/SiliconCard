/**
 * 教程引导流驱动器（测试 harness）—— 以"玩家视角"走完每关的引导路径：
 * 每次迭代只消费最新帧（view + legalActions）与当前步骤门控，
 * 决策纯靠门控语义（不做任何引擎外窥探），用于验证每个 seed 的关卡
 * 确实可被真实玩家按气泡完成。与 flow.test.ts 配套。
 */

import { expect, vi } from 'vitest'
import type { Action, GameEvent, PlayerView } from '@siliconcard/core'
import { TutorialController } from '../controller'
import { gateAttack, gateEndTurn, gateHeroPower, gatePlay } from '../gates'
import type { TutorialLevel, TutorialSection } from '../types'

export interface FlowHarness {
  controller: TutorialController
  latest: () => { view: PlayerView; legalActions: readonly Action[] } | null
  events: () => readonly GameEvent[]
}

/** 建立控制器 + 帧捕获（fake timers 由调用方装配） */
export function createHarness(): FlowHarness {
  const controller = new TutorialController()
  let last: { view: PlayerView; legalActions: readonly Action[] } | null = null
  const events: GameEvent[] = []
  controller.onFrame((frame) => {
    last = { view: frame.view, legalActions: frame.legalActions }
    events.push(...frame.events)
  })
  return {
    controller,
    latest: () => last,
    events: () => events,
  }
}

/**
 * 玩家决策（对齐 TutorialScreen 气泡语义的自动化走法）：
 * 1. 结束回合被门控拦下 → 依次尝试 技能 → 攻击 → 出牌（白名单内首选项）；
 * 2. 结束回合放行 → （eagerSkill 策略）技能 → 显式攻击步骤的攻击 → 出牌
 *    （显式白名单优先，否则打最贵的付得起卡——"攒钱上大件"走法）→ 收工。
 */
export function decidePlayerAction(
  harness: FlowHarness,
  options: { eagerSkill?: boolean } = {},
): Action | null {
  const { controller } = harness
  const frame = harness.latest()
  if (!frame) return null
  const { view, legalActions } = frame
  const gate = controller.currentGate()
  const events = harness.events()

  const endTurnAllowed = gateEndTurn(gate, view, events).allowed
  const legalSkill = legalActions.find((action) => action.type === 'USE_HERO_POWER')
  const legalAttacks = legalActions.filter((action) => action.type === 'ATTACK')
  const legalPlays = legalActions.filter((action) => action.type === 'PLAY_CARD')

  const attackAllowedList = Array.isArray(gate?.allowAttackCardIds)
  const playAllowedList = Array.isArray(gate?.allowPlayCardIds)
  const pickAttack = (): Action | null => {
    for (const attack of legalAttacks) {
      if (attack.type !== 'ATTACK') continue
      if (gateAttack(gate, view, attack.attackerId).allowed) return attack
    }
    return null
  }
  const pickPlay = (explicitOnly: boolean): Action | null => {
    const allowList = gate?.allowPlayCardIds
    const explicit = Array.isArray(allowList) ? allowList : null
    // 只挑白名单放行的牌（玩家视角：灰的牌点不动）
    const playable = legalPlays.filter(
      (play) => play.type === 'PLAY_CARD' && gatePlay(gate, view, play.uid).allowed,
    )
    if (explicit) {
      // 显式白名单逆序优先（后面的条目通常是本步真正等的大件素材）
      for (let i = explicit.length - 1; i >= 0; i -= 1) {
        const wanted = explicit[i] as string
        for (const play of playable) {
          if (play.type !== 'PLAY_CARD') continue
          const cardId = view.you.hand.find((card) => card.uid === play.uid)?.cardId
          if (cardId === wanted) return play
        }
      }
      if (explicitOnly) return null
    }
    if (explicitOnly) return null
    // 自由出牌：最贵优先（"攒钱上大件"走法；便宜卡连拍同样能达成连打目标）
    let best: Action | null = null
    let bestCost = -1
    for (const play of playable) {
      if (play.type !== 'PLAY_CARD') continue
      const card = view.you.hand.find((entry) => entry.uid === play.uid)
      const cost = card?.cost ?? 0
      if (cost > bestCost) {
        bestCost = cost
        best = play
      }
    }
    return best
  }

  // 1) 被拦下不许收工 → 门控在等一个"该做"的动作；
  //    优先级按门控提示：显式出牌清单 = 等素材上机；显式攻击清单 = 等这一刀；
  //    都没有 = 等技能。
  if (!endTurnAllowed) {
    if (playAllowedList) {
      const play = pickPlay(false)
      if (play) return play
    }
    if (attackAllowedList) {
      const attack = pickAttack()
      if (attack) return attack
    }
    if (legalSkill && gateHeroPower(gate).allowed) return legalSkill
    const attack = pickAttack()
    if (attack) return attack
    const play = pickPlay(false)
    if (play) return play
    // 门控拦截却无路可走：宁可信引擎收工（不应发生，出现即测试红）
    return { type: 'END_TURN', playerId: 'P1' }
  }

  // 2) 自由回合
  if (options.eagerSkill && legalSkill && gateHeroPower(gate).allowed) return legalSkill
  if (attackAllowedList) {
    const attack = pickAttack()
    if (attack) return attack
  }
  const play = pickPlay(false)
  if (play) return play
  return { type: 'END_TURN', playerId: 'P1' }
}

/** 跑完整引导流；过关/终局即停。返回实际动作数。 */
export async function runGuidedFlow(
  harness: FlowHarness,
  level: TutorialLevel,
  section: TutorialSection | null,
  options: { maxActions?: number; eagerSkill?: boolean } = {},
): Promise<number> {
  const { maxActions = 220, eagerSkill = false } = options
  harness.controller.startLevel(level, section, 'neutral')
  let count = 0
  for (let i = 0; i < maxActions; i += 1) {
    const status = harness.controller.status()
    if (status.phase === 'passed' || status.phase === 'failed') return count
    const action = decidePlayerAction(harness, { eagerSkill })
    if (!action) return count
    count += 1
    const result = harness.controller.dispatchPlayerAction(action)
    expect(result.ok, `动作被引擎拒绝：${result.error ?? ''}（${JSON.stringify(action)}）`).toBe(true)
    if (action.type === 'END_TURN') {
      // 等脚本对手整回合落地（每动作 650ms；带超时防死循环）
      for (let wait = 0; wait < 24; wait += 1) {
        await vi.advanceTimersByTimeAsync(650)
        const frame = harness.latest()
        if (!frame || frame.view.activePlayer === 'P1') break
        if (harness.controller.status().phase !== 'running') break
      }
    }
  }
  return count
}

/** 断言过关（事件流判定真实触发） */
export function expectPassed(harness: FlowHarness): void {
  const status = harness.controller.status()
  expect(status.phase, `期望过关，实际 ${status.phase}（stepIndex=${status.stepIndex}）`).toBe('passed')
}
