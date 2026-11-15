/**
 * 电费抵扣券单测（P2-ENG1，验收标准对照 docs/phase2-plan.md §P2-ENG1）：
 * 1. P2 起手 3+1（券）、P1 无券；
 * 2. 券打出后本回合供电 +40W（gainMana 原语可越 MAX_MANA 上限；量纲经 2026-11-15 bench 校准）；
 * 3. 回合结束未使用则失效消失（自身第 1 回合结束；过期不进墓地、无结算）；
 * 4. 券不进牌库（不可被抽牌复制）、uid 独立命名空间（旧回放兼容不变量）；
 * 5. 确定性：同 seed 两次 initGame 状态一致；
 * 6. 事件流：打出批次（CARD_PLAYED + 过期 CARD_BURNED）正确且恰一次；
 *    发放事件（CARD_DRAWN{source:'coin_grant'}）属 initGame 开局语义时点
 *    （同 GAME_START 裁决：initGame 不携带事件流，消费方从初始视图合成），
 *    引擎侧以「券恰一张」状态不变量锁定（见各用例断言）。
 */

import { describe, expect, it } from 'vitest'
import { MAX_MANA, OPENING_HAND_SIZE, VOUCHER_BONUS, VOUCHER_CARD_ID, VOUCHER_UID } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { GameEvent } from '../types/events'
import {
  catchRuleError,
  makeDeckSpec,
  makeGameState,
  makeSetup,
  makePlayer,
  SMOKE_GPU,
  TEST_SEED,
} from '../testing/state'
import { stableHash } from '../testing/hash'
import { createEngine } from './index'
import { initGame } from './init'
import { clearCardDefinitions, findCardDefinitionIssues, getCardDefinition, registerCardDefinitions } from './registry'
import { VOUCHER_DEFINITION, isVoucherRegistered, resetVoucherDefinition } from './voucher'

const engine = createEngine()

function voucherInHand(state: ReturnType<typeof initGame>): number {
  return state.players.P2.hand.filter((c) => c.cardId === VOUCHER_CARD_ID).length
}

/** P2 走到自身第 1 回合（P1 END_TURN 一次 → 全局 turn 2） */
function toP2FirstTurn(): ReturnType<typeof initGame> {
  let state = initGame(makeSetup())
  state = engine.applyAction(state, { type: 'END_TURN', playerId: 'P1' }).state
  return state
}

describe('电费抵扣券：定义注册（P2-ENG1）', () => {
  it('券定义随 core 装配入口自动注册，且通过 findCardDefinitionIssues 结构校验', () => {
    expect(isVoucherRegistered()).toBe(true)
    expect(getCardDefinition(VOUCHER_CARD_ID)).toEqual(VOUCHER_DEFINITION)
    expect(findCardDefinitionIssues(VOUCHER_DEFINITION)).toBeNull()
  })

  it('注册表清空后可强制恢复（测试隔离语义），恢复后定义仍合法；本用例自行恢复缺省测试卡', () => {
    clearCardDefinitions()
    expect(getCardDefinition(VOUCHER_CARD_ID)).toBeUndefined()
    resetVoucherDefinition()
    registerCardDefinitions([SMOKE_GPU]) // 恢复 testing/state 的缺省卡，避免污染同文件后续用例
    expect(isVoucherRegistered()).toBe(true)
  })

  it('券为 driver：cost 0、不占扩展槽、onPlay 走 gainMana 原语（VOUCHER_BONUS=40）', () => {
    const def = VOUCHER_DEFINITION
    expect(def.type).toBe('driver')
    expect(def.cost).toBe(0)
    expect(def.effect?.trigger).toBe('onPlay')
    expect(def.effect?.steps).toEqual([{ op: 'gainMana', player: 'sourceOwner', amount: VOUCHER_BONUS }])
    expect(VOUCHER_BONUS).toBe(40)
    // cost 校验豁免说明：findCardDefinitionIssues 实际区间为 0..MAX_MANA（registry.ts），
    // cost 0 天然放行，无需为本卡开特例（任务书预估的 [100,1000] 区间与现状不符，见汇报）
  })
})

