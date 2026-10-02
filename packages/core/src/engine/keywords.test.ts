/**
 * M1-ENG4 关键词系统单测矩阵 —— 每个关键词 ≥3 条（触发 / 不触发 / 叠加），
 * 规则依据 docs/rules.md §7 精确定义：
 *   - deathrattle（蓝屏/传家宝）：死亡管线（快照 / 连锁 / 致死 / 全死亡来源）；
 *   - overload（跳闸）：lockMana 步骤定值 / 兜底 100W / 叠加 / 下回合 BURN_OUT 清零；
 *   - divine_shield（三年质保）：任意金额抵一次 / 不抵挡 destroy / 重复授予不叠层；
 *   - stealth（无输出亮机）：现身前不可被指定 / 全场与己方效果照常 / 现身即永久移除；
 *   - taunt（信仰充值）/ charge（超频）/ windfury（双芯 GPU）：M1-ENG3 已有深度覆盖
 *     （combat.test.ts），此处补齐同构矩阵（含 grantKeyword 授予 / removeKeyword 移除
 *     的动态生效路径与叠加语义）。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { Action, TargetRef } from '../types/actions'
import type { BoardUnit, DeckEntry, GameState, HandCard, PlayerId, PlayerState } from '../types/state'
import { catchRuleError, makeGameState, makePlayer, makeUnit } from '../testing/state'
import { applyAction, getLegalActions } from './apply'
import type { AttackAction } from './combat'
import { registerCardDefinitions } from './registry'
import { createRng } from './prng'
import { removeUnitFromBoard } from './units'

// —— 测试卡池（vitest 文件间注册表隔离）——
const CARDS: CardDefinition[] = [
  // —— 亡语（deathrattle）——
  { id: 'k-dt-draw', name: '传家宝抽卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  { id: 'k-dt-keyword-only', name: '只挂招牌', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'] },
  { id: 'k-dt-effect-only', name: '无名亡语', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1,
    effect: { trigger: 'deathrattle', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  { id: 'k-dt-nuke', name: '蓝屏自爆', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'damage', target: { kind: 'all', pool: 'allUnits' }, amount: 1 }] } },
  { id: 'k-dt-hero', name: '传家宝遗产', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 3, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'damage', target: { kind: 'all', pool: 'enemyHero' }, amount: 5 }] } },
  { id: 'k-dt-selfheal', name: '修不好的卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 0, health: 1, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'heal', target: { kind: 'random', pool: 'self' }, amount: 2 }] } },
  // —— 跳闸（overload）——
  { id: 'k-ov-step', name: '白牌电源', faction: 'neutral', type: 'driver', cost: 100, keywords: ['overload'],
    effect: { trigger: 'onPlay', steps: [
      { op: 'draw', player: 'sourceOwner', count: 1 },
      { op: 'lockMana', player: 'sourceOwner', amount: 200 },
    ] } },
  { id: 'k-ov-fallback', name: '裸跳闸', faction: 'neutral', type: 'driver', cost: 100, keywords: ['overload'] },
  { id: 'k-ov-multi', name: '连环跳闸', faction: 'neutral', type: 'driver', cost: 100, keywords: ['overload'],
    effect: { trigger: 'onPlay', steps: [
      { op: 'lockMana', player: 'sourceOwner', amount: 50 },
      { op: 'lockMana', player: 'sourceOwner', amount: 50 },
    ] } },
  { id: 'k-ov-plain', name: '限电器', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'lockMana', player: 'sourceOwner', amount: 100 }] } },
  { id: 'k-ov-gpu', name: '超频翻车卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2, keywords: ['overload'],
    effect: { trigger: 'battlecry', steps: [{ op: 'lockMana', player: 'sourceOwner', amount: 300 }] } },
  { id: 'k-ov-dr-lock', name: '遗产跳闸', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2, keywords: ['overload'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'lockMana', player: 'sourceOwner', amount: 999 }] } },
  // —— onAttack / onDamaged ——
  { id: 'k-oa-buff', name: '越战越勇', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2,
    effect: { trigger: 'onAttack', steps: [{ op: 'buff', target: { kind: 'random', pool: 'self' }, attack: 1 }] } },
  { id: 'k-oa-kill', name: '开闸放电', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 5,
    effect: { trigger: 'onAttack', steps: [{ op: 'damage', target: { kind: 'all', pool: 'enemyUnits' }, amount: 5 }] } },
  { id: 'k-oa-suicide', name: '自燃超频', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2,
    effect: { trigger: 'onAttack', steps: [{ op: 'buff', target: { kind: 'random', pool: 'self' }, health: -5 }] } },
  { id: 'k-od-counter', name: '静电外壳', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 4,
    effect: { trigger: 'onDamaged', steps: [{ op: 'damage', target: { kind: 'random', pool: 'enemyUnits' }, amount: 1 }] } },
  { id: 'k-od-draw', name: '吃一堑长一智', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 1,
    effect: { trigger: 'onDamaged', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  // —— 效果工具卡 ——
  { id: 'k-bolt', name: '测试电弧', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 3 }] } },
  { id: 'k-shrink', name: '矿难预演', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'all', pool: 'allUnits' }, attack: -1, health: -1 }] } },
  ...(['divine_shield', 'stealth', 'taunt', 'charge', 'windfury'] as const).map((keyword) => ({
    id: `k-grant-${keyword}`,
    name: `贴纸 ${keyword}`,
    faction: 'neutral',
    type: 'driver' as const,
    cost: 100,
    effect: {
      trigger: 'onPlay' as const,
      steps: [{ op: 'grantKeyword' as const, target: { kind: 'chosen' as const, pool: 'ownUnits' as const }, keyword }],
    },
  })),
  { id: 'k-strip-taunt', name: '驱动回滚', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'removeKeyword', target: { kind: 'chosen', pool: 'enemyUnits' }, keyword: 'taunt' }] } },
  // —— 关键词基卡 ——
  { id: 'k-vanilla', name: '白板显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 2 },
  { id: 'k-shielded', name: '质保未拆封', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 3, keywords: ['divine_shield'] },
  { id: 'k-charged', name: '超频核心', faction: 'neutral', type: 'gpu', cost: 200, attack: 3, health: 1, keywords: ['charge'] },
  { id: 'k-dual', name: '双芯超频', faction: 'neutral', type: 'gpu', cost: 200, attack: 2, health: 2, keywords: ['charge', 'windfury'] },
  { id: 'k-taunt', name: '信仰充值塔', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 4, keywords: ['taunt'] },
  { id: 'k-wf', name: '双芯 GPU', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2, keywords: ['windfury'] },
  { id: 'k-stealth', name: '无输出亮机', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2, keywords: ['stealth'] },
]
registerCardDefinitions(CARDS)

// —— 构造工具 ——

const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })
const heroRef = (playerId: 'P1' | 'P2'): TargetRef => ({ kind: 'hero', playerId })
const atk = (attackerId: string, target: TargetRef, playerId: PlayerId = 'P1'): AttackAction => ({
  type: 'ATTACK',
  playerId,
  attackerId,
  target,
})
const endTurn = (playerId: 'P1' | 'P2'): Action => ({ type: 'END_TURN', playerId })
const playCard = (uid: string, target?: TargetRef): Action =>
  ({ type: 'PLAY_CARD', playerId: 'P1', uid, ...(target ? { target } : {}) })
const hc = (uid: string, cardId: string, cost = 100): HandCard => ({ uid, cardId, cost })
const eventsOf = (events: readonly GameEvent[]): string[] => events.map((e) => e.type)
const keywordEvents = (events: readonly GameEvent[], keyword: string): GameEvent[] =>
  events.filter((e): e is Extract<GameEvent, { type: 'KEYWORD_TRIGGERED' }> =>
    e.type === 'KEYWORD_TRIGGERED' && e.keyword === keyword)

const deckOf = (n = 3): DeckEntry[] => Array.from({ length: n }, () => ({ cardId: 'smoke-gpu' }))

interface StateOptions {
  hand?: HandCard[]
  mana?: number
  board?: BoardUnit[]
  enemyBoard?: BoardUnit[]
  deck?: DeckEntry[]
  turn?: number
  p1?: Partial<PlayerState>
  p2?: Partial<PlayerState>
}

/** 合成状态：P1 行动、供电 500W（turn 默认 3 时真实出牌链路可用） */
function state(opts: StateOptions = {}): GameState {
  return makeGameState({
    turn: opts.turn ?? 3,
    activePlayer: 'P1',
    players: {
      P1: { ...makePlayer('P1'), hand: opts.hand ?? [], mana: opts.mana ?? 500, maxMana: 500, deck: opts.deck ?? deckOf(), ...(opts.p1 ?? {}) },
      P2: { ...makePlayer('P2'), deck: deckOf(), ...(opts.p2 ?? {}) },
    },
    board: [...(opts.board ?? []), ...(opts.enemyBoard ?? [])],
  })
}

