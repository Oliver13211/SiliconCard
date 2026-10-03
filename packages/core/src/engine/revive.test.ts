/**
 * M1-ENG6 revive 原语单测（docs/rules.md §5；§2.5「矿卡重生」/「性价比真香」语义）：
 *   - 从 sourceOwner 墓地捞回显卡：lastOwnedGpu（最近死亡的显卡）/ random（种子 RNG）；
 *   - 复活为新实例：新 instanceId、召唤失调重置、keywords/身板从定义恢复、光环重算；
 *   - 边界：只捞 gpu（配件不可复活）、空墓地/场满 no-op 且不消耗 RNG、复活即离墓、
 *     count 语义、亡语中复活（阵亡者亡语结算时尚未入墓，捞不到自己）。
 */

import { describe, expect, it } from 'vitest'
import { BOARD_LIMIT } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { GraveEntry, HandCard, GameState } from '../types/state'
import { makeGameState, makePlayer, makeUnit, TEST_SEED } from '../testing/state'
import { stableHash } from '../testing/hash'
import { applyAction } from './apply'
import { registerCardDefinitions } from './registry'

const CARDS: CardDefinition[] = [
  { id: 'r-revive-last', name: '性价比真香', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'revive', pick: 'lastOwnedGpu', to: 'sourceOwnerBoard' }] } },
  { id: 'r-revive-random', name: '矿卡重生', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'revive', pick: 'random', to: 'sourceOwnerBoard' }] } },
  { id: 'r-revive-two', name: '双倍真香', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'revive', pick: 'lastOwnedGpu', to: 'sourceOwnerBoard', count: 2 }] } },
  { id: 'r-dt-revive', name: '传家宝还魂', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'revive', pick: 'lastOwnedGpu', to: 'sourceOwnerBoard' }] } },
  { id: 'r-taunt-gpu', name: '信仰矿卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 3, keywords: ['taunt'] },
  { id: 'r-vanilla', name: '白板显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 3 },
  { id: 'r-big', name: '旗舰显卡', faction: 'neutral', type: 'gpu', cost: 300, attack: 5, health: 5 },
  { id: 'r-accessory', name: '信仰灯条', faction: 'neutral', type: 'accessory', cost: 100 },
]
registerCardDefinitions(CARDS)

function handCard(uid: string, cardId: string): HandCard {
  return { uid, cardId, cost: 100 }
}

/** P1 墓地条目快捷构造（按死亡顺序追加） */
const grave = (instanceId: string, cardId: string): GraveEntry => ({ instanceId, cardId })

interface ReviveStateOptions {
  hand?: HandCard[]
  graveyard?: GraveEntry[]
  board?: GameState['board']
  turn?: number
}

function reviveState(opts: ReviveStateOptions = {}): GameState {
  return makeGameState({
    turn: opts.turn ?? 1,
    activePlayer: 'P1',
    players: {
      P1: {
        ...makePlayer('P1'),
        hand: opts.hand ?? [handCard('h1', 'r-revive-last')],
        mana: 500,
        maxMana: 500,
        graveyard: opts.graveyard ?? [],
      },
      P2: { ...makePlayer('P2'), mana: 0, maxMana: 0 },
    },
    board: opts.board ?? [],
  })
}

describe('revive 原语（M1-ENG6，rules.md §5）', () => {
  it('lastOwnedGpu：复活墓地中最近死亡的显卡（末位 gpu 条目），配件条目跳过', () => {
    const state = reviveState({
      graveyard: [grave('g-old', 'r-vanilla'), grave('g-acc', 'r-accessory'), grave('g-new', 'r-big')],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    // 复活的是 g-new（旗舰显卡），且为新实例：新 instanceId ≠ 原 instanceId
    const revived = result.state.board.find((u) => u.cardId === 'r-big')
    expect(revived).toBeDefined()
    expect(revived?.instanceId).not.toBe('g-new')
    expect(revived?.instanceId).toBe('u1') // nextInstanceId 分配的新实例
    // 复活即离墓：gpu 条目移除，配件条目与更早显卡条目保留
    expect(result.state.players.P1.graveyard).toEqual([grave('g-old', 'r-vanilla'), grave('g-acc', 'r-accessory')])
    expect(result.events.find((e) => e.type === 'MINION_SUMMONED')).toMatchObject({ source: 'effect' })
  })

  it('复活为新实例：召唤失调重置、身板/关键词从定义恢复（阵亡 buff 与授予关键词不带回复活）', () => {
    // 墓地记录 taunt 显卡（定义 2/3 + taunt）：复活后按定义满状态入场
    const state = reviveState({
      turn: 5,
      graveyard: [grave('g-dead', 'r-taunt-gpu')],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const revived = result.state.board.find((u) => u.cardId === 'r-taunt-gpu')
    expect(revived).toMatchObject({
      attack: 2, // 定义值（非阵亡时快照/永久 buff）
      health: 3,
      maxHealth: 3,
      keywords: ['taunt'], // keywords 从定义恢复
      summonedOnTurn: 5, // 召唤失调按当前回合重置
      attacksRemaining: 0, // 入场当回合不可攻击
      attackedThisTurn: false,
    })
  })

  it('random：走种子 RNG——同 seed 两次运行目标一致且 RNG 被消费；墓地无显卡时不消耗 RNG', () => {
    const build = () =>
      reviveState({
        hand: [handCard('h1', 'r-revive-random')],
        graveyard: [grave('g-a', 'r-vanilla'), grave('g-b', 'r-big')],
      })
    const a = applyAction(build(), { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const b = applyAction(build(), { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(a.state.board.map((u) => u.cardId)).toEqual(b.state.board.map((u) => u.cardId))
    expect(a.events).toEqual(b.events)
    expect(a.state.players.P1.graveyard).toHaveLength(1) // 恰复活其一
    expect(a.state.rng.state).not.toBe(TEST_SEED >>> 0) // random 消耗 RNG

    const empty = reviveState({ hand: [handCard('h1', 'r-revive-random')], graveyard: [] })
    const emptyResult = applyAction(empty, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(emptyResult.state.board).toHaveLength(0)
    expect(emptyResult.events.some((e) => e.type === 'MINION_SUMMONED')).toBe(false)
    expect(emptyResult.state.rng.state).toBe(TEST_SEED >>> 0) // 池空不消耗 RNG
  })

  it('只捞 gpu：墓地仅有配件条目时不复活（配件不可复活，边界裁定）', () => {
    const state = reviveState({ graveyard: [grave('g-acc', 'r-accessory')] })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P1.graveyard).toEqual([grave('g-acc', 'r-accessory')])
  })

  it('场满静默截断：场上满员时不召唤、墓地条目保留、不消耗 RNG', () => {
    const fullBoard = Array.from({ length: BOARD_LIMIT }, (_, i) =>
      makeUnit({ ownerId: 'P1', instanceId: `u-f${i}`, cardId: 'r-vanilla' }),
    )
    const state = reviveState({
      hand: [handCard('h1', 'r-revive-random')],
      graveyard: [grave('g-a', 'r-vanilla')],
      board: fullBoard,
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(result.state.board).toHaveLength(BOARD_LIMIT)
    expect(result.state.players.P1.graveyard).toEqual([grave('g-a', 'r-vanilla')])
    expect(result.state.rng.state).toBe(TEST_SEED >>> 0) // 场满与池空同语义：不消耗 RNG
  })

  it('count=2：连续复活两张（lastOwnedGpu 语义下取最近死亡的两张）', () => {
    const state = reviveState({
      hand: [handCard('h1', 'r-revive-two')],
      graveyard: [grave('g-1', 'r-vanilla'), grave('g-2', 'r-big'), grave('g-acc', 'r-accessory')],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const cardIds = result.state.board.map((u) => u.cardId).sort()
    expect(cardIds).toEqual(['r-big', 'r-vanilla']) // 两张 gpu 均复活，配件留墓
    expect(result.state.players.P1.graveyard).toEqual([grave('g-acc', 'r-accessory')])
  })

  it('复活只作用于 sourceOwner：复活单位归施法者所有，对手墓地不受影响', () => {
    const state = reviveState({
      graveyard: [grave('g-mine', 'r-vanilla')],
      board: [],
    })
    // 对手墓地有显卡：P1 出牌只捞自己的
    state.players.P2.graveyard = [grave('g-theirs', 'r-big')]
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const revived = result.state.board.find((u) => u.cardId === 'r-vanilla')
    expect(revived?.ownerId).toBe('P1')
    expect(result.state.players.P2.graveyard).toEqual([grave('g-theirs', 'r-big')]) // 对手墓地原封不动
  })

  it('亡语中复活：阵亡者亡语结算时尚未入墓（§5「死亡后、进墓地前」），捞到的是更早死亡的显卡', () => {
    const state = reviveState({
      hand: [handCard('h1', 'r-revive-last'), handCard('h2', 'r-melt-helper')],
      graveyard: [grave('g-old', 'r-big')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-dt', cardId: 'r-dt-revive' })],
    })
    // 用 destroy 击杀 u-dt（h2 为公用熔毁卡，见下）：亡语 revive 捞 g-old 而非自己
    const helper: CardDefinition[] = [
      { id: 'r-melt-helper', name: '熔毁', faction: 'neutral', type: 'driver', cost: 100,
        effect: { trigger: 'onPlay', steps: [{ op: 'destroy', target: { kind: 'chosen', pool: 'allUnits' } }] } },
    ]
    registerCardDefinitions(helper)
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: { kind: 'unit', instanceId: 'u-dt' } })
    // u-dt 亡语复活 r-big（新实例）；u-dt 本体在亡语结算后才入墓
    const revived = result.state.board.find((u) => u.cardId === 'r-big')
    expect(revived).toBeDefined()
    expect(result.state.board.find((u) => u.cardId === 'r-dt-revive')).toBeUndefined() // 自己未被复活
    expect(result.state.players.P1.graveyard).toEqual([grave('u-dt', 'r-dt-revive')])
  })

  it('确定性：同 seed 复活对局片段两次运行哈希与事件逐字节一致', () => {
    const run = (): string => {
      const state = reviveState({
        hand: [handCard('h1', 'r-revive-random')],
        graveyard: [grave('g-a', 'r-vanilla'), grave('g-b', 'r-big')],
      })
      const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
      return stableHash(result.state)
    }
    expect(run()).toBe(run())
  })
})