describe('电费抵扣券：initGame 起手发放（验收 1）', () => {
  it('P2 起手 3+1（券在末位、uid vc1）；P1 无券；双方牌库均不含券', () => {
    const state = initGame(makeSetup())
    expect(state.players.P1.hand.filter((c) => c.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
    expect(voucherInHand(state)).toBe(1)
    const p2hand = state.players.P2.hand
    expect(p2hand).toHaveLength(OPENING_HAND_SIZE + 1)
    expect(p2hand[OPENING_HAND_SIZE]).toMatchObject({ uid: VOUCHER_UID, cardId: VOUCHER_CARD_ID, cost: 0 })
    // 不占卡组名额、不可被抽牌复制：双方牌库零券
    expect(state.players.P1.deck.filter((e) => e.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
    expect(state.players.P2.deck.filter((e) => e.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
  })

  it('uid 独立命名空间：券不消耗 nextInstanceId 全局游标（旧回放兼容的关键不变量）', () => {
    const state = initGame(makeSetup())
    // 6 张起手 h1..h6 → 游标 7，与一期引擎逐字节一致
    expect(state.nextInstanceId).toBe(7)
    expect(VOUCHER_UID).not.toMatch(/^h\d+$/)
    expect(VOUCHER_UID).not.toMatch(/^u\d+$/)
  })

  it('确定性：同 seed 两次 initGame 状态哈希一致；券在场不影响该性质', () => {
    const a = initGame(makeSetup(TEST_SEED))
    const b = initGame(makeSetup(TEST_SEED))
    expect(stableHash(a)).toBe(stableHash(b))
    expect(a.players.P2.hand).toEqual(b.players.P2.hand)
    // 异 seed：起手牌不同但券恒在（发放与 rng 无关）
    const c = initGame(makeSetup(TEST_SEED + 1))
    expect(voucherInHand(c)).toBe(1)
  })
})

describe('电费抵扣券：打出结算（验收 1/2）', () => {
  it('P2 第 1 回合打出券：mana 100 → 140（+40）；CARD_PLAYED 恰一次、cost 0', () => {
    let state = toP2FirstTurn()
    expect(state.players.P2.mana).toBe(100) // 自身第 1 回合供电曲线 100W
    expect(voucherInHand(state)).toBe(1)
    const result = engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: VOUCHER_UID })
    state = result.state
    expect(state.players.P2.mana).toBe(100 + VOUCHER_BONUS)
    expect(state.players.P2.maxMana).toBe(100) // 曲线不动：加成只作用于当回合 mana
    const played = result.events.filter((e) => e.type === 'CARD_PLAYED')
    expect(played).toEqual([
      { type: 'CARD_PLAYED', playerId: 'P2', uid: VOUCHER_UID, cardId: VOUCHER_CARD_ID, cost: 0, target: null },
    ])
    expect(voucherInHand(state)).toBe(0) // 打出即离手
    expect(state.players.P2.graveyard.filter((e) => e.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
  })

  it('gainMana 原语可越 MAX_MANA： mana > 1000W 时照常累加（唯一越限通道）', () => {
    // 直构高供电局面验证原语语义（真实对局中券仅在自身第 1 回合在场，达不到上限；
    // 越限语义是 rules.md §5 的原语级承诺，单元级锁定）
    const highDef: CardDefinition = {
      id: 'test-voucher-clone', name: '测试券', faction: 'neutral', type: 'driver', cost: 0,
      effect: { trigger: 'onPlay', steps: [{ op: 'gainMana', player: 'sourceOwner', amount: VOUCHER_BONUS }] },
    }
    registerCardDefinitions([highDef])
    const state = makeGameState({
      turn: 2,
      activePlayer: 'P2',
      players: {
        P1: makePlayer('P1'),
        P2: makePlayer('P2', {
          mana: MAX_MANA, // 已在上限
          maxMana: MAX_MANA,
          hand: [{ uid: 'h-big', cardId: 'test-voucher-clone', cost: 0 }],
        }),
      },
    })
    const result = engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: 'h-big' })
    expect(result.state.players.P2.mana).toBe(MAX_MANA + VOUCHER_BONUS)
    expect(result.state.players.P2.mana).toBeGreaterThan(MAX_MANA)
  })

  it('非当前行动方 / 他人回合打出券被拒绝（NOT_YOUR_TURN），状态原样保留', () => {
    const state = initGame(makeSetup()) // turn 1 = P1 回合
    const error = catchRuleError(() =>
      engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: VOUCHER_UID }),
    )
    expect(error.code).toBe('NOT_YOUR_TURN')
    expect(voucherInHand(state)).toBe(1)
  })

  it('getLegalActions 在 P2 第 1 回合枚举券（功耗足、driver 不占槽）；过期回合后不再枚举', () => {
    const state = toP2FirstTurn()
    const plays = engine
      .getLegalActions(state, 'P2')
      .filter((a): a is Extract<ReturnType<typeof engine.getLegalActions>[number], { type: 'PLAY_CARD' }> => a.type === 'PLAY_CARD')
    expect(plays.some((a) => a.uid === VOUCHER_UID)).toBe(true)
    // 过期后：券离手，天然不再枚举（下一回合券已消失）
    const after = engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: VOUCHER_UID }).state
    const afterEnd = engine.applyAction(after, { type: 'END_TURN', playerId: 'P2' }).state
    expect(afterEnd.players.P2.hand.some((c) => c.uid === VOUCHER_UID)).toBe(false)
  })
})