function advanceOneRound(state: GameState): GameState {
  const first = applyAction(state, endTurn(state.activePlayer))
  return applyAction(first.state, endTurn(first.state.activePlayer)).state
}

// ————————————————————————————————————————————————————————————
// deathrattle（蓝屏 / 传家宝）
// ————————————————————————————————————————————————————————————

describe('deathrattle（蓝屏/传家宝）亡语矩阵', () => {
  it('触发：战斗伤害致死 → MINION_DIED → KEYWORD_TRIGGERED(可读 detail) → 亡语步骤（抽牌）→ 墓地', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 2, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-draw', attack: 0, health: 1, maxHealth: 1, keywords: ['deathrattle'] })],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual([
      'ATTACK_DECLARED',
      'DAMAGE_DEALT',
      'MINION_DIED',
      'KEYWORD_TRIGGERED',
      'CARD_DRAWN', // 亡语抽牌归阵亡方 P2
    ])
    const dt = keywordEvents(result.events, 'deathrattle')
    expect(dt).toHaveLength(1)
    expect(dt[0]).toMatchObject({ instanceId: 'e1' })
    expect((dt[0] as { detail: string }).detail).toContain('蓝屏/传家宝')
    expect(result.state.players.P2.hand).toHaveLength(1) // 亡语抽 1 张
    expect(result.state.players.P2.graveyard).toEqual([{ instanceId: 'e1', cardId: 'k-dt-draw' }])
  })

  it('不触发：无亡语效果的普通单位死亡无事件；仅挂 deathrattle 关键词而无效果同样静默', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3, attacksRemaining: 2 })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e-plain', attack: 0, health: 1, maxHealth: 1 }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-kw', cardId: 'k-dt-keyword-only', attack: 0, health: 1, maxHealth: 1, keywords: ['deathrattle'] }),
      ],
    })
    const first = applyAction(initial, atk('a1', unitRef('e-plain')))
    expect(keywordEvents(first.events, 'deathrattle')).toEqual([])
    expect(first.state.players.P2.hand).toHaveLength(0)

    const second = applyAction(first.state, atk('a1', unitRef('e-kw')))
    expect(keywordEvents(second.events, 'deathrattle')).toEqual([])
    expect(second.state.players.P2.hand).toHaveLength(0)
  })

  it('边界：effect.trigger=deathrattle 而无关键词同样触发（效果规格是机制事实源，关键词为展示标记）', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 2, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-effect-only', health: 1, maxHealth: 1 })],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(keywordEvents(result.events, 'deathrattle')).toHaveLength(1)
    expect(result.state.players.P2.hand).toHaveLength(1)
  })

  it('连锁：深度优先单层队列——e1 亡语击杀 a1，a1 亡语在 e1 的步骤循环内展开，各自只触发一次', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', cardId: 'k-dt-nuke', health: 1, maxHealth: 1, keywords: ['deathrattle'] })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-nuke', health: 1, maxHealth: 1, keywords: ['deathrattle'] }),
        makeUnit({ ownerId: 'P2', instanceId: 'e2', health: 3, maxHealth: 3 }),
      ],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual([
      'ATTACK_DECLARED',
      'DAMAGE_DEALT', // a1 → e1（1 伤致死）
      'MINION_DIED', // e1
      'KEYWORD_TRIGGERED', // e1 亡语
      'DAMAGE_DEALT', // e1 亡语 → a1（1 伤致死）
      'MINION_DIED', // a1
      'KEYWORD_TRIGGERED', // a1 亡语（深度优先，嵌套展开）
      'DAMAGE_DEALT', // a1 亡语 → e2
      'DAMAGE_DEALT', // e1 亡语循环继续 → e2
    ])
    expect(result.state.board.find((u) => u.instanceId === 'e2')).toMatchObject({ health: 1 }) // 3 - 1 - 1
    expect(result.state.players.P1.graveyard).toEqual([{ instanceId: 'a1', cardId: 'k-dt-nuke' }])
    expect(result.state.players.P2.graveyard).toEqual([{ instanceId: 'e1', cardId: 'k-dt-nuke' }])
    // 攻击者已死于对方亡语：反击作废（无额外伤害事件），场上只剩 e2（无二次死亡结算）
    expect(result.state.board).toHaveLength(1)
  })

  it('致死：亡语伤害打空攻击方 CPU → 动作收尾 GAME_END（阵亡方获胜），后续动作拒绝', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-hero', health: 3, maxHealth: 3, keywords: ['deathrattle'] })],
      p1: { health: 5 },
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(result.state.players.P1.health).toBe(0) // 亡语 5 伤打穿 5 体质
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBe('P2')
    expect(result.events.at(-1)).toMatchObject({ type: 'GAME_END', winner: 'P2', reason: 'health_zero' })
    const error = catchRuleError(() => applyAction(result.state, endTurn('P2')))
    expect(error.code).toBe('GAME_ENDED')
  })

  it('快照语义：亡语事件 source 归到阵亡卡；亡者不再是 self 候选（不可自疗）', () => {
    // DamageSource.ref = 阵亡时快照 cardId
    const nuke = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 5, maxHealth: 5 })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-nuke', health: 1, maxHealth: 1, keywords: ['deathrattle'] }),
        makeUnit({ ownerId: 'P2', instanceId: 'e2', health: 5, maxHealth: 5 }),
      ],
    })
    const nuked = applyAction(nuke, atk('a1', unitRef('e1')))
    const drDamage = nuked.events.find((e) => e.type === 'DAMAGE_DEALT' && e.source.kind === 'effect')
    expect(drDamage).toMatchObject({ source: { kind: 'effect', ref: 'k-dt-nuke' } })

    // 亡语 heal self：单位已离场 → self 池为空 → 无 HEALING（快照只作上下文，不作目标）
    const healer = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 2, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-selfheal', health: 1, maxHealth: 1, keywords: ['deathrattle'] })],
    })
    const healed = applyAction(healer, atk('a1', unitRef('e1')))
    expect(healed.events.some((e) => e.type === 'HEALING')).toBe(false)
  })

  it('死亡来源全覆盖：buff 致死走亡语；destroy 离场不受质保抵挡且照常触发亡语（ENG6 原语将复用本管线）', () => {
    // buff 致死（无 DAMAGE_DEALT 事件，不触发 onDamaged，但亡语照常）
    const shrink = state({
      hand: [hc('h1', 'k-shrink')],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-draw', health: 1, maxHealth: 1, keywords: ['deathrattle'] })],
    })
    const shrunk = applyAction(shrink, playCard('h1'))
    expect(eventsOf(shrunk.events)).toEqual(['CARD_PLAYED', 'MINION_DIED', 'KEYWORD_TRIGGERED', 'CARD_DRAWN'])
    expect(shrunk.state.players.P2.hand).toHaveLength(1)

    // destroy cause：质保不抵挡移除类效果（§7），亡语照常（直接驱动死亡管线验证）
    const destroyState = state({
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-dt-draw', health: 1, maxHealth: 1, keywords: ['divine_shield', 'deathrattle'] })],
    })
    const unit = destroyState.board[0] as BoardUnit
    const events: GameEvent[] = []
    removeUnitFromBoard(destroyState, unit, 'destroy', events, createRng(1))
    expect(destroyState.board).toHaveLength(0)
    expect(keywordEvents(events, 'deathrattle')).toHaveLength(1)
    expect(destroyState.players.P2.hand).toHaveLength(1)
    expect(destroyState.players.P2.graveyard).toEqual([{ instanceId: 'e1', cardId: 'k-dt-draw' }])
  })
})

