/**
 * M1-ENG6 turnStart / turnEnd 触发接线单测（docs/rules.md §2.2 / §2.5 / §5）：
 *   - 时序：turnEnd 在 §2.5 END_TURN 序列（turnEnd 效果 → 手牌烧牌）；turnStart 在
 *     §2.2 回合开始序列（供电/重置/抽牌）之后；
 *   - 作用范围：全场双方单位（裁定见 triggers.ts resolveTurnPhaseTriggers），按 board
 *     顺序结算，actorId = 单位拥有者；
 *   - 单层队列：结算中途离场的单位跳过、结算中途召唤的单位不触发；
 *   - 致死收尾：turnEnd 效果致死 → GAME_END 收尾、不再推进回合；
 *   - 疲劳致死后 turnStart 不触发（对局已结束）。
 */

import { describe, expect, it } from 'vitest'
import { HAND_LIMIT } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { GameState, HandCard } from '../types/state'
import { makeGameState, makePlayer, makeUnit, TEST_SEED } from '../testing/state'
import { applyAction } from './apply'
import { registerCardDefinitions } from './registry'

const CARDS: CardDefinition[] = [
  { id: 'tt-end-draw', name: '下班摸鱼', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2,
    effect: { trigger: 'turnEnd', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  { id: 'tt-start-draw', name: '上班摸鱼', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2,
    effect: { trigger: 'turnStart', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  { id: 'tt-end-buff', name: '晚间超频', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2,
    effect: { trigger: 'turnEnd', steps: [{ op: 'buff', target: { kind: 'random', pool: 'self' }, attack: 1 }] } },
  { id: 'tt-start-buff', name: '晨间超频', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2,
    effect: { trigger: 'turnStart', steps: [{ op: 'buff', target: { kind: 'random', pool: 'self' }, attack: 1, health: 1 }] } },
  { id: 'tt-end-snipe', name: '下班雷击', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2,
    effect: { trigger: 'turnEnd', steps: [{ op: 'damage', target: { kind: 'random', pool: 'enemyHero' }, amount: 30 }] } },
  { id: 'tt-end-wipe', name: '整点熄机', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2,
    effect: { trigger: 'turnEnd', steps: [{ op: 'destroy', target: { kind: 'all', pool: 'allUnits' } }] } },
  { id: 'tt-end-quake', name: '余震', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2, tags: ['miner'],
    effect: { trigger: 'turnEnd', steps: [{ op: 'buff', target: { kind: 'all', pool: 'allUnits', tag: 'miner' }, attack: -1, health: -1 }] } },
  { id: 'tt-token', name: '亮机卡', faction: 'neutral', type: 'gpu', cost: 0, attack: 1, health: 1,
    effect: { trigger: 'turnEnd', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  { id: 'tt-summoner', name: '量产机', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2,
    effect: { trigger: 'turnEnd', steps: [{ op: 'summon', cardId: 'tt-token', count: 1 }] } },
]
registerCardDefinitions(CARDS)

function handCards(uidPrefix: string, cardId: string, count: number): HandCard[] {
  return Array.from({ length: count }, (_, i) => ({ uid: `${uidPrefix}${i}`, cardId, cost: 100 }))
}

interface TriggerStateOptions {
  hand?: HandCard[]
  p1Deck?: number
  board?: GameState['board']
  p2Health?: number
}

function triggerState(opts: TriggerStateOptions = {}): GameState {
  return makeGameState({
    activePlayer: 'P1',
    players: {
      P1: {
        ...makePlayer('P1'),
        hand: opts.hand ?? [],
        mana: 500,
        maxMana: 500,
        deck: Array.from({ length: opts.p1Deck ?? 5 }, () => ({ cardId: 'smoke-gpu' })),
      },
      P2: {
        ...makePlayer('P2'),
        mana: 0,
        maxMana: 0,
        deck: Array.from({ length: 5 }, () => ({ cardId: 'smoke-gpu' })),
        ...(opts.p2Health !== undefined ? { health: opts.p2Health } : {}),
      },
    },
    board: opts.board ?? [],
  })
}

describe('turnEnd 触发（M1-ENG6，rules.md §2.5 / §5）', () => {
  it('作用范围=全场：P1 的 END_TURN 同时触发双方单位的 turnEnd 效果（board 顺序，actor=各自拥有者）', () => {
    const state = triggerState({
      hand: [],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-p1', cardId: 'tt-end-draw' }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-p2', cardId: 'tt-end-buff', attack: 2, health: 2, maxHealth: 2 }),
      ],
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    // P1 单位为己方抽牌；P2 单位按自己为 actor 增益自己（P2 回合开始的正常抽牌计入 P2）
    expect(result.state.players.P1.hand).toHaveLength(1)
    const p2Unit = result.state.board.find((u) => u.instanceId === 'u-p2')
    expect(p2Unit?.attack).toBe(3) // 2 + 1（触发效果 actorId = P2）
  })

  it('时序（§2.5）：turnEnd 效果先于手牌烧牌——效果抽的牌参与本回合超限判定', () => {
    const state = triggerState({
      hand: handCards('h', 'smoke-gpu', HAND_LIMIT), // 恰好 10 张（手牌上限）
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-p1', cardId: 'tt-end-draw' })],
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    const types = result.events.map((e) => e.type)
    const drawIndex = types.indexOf('CARD_DRAWN')
    const burnIndex = types.indexOf('CARD_BURNED')
    expect(drawIndex).toBeGreaterThan(-1)
    expect(burnIndex).toBeGreaterThan(drawIndex) // TURN_END → 效果抽牌 → 烧牌
    // 抽到的牌排到手牌末尾 → 被烧的正是它，最终手牌回到上限
    expect(result.state.players.P1.hand).toHaveLength(HAND_LIMIT)
    expect(result.events.find((e) => e.type === 'CARD_BURNED')).toMatchObject({ playerId: 'P1', reason: 'hand_full' })
  })

  it('单层队列：turnEnd 效果摧毁的单位不再触发（以结算开始时在场名单为准）', () => {
    const state = triggerState({
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-wipe', cardId: 'tt-end-wipe' }),
        makeUnit({ ownerId: 'P1', instanceId: 'u-draw', cardId: 'tt-end-draw' }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-p2', cardId: 'tt-end-draw' }),
      ],
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    // u-wipe 先触发并全场摧毁 → 后续两位（含 P2 单位）已离场，不再触发
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P1.hand).toHaveLength(0)
    // 全场唯一 CARD_DRAWN 是 P2 回合开始的正常抽牌（§2.2）；两单位的 turnEnd 抽牌均未发生
    const draws = result.events.filter((e) => e.type === 'CARD_DRAWN')
    expect(draws).toHaveLength(1)
    expect(draws[0]).toMatchObject({ playerId: 'P2' })
    expect(result.state.players.P1.graveyard).toContainEqual({ instanceId: 'u-draw', cardId: 'tt-end-draw' })
  })

  it('结算中途召唤的单位不触发本时点（单层队列不入队）', () => {
    const state = triggerState({
      hand: [],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-sum', cardId: 'tt-summoner' })],
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    // token（自带 turnEnd 抽牌）在本回合 END_TURN 中不入队：只召唤、不抽牌
    expect(result.state.board.map((u) => u.cardId)).toContain('tt-token')
    // P1 无任何 CARD_DRAWN（唯一一张是 P2 回合开始的正常抽牌）
    expect(result.events.filter((e) => e.type === 'CARD_DRAWN' && e.playerId === 'P1')).toHaveLength(0)
  })

  it('致死收尾：turnEnd 效果击倒 CPU → GAME_END 收尾，不再烧牌/切换/进入对方回合', () => {
    const state = triggerState({
      hand: handCards('h', 'smoke-gpu', HAND_LIMIT + 2), // 若继续推进会烧牌，用于证明提前收尾
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-snipe', cardId: 'tt-end-snipe' })],
      p2Health: 30,
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBe('P1')
    expect(result.state.activePlayer).toBe('P1') // 未切换
    expect(result.events.at(-1)).toMatchObject({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
    expect(result.events.some((e) => e.type === 'CARD_BURNED')).toBe(false)
    expect(result.events.some((e) => e.type === 'TURN_START')).toBe(false)
  })

  it('随机 turnEnd 步骤消耗引擎 RNG 并随动作写回（确定性链路）', () => {
    const state = triggerState({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-snipe', cardId: 'tt-end-snipe' })],
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(result.state.players.P2.health).toBe(0) // random enemyHero 30 点命中
    expect(result.state.rng.state).not.toBe(TEST_SEED >>> 0) // RNG 已推进并写回
  })

  it('每个回合结束时都触发（双方回合各一次）；tag 过滤在触发步骤中同样生效', () => {
    const state = triggerState({
      hand: [],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-quake', cardId: 'tt-end-quake', attack: 1, health: 2, maxHealth: 2 }),
        makeUnit({ ownerId: 'P1', instanceId: 'u-miner', cardId: 'tt-token', attack: 3, health: 3, maxHealth: 3 }),
      ],
    })
    // u-quake（余震，tag=miner 定义）先触发：-1/-1 只命中 miner 定义单位（自身 1/2→0/1），
    // u-miner（tt-token 定义无 tags）不受影响；随后 u-miner（tt-token 自带 turnEnd 抽牌）抽 1
    const first = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(first.state.players.P1.hand).toHaveLength(1)
    expect(first.state.board.find((u) => u.instanceId === 'u-miner')).toMatchObject({ attack: 3, health: 3 })
    expect(first.state.board.find((u) => u.instanceId === 'u-quake')).toMatchObject({ attack: 0, health: 1 })
    // P2 回合结束：u-quake 二次 -1/-1 致死（0/0，走死亡管线入墓）；u-miner 再抽 1；
    // P2 结束后进入 P1 回合的正常抽牌（§2.2）再 +1 → P1 手牌 3
    const second = applyAction(first.state, { type: 'END_TURN', playerId: 'P2' })
    expect(second.state.players.P1.hand).toHaveLength(3)
    expect(second.state.board.find((u) => u.instanceId === 'u-quake')).toBeUndefined()
    expect(second.state.players.P1.graveyard).toContainEqual({ instanceId: 'u-quake', cardId: 'tt-end-quake' })
  })
})

describe('turnStart 触发（M1-ENG6，rules.md §2.2 / §5）', () => {
  it('时序（§2.2）：turnStart 效果在回合开始序列（供电/重置/抽牌）之后结算', () => {
    const state = triggerState({
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-p2', cardId: 'tt-start-draw' })],
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    // P2 回合开始：正常抽 1（§2.2）+ turnStart 效果再抽 1
    expect(result.state.players.P2.hand).toHaveLength(2)
    expect(result.state.players.P2.mana).toBe(100) // 供电曲线已先结算
    expect(result.state.activePlayer).toBe('P2')
    const types = result.events.map((e) => e.type)
    const turnStartIndex = types.indexOf('TURN_START')
    expect(types.filter((t) => t === 'CARD_DRAWN')).toHaveLength(2)
    expect(types.indexOf('CARD_DRAWN', turnStartIndex)).toBeGreaterThan(turnStartIndex)
  })

  it('turnStart 增益按当前回合重置后的状态生效（先重置攻击次数，后触发）', () => {
    const state = triggerState({
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-p2', cardId: 'tt-start-buff', attack: 2, health: 2, maxHealth: 2 })],
    })
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    const unit = result.state.board.find((u) => u.instanceId === 'u-p2')
    expect(unit).toMatchObject({ attack: 3, health: 3, attackedThisTurn: false }) // 重置+增益
    expect(unit?.attacksRemaining).toBeGreaterThan(0)
  })

  it('对局在抽牌阶段结束（疲劳致死）→ turnStart 不再触发，GAME_END 收尾', () => {
    const state = triggerState({
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-p2', cardId: 'tt-start-snipe-helper' })],
      p2Health: 1,
    })
    state.players.P2.deck = [] // P2 回合开始抽牌即疲劳 1 点 → 1 血倒下
    const helper: CardDefinition[] = [
      { id: 'tt-start-snipe-helper', name: '晨间雷击', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2,
        effect: { trigger: 'turnStart', steps: [{ op: 'damage', target: { kind: 'random', pool: 'enemyHero' }, amount: 5 }] } },
    ]
    registerCardDefinitions(helper)
    const result = applyAction(state, { type: 'END_TURN', playerId: 'P1' })
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBe('P1')
    // P2 的 turnStart 伤害未发生（P1 满血），GAME_END 为最后一事件
    expect(result.state.players.P1.health).toBe(30)
    expect(result.events.at(-1)).toMatchObject({ type: 'GAME_END', winner: 'P1' })
    expect(result.events.filter((e) => e.type === 'DAMAGE_DEALT' && e.source.kind === 'effect')).toHaveLength(0)
  })

  it('确定性：含 turnStart/turnEnd 触发的回合流转两次运行逐字节一致', () => {
    const build = () =>
      triggerState({
        hand: [],
        board: [
          makeUnit({ ownerId: 'P1', instanceId: 'u-p1', cardId: 'tt-end-buff' }),
          makeUnit({ ownerId: 'P2', instanceId: 'u-p2', cardId: 'tt-start-draw' }),
        ],
      })
    const a = applyAction(build(), { type: 'END_TURN', playerId: 'P1' })
    const b = applyAction(build(), { type: 'END_TURN', playerId: 'P1' })
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))
  })
})
