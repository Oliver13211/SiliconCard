/**
 * 电费抵扣券 AI 启发式单测（P2-ENG1）：基本启发式——手牌里有「现在打不出、
 * +300W 内打得出」的高费卡时先用券；无用武之地（全打得出 / 券也救不回来）时不浪费。
 * 全程经真实引擎与 createAiPlayer 公开决策路径（sealState 封印注入，防作弊闸门照旧）。
 */

import { beforeAll, describe, expect, test } from 'vitest'
import { createEngine, type Action, type GameState } from '@siliconcard/core'
import { registerAiCardPool } from './cardPool'
import { sealState } from './sealed'
import { createAiPlayer } from './player'

beforeAll(() => registerAiCardPool())

const engine = createEngine()

function deckOf(cardId: string) {
  return { cards: [{ cardId, count: 30 }] }
}

function setupWithP2Deck(p2CardId: string) {
  return {
    seed: 20261115,
    players: [
      { id: 'P1' as const, faction: 'nvidia', deck: deckOf('ai-zap') },
      { id: 'P2' as const, faction: 'amd', deck: deckOf(p2CardId) },
    ],
  } as const
}

/** 推进到 P2 的第 1 回合（P1 END_TURN 一次 → 全局 turn 2） */
function toP2FirstTurn(p2CardId: string): GameState {
  let state = engine.initGame(setupWithP2Deck(p2CardId))
  state = engine.applyAction(state, { type: 'END_TURN', playerId: 'P1' }).state
  return state
}

function isVoucherPlay(action: Action | null): boolean {
  return action?.type === 'PLAY_CARD' && action.uid === 'vc1'
}

describe('AI 电费抵扣券启发式（P2-ENG1）', () => {
  test('手牌有打不出的 140W 卡（+40W 内可解锁）→ 先用券，下一决策打出被解锁的卡', () => {
    // ai-brick cost 140（cardPool）：P2 自身第 1 回合供电 100W 打不出；100+40=140 恰可解锁
    const bot = createAiPlayer({ playerId: 'P2', difficulty: 'normal', seed: 42 })
    const state = toP2FirstTurn('ai-brick')
    const first = bot.decideNextAction(engine, sealState(state))
    expect(isVoucherPlay(first)).toBe(true)
    const afterVoucher = engine.applyAction(state, first as Action).state
    expect(afterVoucher.players.P2.mana).toBe(140)
    const second = bot.decideNextAction(engine, sealState(afterVoucher))
    expect(second?.type).toBe('PLAY_CARD')
    if (second?.type === 'PLAY_CARD') {
      const cardId = afterVoucher.players.P2.hand.find((c) => c.uid === second.uid)?.cardId
      expect(cardId).toBe('ai-brick')
    }
  })

  test('券也救不回的高费卡（500W > 100+40）→ 不浪费券（启发式不触发）', () => {
    // ai-sweep cost 500：+40W 后 140W 仍打不出 → 启发式不触发
    const bot = createAiPlayer({ playerId: 'P2', difficulty: 'normal', seed: 42 })
    const state = toP2FirstTurn('ai-sweep')
    const first = bot.decideNextAction(engine, sealState(state))
    expect(isVoucherPlay(first)).toBe(false)
  })

  test('手牌全部打得出（100W 驱动）→ 不用券（先正常铺场/结算）', () => {
    // ai-zap cost 100 ≤ 100W：无「打不出」的卡 → 启发式不触发
    const bot = createAiPlayer({ playerId: 'P2', difficulty: 'normal', seed: 42 })
    const state = toP2FirstTurn('ai-zap')
    const first = bot.decideNextAction(engine, sealState(state))
    expect(isVoucherPlay(first)).toBe(false)
    // P1 视角永不持券：P1 的 bot 决策天然与券无关（防御断言）
    const p1Bot = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 42 })
    const p1First = p1Bot.decideNextAction(engine, sealState(engine.initGame(setupWithP2Deck('ai-brick'))))
    expect(isVoucherPlay(p1First)).toBe(false)
  })

  test('券用过即止：P2 决策循环零非法动作，回合结束后券已离手（打出或过期）', () => {
    const bot = createAiPlayer({ playerId: 'P2', difficulty: 'normal', seed: 7 })
    let state = toP2FirstTurn('ai-brick')
    let guard = 0
    while (state.activePlayer === 'P2' && state.phase === 'main' && guard++ < 6) {
      const action = bot.decideNextAction(engine, sealState(state))
      if (!action) break
      state = engine.applyAction(state, action).state // 非法动作会被引擎抛错 = 断言机制
    }
    // P2 已收束回合（END_TURN → 进入 P1 回合）；券不再在手
    expect(state.turn).toBeGreaterThanOrEqual(3)
    expect(state.players.P2.hand.some((c) => c.cardId === 'siliconcard-voucher')).toBe(false)
  })
})