// ————————————————————————————————————————————————————————————
// overload（跳闸）
// ————————————————————————————————————————————————————————————

describe('overload（跳闸）矩阵', () => {
  it('触发（lockMana 步骤）：打出后 lockedMana 累加 + KEYWORD_TRIGGERED(overload)，下回合 BURN_OUT 生效后清零', () => {
    const initial = state({ hand: [hc('h1', 'k-ov-step')], turn: 1 })
    const played = applyAction(initial, playCard('h1'))
    expect(played.state.players.P1.lockedMana).toBe(200)
    expect(eventsOf(played.events)).toEqual(['CARD_PLAYED', 'CARD_DRAWN', 'KEYWORD_TRIGGERED'])
    expect(played.events[2]).toMatchObject({ keyword: 'overload', instanceId: 'h1' }) // driver 无场上实例：以手牌 uid 标识

    // P1 → P2 → P1（自身第 2 回合，maxMana 200）：BURN_OUT 200，可用功耗 0，锁定清零
    const t2 = applyAction(played.state, endTurn('P1'))
    const t3 = applyAction(t2.state, endTurn('P2'))
    expect(t3.state.players.P1).toMatchObject({ maxMana: 200, mana: 0, lockedMana: 0 })
    expect(t3.events.filter((e) => e.type === 'BURN_OUT')).toEqual([{ type: 'BURN_OUT', playerId: 'P1', lockedMana: 200 }])

    // 再转一圈不再重复发 BURN_OUT，供电恢复满额
    const t4 = applyAction(t3.state, endTurn('P1'))
    const t5 = applyAction(t4.state, endTurn('P2'))
    expect(t5.state.players.P1).toMatchObject({ maxMana: 300, mana: 300, lockedMana: 0 })
    expect(t5.events.filter((e) => e.type === 'BURN_OUT')).toHaveLength(0)
  })

  it('触发（兜底裁定）：无 lockMana 步骤的 overload 牌按 100W 处理', () => {
    const initial = state({ hand: [hc('h1', 'k-ov-fallback')] })
    const played = applyAction(initial, playCard('h1'))
    expect(played.state.players.P1.lockedMana).toBe(100)
    const overload = keywordEvents(played.events, 'overload')
    expect(overload).toHaveLength(1)
    expect((overload[0] as { detail: string }).detail).toContain('100W')
  })

  it('不触发：非 overload 牌的 lockMana 步骤只锁费不发关键词事件；对手与未打出时不锁定', () => {
    const initial = state({ hand: [hc('h1', 'k-ov-plain')] })
    const played = applyAction(initial, playCard('h1'))
    expect(played.state.players.P1.lockedMana).toBe(100)
    expect(keywordEvents(played.events, 'overload')).toEqual([])
    expect(played.state.players.P2.lockedMana).toBe(0)

    // 未打出的 overload 牌不锁定任何一方
    const idle = state({ hand: [hc('h1', 'k-ov-fallback')] })
    expect(idle.players.P1.lockedMana).toBe(0)
    expect(idle.players.P2.lockedMana).toBe(0)
  })

  it('叠加：多张牌与多 lockMana 步骤累加；gpu 战吼牌同样生效（instanceId 取场上实例）', () => {
    const initial = state({ hand: [hc('h1', 'k-ov-fallback'), hc('h2', 'k-ov-multi')], mana: 500 })
    const first = applyAction(initial, playCard('h1'))
    const second = applyAction(first.state, playCard('h2'))
    expect(second.state.players.P1.lockedMana).toBe(200) // 100（兜底）+ 50 + 50（两步）
    expect(keywordEvents([...first.events, ...second.events], 'overload')).toHaveLength(2)

    const gpuState = state({ hand: [hc('h1', 'k-ov-gpu')] })
    const gpuPlayed = applyAction(gpuState, playCard('h1'))
    expect(gpuPlayed.state.players.P1.lockedMana).toBe(300)
    expect(gpuPlayed.events.find((e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'overload'))
      .toMatchObject({ instanceId: 'u1' }) // gpu 有场上实例
    expect(gpuPlayed.state.board).toHaveLength(1) // 照常入场
  })

  it('边界：lockMana 步骤挂在非出牌时点（deathrattle）不作为 N 来源——出牌仍按兜底 100W 锁定', () => {
    // 亡语上的 lockMana 不会随出牌结算；若据此豁免兜底会出现"跳闸关键词可见却锁定 0W"的空洞
    const initial = state({ hand: [hc('h1', 'k-ov-dr-lock')] })
    const played = applyAction(initial, playCard('h1'))
    expect(played.state.players.P1.lockedMana).toBe(100) // 兜底，而非 0（亡语 999 未结算）
    const overload = keywordEvents(played.events, 'overload')
    expect(overload).toHaveLength(1)
    expect((overload[0] as { detail: string }).detail).toContain('100W')

    // 阵亡时亡语 lockMana 照常按步骤结算（叠加在兜底之上：100 + 999）
    const withEnemy = state({
      hand: [hc('h1', 'k-ov-dr-lock')],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e-plain', attack: 5, health: 5, maxHealth: 5 })],
    })
    const played2 = applyAction(withEnemy, playCard('h1'))
    expect(played2.state.players.P1.lockedMana).toBe(100)
    const turned = applyAction(played2.state, endTurn('P1')) // → P2 回合
    const attacked = applyAction(turned.state, atk('e-plain', unitRef('u1'), 'P2'))
    expect(attacked.state.players.P1.lockedMana).toBe(1099)
    expect(attacked.state.players.P1.graveyard).toEqual([{ instanceId: 'u1', cardId: 'k-ov-dr-lock' }])
  })
})

// ————————————————————————————————————————————————————————————
// onAttack / onDamaged 触发（schema 触发时点接线，ENG3 遗留收口）
// ————————————————————————————————————————————————————————————

describe('onAttack / onDamaged 触发接线', () => {
  it('onAttack 触发：宣告后、交换前结算——先增攻再交换，先手伤害取触发后的攻击值', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', cardId: 'k-oa-buff', attack: 2, health: 2, maxHealth: 2 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 1, health: 3, maxHealth: 3 })],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual([
      'ATTACK_DECLARED',
      'DAMAGE_DEALT', // 先手 2+1=3 伤（onAttack buff 生效后）
      'MINION_DIED', // e1 3→0
      'DAMAGE_DEALT', // 反击 1
    ])
    expect(result.events[1]).toMatchObject({ target: unitRef('e1'), amount: 3 })
    expect(result.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ attack: 3, health: 1 }) // buff 永久保留
  })

  it('onAttack 不触发：普通攻击无宣告阶段事件；防守方不触发 onAttack（受伤域属 onDamaged）', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-oa-buff', attack: 1, health: 4, maxHealth: 4 })],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'DAMAGE_DEALT'])
    // 防守方攻击力未被 onAttack buff（它不是攻击者）
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ attack: 1, health: 1 })
  })

  it('onAttack 致死防守方：攻击落空（无战斗交换、无反击），攻击预算照常消耗', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', cardId: 'k-oa-kill', attack: 1, health: 5, maxHealth: 5 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 2, health: 1, maxHealth: 1 })],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'MINION_DIED'])
    expect(result.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({
      health: 5, // 无反击
      attacksRemaining: 0, // 预算照常消耗
      attackedThisTurn: true,
    })
  })

  it('onAttack 自灭：攻击者死于自身触发 → 交换落空、防守方无伤（活性复核避免二次死亡结算）', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', cardId: 'k-oa-suicide', attack: 2, health: 2, maxHealth: 2 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 3, health: 3, maxHealth: 3 })],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual(['ATTACK_DECLARED', 'MINION_DIED'])
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ health: 3 })
    expect(result.state.players.P1.graveyard).toEqual([{ instanceId: 'a1', cardId: 'k-oa-suicide' }])
  })

  it('onDamaged 触发：受伤存活后结算（反伤先于防守方反击）；效果伤害同样触发', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 1, health: 5, maxHealth: 5 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-od-counter', attack: 1, health: 4, maxHealth: 4 })],
    })
    const result = applyAction(initial, atk('a1', unitRef('e1')))
    expect(eventsOf(result.events)).toEqual([
      'ATTACK_DECLARED',
      'DAMAGE_DEALT', // a1 → e1（1 伤，剩 3）
      'DAMAGE_DEALT', // e1 onDamaged 反伤 → a1（1）
      'DAMAGE_DEALT', // e1 反击 → a1（1）
    ])
    expect(result.events[2]).toMatchObject({ source: { kind: 'effect', ref: 'k-od-counter' }, target: unitRef('a1'), amount: 1 })
    expect(result.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 3 }) // 5 - 1 - 1
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ health: 3 })

    // 效果伤害路径：driver 直伤存活目标同样触发 onDamaged
    const boltState = state({
      hand: [hc('h1', 'k-bolt')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-own', health: 2, maxHealth: 2 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-od-counter', attack: 1, health: 4, maxHealth: 4 })],
    })
    const bolted = applyAction(boltState, playCard('h1', unitRef('e1')))
    expect(eventsOf(bolted.events)).toEqual(['CARD_PLAYED', 'DAMAGE_DEALT', 'DAMAGE_DEALT'])
    expect(bolted.state.board.find((u) => u.instanceId === 'u-own')).toMatchObject({ health: 1 }) // 反伤 1
  })

  it('onDamaged 不触发：质保完全抵挡视为未受伤；一击致死者走亡语域不触发 onDamaged', () => {
    // 质保抵挡：无反伤、攻击者满血
    const shielded = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 5, maxHealth: 5 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-od-counter', attack: 0, health: 4, maxHealth: 4, keywords: ['divine_shield'] })],
    })
    const blocked = applyAction(shielded, atk('a1', unitRef('e1')))
    expect(eventsOf(blocked.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'KEYWORD_TRIGGERED'])
    expect(blocked.state.board.find((u) => u.instanceId === 'a1')).toMatchObject({ health: 5 })
    expect(blocked.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ health: 4, keywords: [] })

    // 一击致死：onDamaged 的抽牌不发生（死亡只走亡语）
    const killed = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-od-draw', attack: 0, health: 1, maxHealth: 1 })],
    })
    const drawn = applyAction(killed, atk('a1', unitRef('e1')))
    expect(eventsOf(drawn.events)).toEqual(['ATTACK_DECLARED', 'DAMAGE_DEALT', 'MINION_DIED'])
    expect(drawn.state.players.P2.hand).toHaveLength(0)
  })
})