describe('电费抵扣券：过期（验收 1：回合结束未用消失）', () => {
  it('P2 自身第 1 回合结束未打出：券消失、CARD_BURNED{voucher_expired} 恰一次、不进墓地', () => {
    const state = toP2FirstTurn()
    const result = engine.applyAction(state, { type: 'END_TURN', playerId: 'P2' })
    const expired = result.events.filter((e) => e.type === 'CARD_BURNED')
    expect(expired).toEqual([
      { type: 'CARD_BURNED', playerId: 'P2', cardId: VOUCHER_CARD_ID, reason: 'voucher_expired' },
    ])
    expect(result.state.players.P2.hand.some((c) => c.cardId === VOUCHER_CARD_ID)).toBe(false)
    expect(result.state.players.P2.graveyard.filter((e) => e.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
  })

  it('打出后回合结束不再发过期事件（一次性语义）；第 2+ 自身回合结束不再触发过期', () => {
    const state = toP2FirstTurn()
    const played = engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: VOUCHER_UID }).state
    const endEvents = engine.applyAction(played, { type: 'END_TURN', playerId: 'P2' }).events
    expect(endEvents.filter((e) => e.type === 'CARD_BURNED')).toHaveLength(0)
    // turn 3 = P1 回合 → turn 4 = P2 自身第 2 回合：过期门槛（自身第 1 回合）不再命中
    const afterP2 = engine.applyAction(played, { type: 'END_TURN', playerId: 'P2' }).state
    const afterP1 = engine.applyAction(afterP2, { type: 'END_TURN', playerId: 'P1' }).state
    const p2Events = engine.applyAction(afterP1, { type: 'END_TURN', playerId: 'P2' }).events
    expect(p2Events.filter((e) => e.type === 'CARD_BURNED' && e.reason === 'voucher_expired')).toHaveLength(0)
  })

  it('先手方回合结束不触发过期（P1 从不持券；门槛=自身第 1 回合）', () => {
    const state = initGame(makeSetup())
    const result = engine.applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(result.events.filter((e) => e.type === 'CARD_BURNED' && 'reason' in e && e.reason === 'voucher_expired')).toHaveLength(0)
    expect(voucherInHand(result.state)).toBe(1) // P2 的券安然入场
  })

  it('过载（overload）与券无残留交互：+40 只活当回合，下回合 mana 回曲线并被锁定扣除', () => {
    const boltDef: CardDefinition = {
      id: 'test-overload-bolt', name: '跳闸测试', faction: 'neutral', type: 'driver', cost: 0, keywords: ['overload'],
      effect: { trigger: 'onPlay', steps: [{ op: 'lockMana', player: 'sourceOwner', amount: 100 }] },
    }
    registerCardDefinitions([boltDef])
    // 全跳闸牌卡组：P2 手牌中必有跳闸牌（洗牌无关，30 张同卡）
    let state = initGame(makeSetup(TEST_SEED, makeDeckSpec('test-overload-bolt')))
    state = engine.applyAction(state, { type: 'END_TURN', playerId: 'P1' }).state
    // P2 打券（mana 100+40=140）→ 打跳闸牌（lockMana 100）→ 回合结束
    state = engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: VOUCHER_UID }).state
    const boltUid = state.players.P2.hand.find((c) => c.cardId === 'test-overload-bolt')?.uid
    expect(boltUid).toBeTruthy()
    state = engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: boltUid as string }).state
    expect(state.players.P2.lockedMana).toBe(100)
    const after = engine.applyAction(state, { type: 'END_TURN', playerId: 'P2' }).state
    // turn 3 = P1 回合 → turn 4 = P2 自身第 2 回合：曲线 200，锁 100 → mana 100，无券残留
    const p2Back = engine.applyAction(after, { type: 'END_TURN', playerId: 'P1' }).state
    expect(p2Back.players.P2.maxMana).toBe(200)
    expect(p2Back.players.P2.mana).toBe(100)
    expect(p2Back.players.P2.lockedMana).toBe(0)
    expect(p2Back.players.P2.hand.some((c) => c.cardId === VOUCHER_CARD_ID)).toBe(false)
  })
})

