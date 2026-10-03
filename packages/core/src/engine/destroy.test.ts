/**
 * M1-ENG6 destroy 原语单测（docs/rules.md §5 / §7）：
 *   - 三年质保不抵挡 destroy（§7：不抵挡 destroy/移除类效果）；
 *   - 经 removeUnitFromBoard(cause 'destroy') 走既有死亡管线：MINION_DIED →
 *     移场重算光环 → 亡语触发 → 进墓地；
 *   - 亡语连锁（destroy 于亡语中再 destroy）与致死收尾（GAME_END 收尾事件流）；
 *   - 空池 no-op 且不消耗 RNG；英雄不可被摧毁（resolution 层跳过）。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { TargetRef } from '../types/actions'
import type { GameState, HandCard } from '../types/state'
import { makeGameState, makePlayer, makeUnit, TEST_SEED } from '../testing/state'
import { applyAction } from './apply'
import { registerCardDefinitions } from './registry'

const CARDS: CardDefinition[] = [
  { id: 'd-melt', name: '12VHPWR 熔毁', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'destroy', target: { kind: 'chosen', pool: 'allUnits' } }] } },
  { id: 'd-random-melt', name: '随机熔毁', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'destroy', target: { kind: 'random', pool: 'enemyUnits' } }] } },
  { id: 'd-hero-melt', name: '熔毁 CPU？', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'destroy', target: { kind: 'chosen', pool: 'anyCharacter' } }] } },
  { id: 'd-shielded', name: '质保卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 3, keywords: ['divine_shield'] },
  { id: 'd-dt-draw', name: '传家宝抽卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  { id: 'd-dt-melt', name: '蓝屏连环爆', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'destroy', target: { kind: 'random', pool: 'allUnits' } }] } },
  { id: 'd-dt-suicide', name: '临终拖电', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'damage', target: { kind: 'random', pool: 'sourceOwner' }, amount: 30 }] } },
  { id: 'd-vanilla', name: '白板显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 3 },
]
registerCardDefinitions(CARDS)

function handCard(uid: string, cardId: string): HandCard {
  return { uid, cardId, cost: 100 }
}

const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })
const heroRef = (playerId: 'P1' | 'P2'): TargetRef => ({ kind: 'hero', playerId })

function meltState(opts: { hand?: HandCard[]; board?: GameState['board']; p2Health?: number } = {}): GameState {
  return makeGameState({
    activePlayer: 'P1',
    players: {
      P1: { ...makePlayer('P1'), hand: opts.hand ?? [handCard('h1', 'd-melt')], mana: 500, maxMana: 500 },
      P2: {
        ...makePlayer('P2'),
        mana: 0,
        maxMana: 0,
        deck: [{ cardId: 'd-vanilla' }, { cardId: 'd-vanilla' }], // 亡语抽牌测试需要非空牌库
        ...(opts.p2Health !== undefined ? { health: opts.p2Health } : {}),
      },
    },
    board: opts.board ?? [],
  })
}

describe('destroy 原语（M1-ENG6，rules.md §5/§7）', () => {
  it('基础摧毁：目标移场入墓，MINION_DIED cause=destroy；质保照常进墓', () => {
    const state = meltState({ board: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1', cardId: 'd-vanilla' })] })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-e1') })
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P2.graveyard).toEqual([{ instanceId: 'u-e1', cardId: 'd-vanilla' }])
    expect(result.events.find((e) => e.type === 'MINION_DIED')).toMatchObject({
      cause: 'destroy',
      unit: { instanceId: 'u-e1' },
    })
  })

  it('三年质保不抵挡 destroy：divine_shield 原样带走（不消耗、不发 shieldConsumed）', () => {
    const state = meltState({
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1', cardId: 'd-shielded', keywords: ['divine_shield'] })],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-e1') })
    expect(result.state.board).toHaveLength(0)
    const died = result.events.find((e) => e.type === 'MINION_DIED')
    expect(died && died.type === 'MINION_DIED' && died.unit.keywords).toContain('divine_shield')
    expect(result.events.some((e) => e.type === 'DAMAGE_DEALT' && e.shieldConsumed)).toBe(false)
    expect(result.events.some((e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'divine_shield')).toBe(false)
  })

  it('destroy 触发亡语（§7 被destroy同样触发）：被摧毁单位的 deathrattle 正常结算', () => {
    const state = meltState({
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1', cardId: 'd-dt-draw' })],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-e1') })
    // 亡语生效事件 + P2（阵亡单位拥有者）抽 1 张
    expect(result.events.some((e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'deathrattle')).toBe(true)
    expect(result.events.some((e) => e.type === 'CARD_DRAWN' && e.playerId === 'P2' && e.source === 'deck')).toBe(true)
    expect(result.state.players.P2.hand).toHaveLength(1)
  })

  it('亡语连锁：destroy → 亡语再 destroy → 深度优先，两个单位均入墓', () => {
    const state = meltState({
      board: [
        makeUnit({ ownerId: 'P2', instanceId: 'u-e1', cardId: 'd-dt-melt' }),
        makeUnit({ ownerId: 'P1', instanceId: 'u-a', cardId: 'd-vanilla' }),
      ],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-e1') })
    expect(result.state.board).toHaveLength(0)
    // u-e1 亡语摧毁 u-a（random allUnits 唯一候选，不消耗歧义）
    expect(result.state.players.P2.graveyard).toContainEqual({ instanceId: 'u-e1', cardId: 'd-dt-melt' })
    expect(result.state.players.P1.graveyard).toContainEqual({ instanceId: 'u-a', cardId: 'd-vanilla' })
    const diedCount = result.events.filter((e) => e.type === 'MINION_DIED').length
    expect(diedCount).toBe(2)
  })

  it('光环随死亡重算：摧毁攻击光环源后，受光环单位攻击回落基础值', () => {
    const CARDS_WITH_AURA: CardDefinition[] = [
      { id: 'd-aura', name: '信仰灯条', faction: 'neutral', type: 'accessory', cost: 100,
        effect: { trigger: 'battlecry', aura: { stat: 'attack', delta: 1, scope: 'ownUnits' } } },
    ]
    registerCardDefinitions(CARDS_WITH_AURA)
    const state = meltState({
      hand: [handCard('h1', 'd-aura'), handCard('h2', 'd-melt')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-a', cardId: 'd-vanilla', attack: 3, health: 3, maxHealth: 3 })],
    })
    // 先打出光环配件（入场投影 +1），确认 4 攻后再摧毁光环源（实例 id 由引擎分配）
    const withAura = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(withAura.state.board.find((u) => u.instanceId === 'u-a')?.attack).toBe(4)
    const auraId = withAura.state.board.find((u) => u.cardId === 'd-aura')?.instanceId
    expect(auraId).toBeDefined()
    const result = applyAction(withAura.state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2', target: unitRef(auraId as string) })
    expect(result.state.board.find((u) => u.instanceId === 'u-a')?.attack).toBe(3) // 光环回收
  })

  it('致死收尾：被摧毁单位的亡语打空 CPU → GAME_END 收尾于事件流', () => {
    const state = meltState({
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1', cardId: 'd-dt-suicide' })],
      p2Health: 30,
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-e1') })
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBe('P1')
    expect(result.events.at(-1)).toMatchObject({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
  })

  it('空池 no-op：无目标可摧毁时不产生死亡事件，且不消耗 RNG（池空语义一致）', () => {
    const state = meltState({ hand: [handCard('h1', 'd-random-melt')], board: [] })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(result.events.some((e) => e.type === 'MINION_DIED')).toBe(false)
    expect(result.state.rng.state).toBe(TEST_SEED >>> 0) // random 空池不消耗 RNG
  })

  it('英雄不可被摧毁：chosen anyCharacter 合法选中 CPU，但 resolution 层跳过英雄（无事发生）', () => {
    const state = meltState({ hand: [handCard('h1', 'd-hero-melt')] })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: heroRef('P2') })
    expect(result.state.players.P2.health).toBe(30)
    expect(result.state.phase).toBe('main')
    expect(result.events.some((e) => e.type === 'MINION_DIED')).toBe(false)
    expect(result.events.some((e) => e.type === 'GAME_END')).toBe(false)
  })

  it('确定性：同 seed 两次运行 random destroy 结果逐字节一致', () => {
    const build = () =>
      meltState({
        hand: [handCard('h1', 'd-random-melt')],
        board: [
          makeUnit({ ownerId: 'P2', instanceId: 'u-e1', cardId: 'd-vanilla' }),
          makeUnit({ ownerId: 'P2', instanceId: 'u-e2', cardId: 'd-vanilla' }),
        ],
      })
    const a = applyAction(build(), { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const b = applyAction(build(), { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    expect(a.state.board).toEqual(b.state.board)
    expect(a.events).toEqual(b.events)
    // 两个候选恰摧毁其一，rng 被消费
    expect(a.state.board).toHaveLength(1)
    expect(a.state.rng.state).not.toBe(TEST_SEED >>> 0)
  })
})