// ————————————————————————————————————————————————————————————
// divine_shield（三年质保）矩阵
// ————————————————————————————————————————————————————————————

describe('divine_shield（三年质保）矩阵', () => {
  it('触发：抵消任意金额的下一次伤害并消失（KEYWORD_TRIGGERED detail 可读）', () => {
    const initial = state({
      hand: [hc('h1', 'k-bolt')],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-shielded', health: 3, maxHealth: 3, keywords: ['divine_shield'] })],
    })
    const result = applyAction(initial, playCard('h1', unitRef('e1')))
    expect(result.events[1]).toMatchObject({ target: unitRef('e1'), amount: 3, remainingHealth: 3, shieldConsumed: true })
    expect(result.events[2]).toMatchObject({ keyword: 'divine_shield', instanceId: 'e1', detail: '三年质保已消耗，本次伤害被完全抵挡' })
    expect(result.state.board.find((u) => u.instanceId === 'e1')).toMatchObject({ health: 3, keywords: [] })
  })

  it('不触发：质保消耗后再次受伤正常扣血（shieldConsumed 只出现一次）', () => {
    const initial = state({
      hand: [hc('h1', 'k-bolt'), hc('h2', 'k-bolt')],
      mana: 500,
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', cardId: 'k-shielded', health: 3, maxHealth: 3, keywords: ['divine_shield'] })],
    })
    const first = applyAction(initial, playCard('h1', unitRef('e1')))
    const second = applyAction(first.state, playCard('h2', unitRef('e1')))
    expect(second.events[1]).toMatchObject({ target: unitRef('e1'), amount: 3, remainingHealth: 0 })
    expect('shieldConsumed' in (second.events[1] as object)).toBe(false)
    expect(second.state.board).toHaveLength(0) // 3 - 3 致死
  })

  it('叠加：重复授予不叠层（关键词去重，仍只抵一次）；消耗后重新授予可再次生效', () => {
    const grantTwice = state({
      hand: [hc('h1', 'k-grant-divine_shield'), hc('h2', 'k-grant-divine_shield')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u1', health: 3, maxHealth: 3, keywords: ['divine_shield'] })],
    })
    const once = applyAction(grantTwice, playCard('h1', unitRef('u1')))
    expect(once.state.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual(['divine_shield']) // 去重，不叠层
    const twice = applyAction(once.state, playCard('h2', unitRef('u1')))
    expect(twice.state.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual(['divine_shield'])

    // 双重授予后两次伤害：第一次被唯一一层质保抵消，第二次照常扣血（无第二层）
    const hitTwice = state({
      hand: [hc('h1', 'k-bolt'), hc('h2', 'k-bolt')],
      mana: 500,
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u1', health: 3, maxHealth: 3, keywords: ['divine_shield'] })],
    })
    const hit1 = applyAction(hitTwice, playCard('h1', unitRef('u1')))
    expect(hit1.events[1]).toMatchObject({ shieldConsumed: true, remainingHealth: 3 })
    const hit2 = applyAction(hit1.state, playCard('h2', unitRef('u1')))
    expect(hit2.events[1]).toMatchObject({ remainingHealth: 0 })
    expect('shieldConsumed' in (hit2.events[1] as object)).toBe(false)

    // 消耗后再授予：重新获得一层质保并再次生效
    const reGrant = state({
      hand: [hc('h1', 'k-grant-divine_shield')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u1', health: 3, maxHealth: 3 })],
    })
    const reGranted = applyAction(reGrant, playCard('h1', unitRef('u1')))
    expect(reGranted.state.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual(['divine_shield'])
    const reHit = state({
      hand: [hc('h1', 'k-bolt')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u1', health: 3, maxHealth: 3, keywords: ['divine_shield'] })],
    })
    const blocked = applyAction(reHit, playCard('h1', unitRef('u1')))
    expect(blocked.events[1]).toMatchObject({ shieldConsumed: true, remainingHealth: 3 })
  })
})

// ————————————————————————————————————————————————————————————
// stealth（无输出亮机）矩阵
// ————————————————————————————————————————————————————————————

describe('stealth（无输出亮机）矩阵', () => {
  it('触发：现身前不可被攻击、不可被指定（错误 detail 带原因）', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e-s', cardId: 'k-stealth', attack: 1, health: 2, maxHealth: 2, keywords: ['stealth'] })],
    })
    const attackError = catchRuleError(() => applyAction(initial, atk('a1', unitRef('e-s'))))
    expect(attackError.code).toBe('INVALID_TARGET')
    expect(attackError.detail).toMatchObject({ reason: 'stealth_hidden' })

    const boltState = state({
      hand: [hc('h1', 'k-bolt')],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e-s', cardId: 'k-stealth', health: 2, maxHealth: 2, keywords: ['stealth'] })],
    })
    const chosenError = catchRuleError(() => applyAction(boltState, playCard('h1', unitRef('e-s'))))
    expect(chosenError.code).toBe('INVALID_TARGET')
    expect(chosenError.detail).toMatchObject({ pool: 'anyCharacter' })
  })

  it('不保护：all 池全场效果照常命中潜行单位（「不可被指定」只约束 chosen）', () => {
    const initial = state({
      hand: [hc('h1', 'k-shrink')],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e-s', cardId: 'k-stealth', attack: 1, health: 2, maxHealth: 2, keywords: ['stealth'] })],
    })
    const result = applyAction(initial, playCard('h1'))
    const survivor = result.state.board.find((u) => u.instanceId === 'e-s')
    expect(survivor).toMatchObject({ health: 1 })
    expect(survivor?.keywords).toEqual(['stealth']) // 仍潜行
  })

  it('叠加：无叠加概念——重复授予去重；攻击现身即永久移除（后续回合不复隐、恢复可被指定）', () => {
    const grantTwice = state({
      hand: [hc('h1', 'k-grant-stealth'), hc('h2', 'k-grant-stealth')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u1', cardId: 'k-stealth', attack: 1, health: 2, maxHealth: 2, keywords: ['stealth'] })],
    })
    const once = applyAction(grantTwice, playCard('h1', unitRef('u1')))
    expect(once.state.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual(['stealth'])
    const twice = applyAction(once.state, playCard('h2', unitRef('u1')))
    expect(twice.state.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual(['stealth'])

    // 攻击现身 + KEYWORD_TRIGGERED；跨回合后不复隐、敌方可以指定它
    const attacker = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u1', cardId: 'k-stealth', attack: 1, health: 2, maxHealth: 2, keywords: ['stealth'] })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 1, health: 5, maxHealth: 5 })],
    })
    const revealed = applyAction(attacker, atk('u1', unitRef('e1')))
    expect(revealed.state.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual([])
    expect(keywordEvents(revealed.events, 'stealth')).toHaveLength(1)

    const p2Turn = applyAction(revealed.state, endTurn('P1')).state // → P2 回合
    expect(p2Turn.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual([]) // 永久移除，不复隐
    const enemyAttacks = getLegalActions(p2Turn, 'P2').filter(
      (a): a is AttackAction => a.type === 'ATTACK' && a.attackerId === 'e1',
    )
    expect(enemyAttacks).toContainEqual({ type: 'ATTACK', playerId: 'P2', attackerId: 'e1', target: unitRef('u1') })
  })
})

// ————————————————————————————————————————————————————————————
// taunt（信仰充值）/ charge（超频）/ windfury（双芯 GPU）补矩阵
// ————————————————————————————————————————————————————————————

describe('taunt（信仰充值）矩阵', () => {
  it('触发：存在 taunt 时攻击其他目标被拒（TAUNT_BLOCKING）', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e-t', cardId: 'k-taunt', health: 4, maxHealth: 4, keywords: ['taunt'] }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-p', health: 2, maxHealth: 2 }),
      ],
    })
    const error = catchRuleError(() => applyAction(initial, atk('a1', unitRef('e-p'))))
    expect(error.code).toBe('TAUNT_BLOCKING')
    expect(catchRuleError(() => applyAction(initial, atk('a1', heroRef('P2')))).code).toBe('TAUNT_BLOCKING')
  })

  it('不触发：removeKeyword 移除后即可绕过；grantKeyword 授予后立即拦截', () => {
    // 移除后绕过
    const strip = state({
      hand: [hc('h1', 'k-strip-taunt')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e-t', cardId: 'k-taunt', attack: 1, health: 4, maxHealth: 4, keywords: ['taunt'] })],
    })
    const stripped = applyAction(strip, playCard('h1', unitRef('e-t')))
    expect(stripped.state.board.find((u) => u.instanceId === 'e-t')?.keywords).toEqual([])
    const through = applyAction(stripped.state, atk('a1', heroRef('P2')))
    expect(through.state.players.P2.health).toBe(27) // 绕过成功

    // P2 回合给自己单位即时授予 taunt；转回 P1 后攻击其非 taunt 单位被拦截
    const p2Grant = makeGameState({
      turn: 3,
      activePlayer: 'P2',
      players: {
        P1: { ...makePlayer('P1'), deck: deckOf() },
        P2: { ...makePlayer('P2'), hand: [hc('h1', 'k-grant-taunt')], mana: 500, maxMana: 500, deck: deckOf() },
      },
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-p', health: 2, maxHealth: 2 }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-q', health: 2, maxHealth: 2 }),
      ],
    })
    const granted = applyAction(p2Grant, { type: 'PLAY_CARD', playerId: 'P2', uid: 'h1', target: unitRef('e-p') })
    expect(granted.state.board.find((u) => u.instanceId === 'e-p')?.keywords).toEqual(['taunt'])
    const p1Turn = applyAction(granted.state, endTurn('P2')) // → P1 回合
    const blocked = catchRuleError(() => applyAction(p1Turn.state, atk('a1', unitRef('e-q'))))
    expect(blocked.code).toBe('TAUNT_BLOCKING')
  })

  it('叠加：多个 taunt 并存全部拦截，攻击方任选其一', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 3, health: 3, maxHealth: 3 })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e-t1', health: 2, maxHealth: 2, keywords: ['taunt'] }),
        makeUnit({ ownerId: 'P2', instanceId: 'e-t2', health: 2, maxHealth: 2, keywords: ['taunt'] }),
      ],
    })
    expect(catchRuleError(() => applyAction(initial, atk('a1', heroRef('P2')))).code).toBe('TAUNT_BLOCKING')
    const hitT2 = applyAction(initial, atk('a1', unitRef('e-t2')))
    expect(hitT2.state.board.some((u) => u.instanceId === 'e-t2')).toBe(false)
    expect(hitT2.state.board.some((u) => u.instanceId === 'e-t1')).toBe(true)
  })
})