describe('电费抵扣券：旧回放兼容（验收 3 的引擎侧不变量）', () => {
  it('initGame 后全局游标与一期一致：旧录制中的 h*/u* 引用全部有效（逐动作重放）', () => {
    const state = initGame(makeSetup())
    expect(state.nextInstanceId).toBe(2 * OPENING_HAND_SIZE + 1)
    // 券 uid 不占用任何 h*/u* 命名空间位：手牌 h 前缀 uid 与一期完全一致（P1 先抽交替）
    const handUids = [...state.players.P1.hand, ...state.players.P2.hand]
      .filter((c) => c.cardId !== VOUCHER_CARD_ID)
      .map((c) => c.uid)
    expect(handUids).toEqual(['h1', 'h3', 'h5', 'h2', 'h4', 'h6'])
    expect([...state.players.P1.hand, ...state.players.P2.hand].map((c) => c.uid)).toContain(VOUCHER_UID)
  })

  it('跨过自身第 1 回合的对局：券过期离手，终局状态与一期引擎语义对齐（无残留字段）', () => {
    // 纯 END_TURN 打满若干回合，终局状态不含任何券痕迹（hand/graveyard/deck 零券）
    let state = initGame(makeSetup())
    for (let i = 0; i < 6 && state.phase === 'main'; i++) {
      state = engine.applyAction(state, { type: 'END_TURN', playerId: state.activePlayer }).state
    }
    for (const player of [state.players.P1, state.players.P2]) {
      expect(player.hand.filter((c) => c.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
      expect(player.graveyard.filter((e) => e.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
      expect(player.deck.filter((e) => e.cardId === VOUCHER_CARD_ID)).toHaveLength(0)
    }
  })
})

describe('电费抵扣券：事件时序（验收 2：打出批次事件正确）', () => {
  it('打出券的批次：CARD_PLAYED 即 mana 事件无目录条目（改动经状态可见），随后无死亡/抽牌杂音', () => {
    const state = toP2FirstTurn()
    const { events } = engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: VOUCHER_UID })
    expect(events.map((e) => e.type)).toEqual(['CARD_PLAYED'])
  })

  it('过期批次：TURN_END → CARD_BURNED{voucher_expired} 位于 turnEnd 触发之后、胜负判定之前', () => {
    const state = toP2FirstTurn()
    const { events } = engine.applyAction(state, { type: 'END_TURN', playerId: 'P2' })
    const types = events.map((e) => e.type)
    const burnedIndex = types.indexOf('CARD_BURNED')
    expect(types.indexOf('TURN_END')).toBeGreaterThanOrEqual(0)
    expect(burnedIndex).toBeGreaterThan(types.indexOf('TURN_END'))
    expect(types.indexOf('TURN_START')).toBeGreaterThan(burnedIndex) // 随后进入 P1 回合
    const burned = events[burnedIndex] as Extract<GameEvent, { type: 'CARD_BURNED' }>
    expect(burned.reason).toBe('voucher_expired')
  })
})