describe('charge（超频）矩阵', () => {
  it('触发：入场当回合即可攻击', () => {
    const initial = state({ hand: [hc('h1', 'k-charged')] })
    const played = applyAction(initial, playCard('h1'))
    const attacked = applyAction(played.state, atk('u1', heroRef('P2')))
    expect(attacked.state.players.P2.health).toBe(27)
  })

  it('不触发：无 charge 的单位入场当回合攻击被拒（summoning_sickness）', () => {
    const initial = state({ hand: [hc('h1', 'k-vanilla')] })
    const played = applyAction(initial, playCard('h1'))
    const error = catchRuleError(() => applyAction(played.state, atk('u1', heroRef('P2'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'summoning_sickness' })
  })

  it('叠加：charge × windfury 当回合两次攻击（预算 2，非叠加成 4）；重复授予 charge 去重', () => {
    const initial = state({
      hand: [hc('h1', 'k-dual'), hc('h2', 'k-grant-charge')],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', health: 2, maxHealth: 2 })],
    })
    const played = applyAction(initial, playCard('h1'))
    const granted = applyAction(played.state, playCard('h2', unitRef('u1')))
    expect(granted.state.board.find((u) => u.instanceId === 'u1')?.keywords).toEqual(['charge', 'windfury']) // 去重

    const first = applyAction(granted.state, atk('u1', unitRef('e1')))
    expect(first.state.board.find((u) => u.instanceId === 'u1')).toMatchObject({ attacksRemaining: 1 })
    const second = applyAction(first.state, atk('u1', heroRef('P2')))
    expect(second.state.players.P2.health).toBe(28)
    const third = catchRuleError(() => applyAction(second.state, atk('u1', heroRef('P2'))))
    expect(third.code).toBe('UNIT_CANNOT_ATTACK')
  })
})

describe('windfury（双芯 GPU）矩阵', () => {
  it('触发：每回合两次攻击', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'wf', cardId: 'k-wf', attack: 2, health: 2, maxHealth: 2, keywords: ['windfury'], attacksRemaining: 2 })],
      enemyBoard: [
        makeUnit({ ownerId: 'P2', instanceId: 'e1', attack: 0, health: 2, maxHealth: 2 }),
        makeUnit({ ownerId: 'P2', instanceId: 'e2', attack: 0, health: 2, maxHealth: 2 }),
      ],
    })
    const first = applyAction(initial, atk('wf', unitRef('e1')))
    const second = applyAction(first.state, atk('wf', unitRef('e2')))
    expect(second.state.board.filter((u) => u.ownerId === 'P2')).toHaveLength(0)
    expect(second.state.board.find((u) => u.instanceId === 'wf')).toMatchObject({ attacksRemaining: 0 })
  })

  it('不触发：普通单位一次攻击后即被拒（no_attacks_remaining）', () => {
    const initial = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'a1', attack: 2, health: 2, maxHealth: 2 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', health: 3, maxHealth: 3 })],
    })
    const first = applyAction(initial, atk('a1', unitRef('e1')))
    const error = catchRuleError(() => applyAction(first.state, atk('a1', unitRef('e1'))))
    expect(error.code).toBe('UNIT_CANNOT_ATTACK')
    expect(error.detail).toMatchObject({ reason: 'no_attacks_remaining' })
  })

  it('叠加：重复授予不叠层（仍 2 次/回合），回合开始重置回 2 而非 4', () => {
    const grant = state({
      hand: [hc('h1', 'k-grant-windfury')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'wf', cardId: 'k-wf', attack: 1, health: 5, maxHealth: 5, keywords: ['windfury'], attacksRemaining: 2 })],
    })
    const granted = applyAction(grant, playCard('h1', unitRef('wf')))
    expect(granted.state.board.find((u) => u.instanceId === 'wf')?.keywords).toEqual(['windfury'])

    // 两发耗尽 → 第三次拒绝；跨回合重置仍为 2
    const attacker = state({
      board: [makeUnit({ ownerId: 'P1', instanceId: 'wf', cardId: 'k-wf', attack: 1, health: 5, maxHealth: 5, keywords: ['windfury'], attacksRemaining: 2 })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'e1', health: 5, maxHealth: 5 })],
    })
    const first = applyAction(attacker, atk('wf', unitRef('e1')))
    const second = applyAction(first.state, atk('wf', unitRef('e1')))
    const third = catchRuleError(() => applyAction(second.state, atk('wf', unitRef('e1'))))
    expect(third.code).toBe('UNIT_CANNOT_ATTACK')

    const nextRound = advanceOneRound(second.state)
    expect(nextRound.board.find((u) => u.instanceId === 'wf')?.attacksRemaining).toBe(2)
  })
})
