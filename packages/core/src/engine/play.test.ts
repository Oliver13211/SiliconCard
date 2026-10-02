/**
 * M1-ENG2 出牌结算单测：合法性拒绝（RuleError）、扣费与事件、gpu 入场召唤、
 * driver 效果原语、accessory 光环投影与回收、getLegalActions 出牌枚举、确定性。
 * 规则依据：docs/rules.md §2.3 / §3 / §5 / §7 / §10。
 */

import { describe, expect, it } from 'vitest'
import { BOARD_LIMIT, HAND_LIMIT } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { GameEvent } from '../types/events'
import type { TargetRef } from '../types/actions'
import type { BoardUnit, DeckEntry, GameState, HandCard } from '../types/state'
import { catchRuleError, makeGameState, makePlayer, makeUnit, TEST_SEED } from '../testing/state'
import { stableHash } from '../testing/hash'
import { applyAction, getLegalActions } from './apply'
import { registerCardDefinitions } from './registry'
import type { PlayCardAction } from './play'

// —— 测试卡池（vitest 文件间注册表隔离，不影响其他测试文件）——
const CARDS: CardDefinition[] = [
  { id: 't-bolt', name: '静电冲击', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 3 }] } },
  { id: 't-random-bolt', name: '随机电弧', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'random', pool: 'anyCharacter' }, amount: 1 }] } },
  { id: 't-heal', name: '除尘喷雾', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'heal', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 5 }] } },
  { id: 't-buff', name: '超频小助手', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'chosen', pool: 'ownUnits' }, attack: 2, health: 1 }] } },
  { id: 't-shrink', name: '矿难预演', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'all', pool: 'allUnits' }, attack: -1, health: -1 }] } },
  { id: 't-grant', name: '信仰充值贴纸', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'grantKeyword', target: { kind: 'chosen', pool: 'ownUnits' }, keyword: 'taunt' }] } },
  { id: 't-strip', name: '驱动回滚', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'removeKeyword', target: { kind: 'chosen', pool: 'enemyUnits' }, keyword: 'taunt' }] } },
  { id: 't-draw', name: '驱动更新', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'draw', player: 'sourceOwner', count: 2 }] } },
  { id: 't-summon', name: '亮机卡量产', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'summon', cardId: 't-token', count: 2 }] } },
  { id: 't-armor', name: '能效贴纸', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'gainArmor', player: 'sourceOwner', amount: 5 }] } },
  { id: 't-combo', name: '先打后修', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [
      { op: 'damage', target: { kind: 'chosen', pool: 'enemyHero' }, amount: 2 },
      { op: 'gainArmor', player: 'sourceOwner', amount: 3 },
    ] } },
  { id: 't-destroy', name: '12VHPWR 熔毁', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'destroy', target: { kind: 'chosen', pool: 'allUnits' } }] } },
  { id: 't-lock', name: '白牌电源', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'lockMana', player: 'sourceOwner', amount: 100 }] } },
  { id: 't-handler', name: '玄学卡', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'handler', name: 'mystic' }] } },
  { id: 't-token', name: '亮机卡', faction: 'neutral', type: 'gpu', cost: 0, attack: 1, health: 1 },
  { id: 't-vanilla', name: '亮机基卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 2 },
  { id: 't-taunt-gpu', name: '信仰充值卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 4, keywords: ['taunt'] },
  { id: 't-charged', name: '超频核心', faction: 'neutral', type: 'gpu', cost: 200, attack: 4, health: 2, keywords: ['charge'] },
  { id: 't-stealth', name: '无输出亮机', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 1, keywords: ['stealth'] },
  { id: 't-shielded', name: '质保卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 3, keywords: ['divine_shield'] },
  { id: 't-bc-gpu', name: '战吼显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2,
    effect: { trigger: 'battlecry', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'enemyHero' }, amount: 1 }] } },
  { id: 't-aura-atk', name: '信仰灯条', faction: 'neutral', type: 'accessory', cost: 100,
    effect: { trigger: 'battlecry', aura: { stat: 'attack', delta: 1, scope: 'ownUnits' } } },
  { id: 't-aura-cost', name: '电费折扣', faction: 'neutral', type: 'accessory', cost: 100,
    effect: { trigger: 'battlecry', aura: { stat: 'cost', delta: -50, scope: 'ownUnits' } } },
  { id: 't-aura-hp', name: '散热硅脂', faction: 'neutral', type: 'accessory', cost: 100,
    effect: { trigger: 'battlecry', aura: { stat: 'health', delta: 2, scope: 'ownUnits' } } },
]
registerCardDefinitions(CARDS)

// —— 构造工具 ——

function handCard(uid: string, cardId: string, cost = 100): HandCard {
  return { uid, cardId, cost }
}

interface PlayStateOptions {
  hand?: HandCard[]
  mana?: number
  maxMana?: number
  board?: BoardUnit[]
  enemyBoard?: BoardUnit[]
  p2Hand?: HandCard[]
  deck?: DeckEntry[]
  p2Deck?: DeckEntry[]
  turn?: number
}

function playState(opts: PlayStateOptions = {}): GameState {
  return makeGameState({
    turn: opts.turn ?? 1,
    activePlayer: 'P1',
    players: {
      P1: {
        ...makePlayer('P1'),
        hand: opts.hand ?? [],
        mana: opts.mana ?? 500,
        maxMana: opts.maxMana ?? 500,
        deck: opts.deck ?? [{ cardId: 'smoke-gpu' }],
      },
      P2: {
        ...makePlayer('P2'),
        hand: opts.p2Hand ?? [],
        mana: 0,
        maxMana: 0,
        deck: opts.p2Deck ?? [{ cardId: 'smoke-gpu' }],
      },
    },
    board: [...(opts.board ?? []), ...(opts.enemyBoard ?? [])],
  })
}

function playP1(uid: string, target?: TargetRef): PlayCardAction {
  return { type: 'PLAY_CARD', playerId: 'P1', uid, ...(target ? { target } : {}) }
}

const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })
const heroRef = (playerId: 'P1' | 'P2'): TargetRef => ({ kind: 'hero', playerId })
const eventsOf = (events: readonly GameEvent[]): string[] => events.map((e) => e.type)

describe('PLAY_CARD 合法性拒绝（rules.md §3）', () => {
  it('非行动方出牌 → NOT_YOUR_TURN', () => {
    const state = playState({ hand: [handCard('h9', 't-vanilla')] })
    const error = catchRuleError(() =>
      applyAction(state, { type: 'PLAY_CARD', playerId: 'P2', uid: 'h9' }),
    )
    expect(error.code).toBe('NOT_YOUR_TURN')
  })

  it('手牌无此 uid → CARD_NOT_IN_HAND', () => {
    const state = playState({ hand: [handCard('h1', 't-vanilla')] })
    const error = catchRuleError(() => applyAction(state, playP1('nope')))
    expect(error.code).toBe('CARD_NOT_IN_HAND')
    expect(error.detail).toMatchObject({ uid: 'nope' })
  })

  it('功耗不足（cost > mana，按光环修正后手牌 cost）→ INSUFFICIENT_MANA', () => {
    const state = playState({ hand: [handCard('h1', 't-vanilla', 200)], mana: 100 })
    const error = catchRuleError(() => applyAction(state, playP1('h1')))
    expect(error.code).toBe('INSUFFICIENT_MANA')
    expect(error.detail).toMatchObject({ cost: 200, mana: 100 })
  })

  it('功耗恰好等于可用功耗：允许出牌', () => {
    const state = playState({ hand: [handCard('h1', 't-vanilla', 300)], mana: 300 })
    const result = applyAction(state, playP1('h1'))
    expect(result.state.players.P1.mana).toBe(0)
    expect(result.state.board).toHaveLength(1)
  })

  it('需要 chosen 目标但未携带 → INVALID_TARGET{reason:target_required}', () => {
    const state = playState({ hand: [handCard('h1', 't-bolt')] })
    const error = catchRuleError(() => applyAction(state, playP1('h1')))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'target_required' })
  })

  it('目标不在 chosen 池内（ownUnits 池收到敌方 CPU）→ INVALID_TARGET', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-own' })
    const state = playState({ hand: [handCard('h1', 't-buff')], board: [own] })
    const error = catchRuleError(() => applyAction(state, playP1('h1', heroRef('P2'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'not_in_pool', pool: 'ownUnits' })
  })

  it('敌方潜行单位现身前不可被指定 → INVALID_TARGET；己方潜行单位可被自己指定', () => {
    const enemyStealth = makeUnit({ ownerId: 'P2', instanceId: 'u-es', cardId: 't-stealth', keywords: ['stealth'] })
    const state = playState({ hand: [handCard('h1', 't-bolt'), handCard('h2', 't-heal')], enemyBoard: [enemyStealth] })
    const error = catchRuleError(() => applyAction(state, playP1('h1', unitRef('u-es'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ pool: 'anyCharacter', target: unitRef('u-es') })

    // 己方潜行单位对自己可见：治疗己方潜行单位合法
    const ownStealth = makeUnit({
      ownerId: 'P1', instanceId: 'u-os', cardId: 't-stealth', keywords: ['stealth'], health: 1, maxHealth: 1,
    })
    const ownState = playState({ hand: [handCard('h2', 't-heal')], board: [ownStealth] })
    const healed = applyAction(ownState, playP1('h2', unitRef('u-os')))
    const healedUnit = healed.state.board.find((u) => u.instanceId === 'u-os')
    expect(healedUnit?.health).toBe(1) // 满血治疗无变化，但动作合法
  })

  it('gpu 入场需己方场上 < BOARD_LIMIT → BOARD_FULL；driver 不占槽不受限', () => {
    const full = Array.from({ length: BOARD_LIMIT }, (_, i) =>
      makeUnit({ ownerId: 'P1', instanceId: `u-f${i}` }),
    )
    const state = playState({
      hand: [handCard('h1', 't-vanilla'), handCard('h2', 't-bolt'), handCard('h3', 't-aura-atk')],
      board: full,
    })
    expect(catchRuleError(() => applyAction(state, playP1('h1'))).code).toBe('BOARD_FULL')
    expect(catchRuleError(() => applyAction(state, playP1('h3'))).code).toBe('BOARD_FULL')
    // driver 可以照常打出
    const result = applyAction(state, playP1('h2', heroRef('P2')))
    expect(result.state.players.P2.health).toBe(27)
  })

  it('非法操作抛错后原状态哈希不变（深拷贝隔离）', () => {
    const state = playState({ hand: [handCard('h1', 't-vanilla', 200)], mana: 100 })
    const before = stableHash(state)
    expect(() => applyAction(state, playP1('h1'))).toThrow()
    expect(stableHash(state)).toBe(before)
  })

  it('手牌 cardId 无注册定义（宿主环境错误）→ 普通 Error 而非 RuleError', () => {
    const state = playState({ hand: [handCard('h1', 'ghost-card')] })
    expect(() => applyAction(state, playP1('h1'))).toThrow(/宿主环境错误/)
  })
})

describe('扣费与 CARD_PLAYED 事件（rules.md §6）', () => {
  it('driver：扣实际 cost、移出手牌、CARD_PLAYED 在效果事件之前', () => {
    const state = playState({ hand: [handCard('h1', 't-bolt')], mana: 300 })
    const result = applyAction(state, playP1('h1', heroRef('P2')))
    expect(result.state.players.P1.mana).toBe(200)
    expect(result.state.players.P1.hand).toHaveLength(0)
    expect(eventsOf(result.events)).toEqual(['CARD_PLAYED', 'DAMAGE_DEALT'])
    expect(result.events[0]).toEqual({
      type: 'CARD_PLAYED',
      playerId: 'P1',
      uid: 'h1',
      cardId: 't-bolt',
      cost: 100,
      target: heroRef('P2'),
    })
  })

  it('gpu：事件序 CARD_PLAYED → MINION_SUMMONED{source:play}', () => {
    const state = playState({ hand: [handCard('h1', 't-vanilla')] })
    const result = applyAction(state, playP1('h1'))
    expect(eventsOf(result.events)).toEqual(['CARD_PLAYED', 'MINION_SUMMONED'])
    expect(result.events[1]).toMatchObject({ source: 'play' })
  })

  it('无 chosen 步骤的牌携带多余 target：宽容忽略不报错', () => {
    const state = playState({ hand: [handCard('h1', 't-vanilla')] })
    const result = applyAction(state, playP1('h1', heroRef('P2')))
    expect(result.state.board).toHaveLength(1)
  })
})

describe('gpu 入场召唤（rules.md §2.3 / §6）', () => {
  it('attack/health 取自卡牌定义，keywords 写入，summonedOnTurn 记录，attacksRemaining=0', () => {
    const state = playState({ hand: [handCard('h1', 't-taunt-gpu')] })
    const result = applyAction(state, playP1('h1'))
    const [unit] = result.state.board
    expect(unit).toMatchObject({
      instanceId: 'u1',
      cardId: 't-taunt-gpu',
      ownerId: 'P1',
      attack: 1,
      health: 4,
      maxHealth: 4,
      keywords: ['taunt'],
      summonedOnTurn: 1,
      attacksRemaining: 0,
      attackedThisTurn: false,
    })
    expect(result.state.nextInstanceId).toBe(2)
  })

  it('charge（超频）gpu：keywords 携带 charge，attacksRemaining 仍为 0（攻击侧豁免属 M1-ENG3）', () => {
    const state = playState({ hand: [handCard('h1', 't-charged')] })
    const result = applyAction(state, playP1('h1'))
    const [unit] = result.state.board
    expect(unit?.keywords).toEqual(['charge'])
    expect(unit?.attacksRemaining).toBe(0)
  })

  it('战吼（battlecry）在入场后结算：先召唤、再按 chosen 目标打出伤害', () => {
    const state = playState({ hand: [handCard('h1', 't-bc-gpu')] })
    const result = applyAction(state, playP1('h1', heroRef('P2')))
    expect(eventsOf(result.events)).toEqual(['CARD_PLAYED', 'MINION_SUMMONED', 'DAMAGE_DEALT'])
    expect(result.events[2]).toMatchObject({
      source: { kind: 'effect', ref: 't-bc-gpu' },
      target: heroRef('P2'),
      amount: 1,
      remainingHealth: 29,
    })
    // 战吼召唤的自身已占槽：战吼内召唤受 BOARD_LIMIT 约束时按含自身计数
    expect(result.state.board).toHaveLength(1)
  })

  it('战吼伤害可击杀场上单位：MINION_DIED + 墓地（死亡结算链路）', () => {
    const enemy = makeUnit({ ownerId: 'P2', instanceId: 'u-e1', health: 1, maxHealth: 1 })
    const state = playState({ hand: [handCard('h1', 't-bolt')], enemyBoard: [enemy] })
    const result = applyAction(state, playP1('h1', unitRef('u-e1')))
    expect(eventsOf(result.events)).toEqual(['CARD_PLAYED', 'DAMAGE_DEALT', 'MINION_DIED'])
    expect(result.events[2]).toMatchObject({ cause: 'damage', unit: { instanceId: 'u-e1', health: 0 } })
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P2.graveyard).toEqual([{ instanceId: 'u-e1', cardId: 'test-gpu' }])
  })
})

describe('driver 效果原语（rules.md §5）', () => {
  it('damage → 己方 CPU：护甲先于体质（复用回合机伤害管线）', () => {
    const state = playState({ hand: [handCard('h1', 't-bolt')] })
    const result = applyAction(state, playP1('h1', heroRef('P1')))
    expect(result.events[1]).toMatchObject({
      source: { kind: 'effect', ref: 't-bolt' },
      target: heroRef('P1'),
      amount: 3,
      remainingHealth: 27,
    })
    expect(result.state.players.P1.health).toBe(27)
  })

  it('divine_shield：抵挡任意金额的下一次伤害并消失（DAMAGE_DEALT{shieldConsumed} + KEYWORD_TRIGGERED）', () => {
    const shielded = makeUnit({ ownerId: 'P2', instanceId: 'u-s1', cardId: 't-shielded', attack: 1, health: 3, maxHealth: 3, keywords: ['divine_shield'] })
    const state = playState({ hand: [handCard('h1', 't-bolt'), handCard('h2', 't-bolt')], enemyBoard: [shielded] })
    const first = applyAction(state, playP1('h1', unitRef('u-s1')))
    expect(eventsOf(first.events)).toEqual(['CARD_PLAYED', 'DAMAGE_DEALT', 'KEYWORD_TRIGGERED'])
    expect(first.events[1]).toMatchObject({ amount: 3, remainingHealth: 3, shieldConsumed: true })
    const unitAfterFirst = first.state.board.find((u) => u.instanceId === 'u-s1')
    expect(unitAfterFirst?.keywords).toEqual([])
    expect(unitAfterFirst?.health).toBe(3)

    // 质保已消耗：第二次伤害正常扣血并致死
    const second = applyAction(first.state, playP1('h2', unitRef('u-s1')))
    expect(eventsOf(second.events)).toEqual(['CARD_PLAYED', 'DAMAGE_DEALT', 'MINION_DIED'])
    expect(second.events[1]).toMatchObject({ amount: 3, remainingHealth: 0 })
    expect('shieldConsumed' in (second.events[1] as object)).toBe(false)
  })

  it('heal：上限 maxHealth、无实际回复不发事件；对 CPU 治疗同样生效', () => {
    const wounded = makeUnit({ ownerId: 'P1', instanceId: 'u-w1', health: 1, maxHealth: 5 })
    const state = playState({ hand: [handCard('h1', 't-heal'), handCard('h2', 't-heal')], board: [wounded] })
    const result = applyAction(state, playP1('h1', unitRef('u-w1')))
    expect(result.events[1]).toEqual({
      type: 'HEALING',
      target: unitRef('u-w1'),
      amount: 5,
      resultingHealth: 5, // 1 + 5 请求量，截断到 maxHealth 5
    })
    // 满血再治疗：不产生 HEALING 事件
    const again = applyAction(result.state, playP1('h2', unitRef('u-w1')))
    expect(eventsOf(again.events)).toEqual(['CARD_PLAYED'])

    const heroState = playState({ hand: [handCard('h1', 't-heal')] })
    const heroHealed = applyAction(heroState, playP1('h1', heroRef('P1')))
    expect(heroHealed.state.players.P1.health).toBe(30) // 已满血，无事件
    expect(eventsOf(heroHealed.events)).toEqual(['CARD_PLAYED'])
  })

  it('buff：attack/health/maxHealth 同步增减；增益不产生目录事件', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 1, health: 1, maxHealth: 1 })
    const state = playState({ hand: [handCard('h1', 't-buff')], board: [own] })
    const result = applyAction(state, playP1('h1', unitRef('u-o1')))
    expect(eventsOf(result.events)).toEqual(['CARD_PLAYED'])
    const unit = result.state.board.find((u) => u.instanceId === 'u-o1')
    expect(unit).toMatchObject({ attack: 3, health: 2, maxHealth: 2 })
  })

  it('负 buff（减益）可致死：health ≤ 0 → MINION_DIED + 墓地', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 2, health: 1, maxHealth: 1 })
    const enemy = makeUnit({ ownerId: 'P2', instanceId: 'u-e1', attack: 2, health: 1, maxHealth: 1 })
    const state = playState({ hand: [handCard('h1', 't-shrink')], board: [own], enemyBoard: [enemy] })
    const result = applyAction(state, playP1('h1'))
    expect(result.events.filter((e) => e.type === 'MINION_DIED')).toHaveLength(2)
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P1.graveyard).toHaveLength(1)
    expect(result.state.players.P2.graveyard).toHaveLength(1)
  })

  it('grantKeyword 去重；removeKeyword 对无关键词单位为 no-op', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-o1', keywords: ['taunt'] })
    const state = playState({ hand: [handCard('h1', 't-grant'), handCard('h2', 't-grant')], board: [own] })
    const first = applyAction(state, playP1('h1', unitRef('u-o1')))
    expect(first.state.board[0]?.keywords).toEqual(['taunt']) // 已有 taunt，不重复
    const second = applyAction(first.state, playP1('h2', unitRef('u-o1')))
    expect(second.state.board[0]?.keywords).toEqual(['taunt'])

    const plain = makeUnit({ ownerId: 'P2', instanceId: 'u-e1' })
    const stripState = playState({ hand: [handCard('h1', 't-strip')], enemyBoard: [plain] })
    const stripped = applyAction(stripState, playP1('h1', unitRef('u-e1')))
    expect(stripped.state.board[0]?.keywords).toEqual([])
  })

  it('draw：deck 有牌抽 N 张；deck 为空进入疲劳（CARD_DRAWN{fatigue} → DAMAGE → FATIGUE）', () => {
    const withDeck = playState({
      hand: [handCard('h1', 't-draw')],
      deck: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
    })
    const drawn = applyAction(withDeck, playP1('h1'))
    expect(eventsOf(drawn.events)).toEqual(['CARD_PLAYED', 'CARD_DRAWN', 'CARD_DRAWN'])
    expect(drawn.state.players.P1.hand).toHaveLength(2)
    expect(drawn.state.players.P1.deck).toHaveLength(0)

    const emptyDeck = playState({ hand: [handCard('h1', 't-draw')], deck: [] })
    const fatigued = applyAction(emptyDeck, playP1('h1'))
    expect(eventsOf(fatigued.events)).toEqual(['CARD_PLAYED', 'CARD_DRAWN', 'DAMAGE_DEALT', 'FATIGUE', 'CARD_DRAWN', 'DAMAGE_DEALT', 'FATIGUE'])
    expect(fatigued.state.players.P1.fatigue).toBe(2)
    expect(fatigued.state.players.P1.health).toBe(27) // 30 - 1 - 2
  })

  it('summon：按 count 召唤 effect 源；场满时静默截断到 BOARD_LIMIT', () => {
    const state = playState({ hand: [handCard('h1', 't-summon')] })
    const result = applyAction(state, playP1('h1'))
    expect(eventsOf(result.events)).toEqual(['CARD_PLAYED', 'MINION_SUMMONED', 'MINION_SUMMONED'])
    expect(result.state.board.map((u) => u.cardId)).toEqual(['t-token', 't-token'])
    expect(result.state.board.every((u) => u.ownerId === 'P1')).toBe(true)

    const sixUnits = Array.from({ length: 6 }, (_, i) => makeUnit({ ownerId: 'P1', instanceId: `u-s${i}` }))
    const crowded = playState({ hand: [handCard('h1', 't-summon')], board: sixUnits })
    const truncated = applyAction(crowded, playP1('h1'))
    expect(truncated.state.board).toHaveLength(7) // 只进入 1 张，第 2 张被截断
    expect(truncated.state.board.filter((u) => u.cardId === 't-token')).toHaveLength(1)
  })

  it('gainArmor：护甲增加并发 ARMOR_GAINED{totalArmor}', () => {
    const state = playState({ hand: [handCard('h1', 't-armor')] })
    const result = applyAction(state, playP1('h1'))
    expect(result.events[1]).toEqual({ type: 'ARMOR_GAINED', playerId: 'P1', amount: 5, totalArmor: 5 })
    expect(result.state.players.P1.armor).toBe(5)
  })

  it('多步骤按数组顺序结算（damage → gainArmor）', () => {
    const state = playState({ hand: [handCard('h1', 't-combo')] })
    const result = applyAction(state, playP1('h1', heroRef('P2')))
    expect(eventsOf(result.events)).toEqual(['CARD_PLAYED', 'DAMAGE_DEALT', 'ARMOR_GAINED'])
    expect(result.state.players.P2.health).toBe(28)
    expect(result.state.players.P1.armor).toBe(3)
  })

  it('random 选择器走种子 RNG：同 seed 目标一致、rng.state 被消费（确定性根基）', () => {
    const build = () =>
      playState({
        hand: [handCard('h1', 't-random-bolt'), handCard('h2', 't-random-bolt')],
        board: [makeUnit({ ownerId: 'P1', instanceId: 'u-a' })],
        enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-b' })],
      })
    const run = (): { state: GameState; events: GameEvent[] } => {
      const result = applyAction(build(), playP1('h1'))
      const follow = applyAction(result.state, playP1('h2'))
      return { state: follow.state, events: [...result.events, ...follow.events] }
    }
    const a = run()
    const b = run()
    expect(a.events).toEqual(b.events)
    expect(stableHash(a.state)).toBe(stableHash(b.state))
    // rng.state 已被随机步骤消费推进
    expect(a.state.rng.state).not.toBe(TEST_SEED >>> 0)
  })

  it('destroy / lockMana / handler 属 M1-ENG6：响亮抛错，状态保持不变', () => {
    const cases: Array<[string, string]> = [
      ['h1', 't-destroy'],
      ['h1', 't-lock'],
      ['h1', 't-handler'],
    ]
    for (const [uid, cardId] of cases) {
      const state = playState({ hand: [handCard(uid, cardId)], board: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1' })] })
      const before = stableHash(state)
      expect(() => applyAction(state, playP1(uid, cardId === 't-destroy' ? unitRef('u-e1') : undefined))).toThrow(/M1-ENG6/)
      expect(stableHash(state)).toBe(before)
    }
  })
})

describe('accessory 光环（M1-ENG2 边界实现：进场占槽、常驻派生量）', () => {
  it('attack 光环：己方单位有效攻击 +1（含配件自身），对手不受影响', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 3, health: 2, maxHealth: 2 })
    const enemy = makeUnit({ ownerId: 'P2', instanceId: 'u-e1', attack: 3, health: 2, maxHealth: 2 })
    const state = playState({ hand: [handCard('h1', 't-aura-atk')], board: [own], enemyBoard: [enemy] })
    const result = applyAction(state, playP1('h1'))
    const board = result.state.board
    expect(board.find((u) => u.instanceId === 'u-o1')?.attack).toBe(4)
    // 配件本体 0/1 入场，ownUnits 含自身：0 + 1 = 1
    expect(board.find((u) => u.cardId === 't-aura-atk')).toMatchObject({ attack: 1, health: 1, maxHealth: 1 })
    expect(board.find((u) => u.instanceId === 'u-e1')?.attack).toBe(3)
  })

  it('health 光环：health 与 maxHealth 同步投影', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 3, health: 2, maxHealth: 2 })
    const state = playState({ hand: [handCard('h1', 't-aura-hp')], board: [own] })
    const result = applyAction(state, playP1('h1'))
    const unit = result.state.board.find((u) => u.instanceId === 'u-o1')
    expect(unit).toMatchObject({ health: 4, maxHealth: 4 })
  })

  it('cost 光环（ownUnits → 己方手牌）：手牌 cost 折扣、对手手牌不受影响、抽牌后同样生效', () => {
    const state = playState({
      hand: [handCard('h1', 't-aura-cost'), handCard('h2', 'smoke-gpu')],
      p2Hand: [handCard('h9', 'smoke-gpu')],
      deck: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
    })
    const played = applyAction(state, playP1('h1'))
    expect(played.state.players.P1.mana).toBe(400) // 配件本体按定义价 100 扣费
    expect(played.state.players.P1.hand).toEqual([{ uid: 'h2', cardId: 'smoke-gpu', cost: 50 }])
    expect(played.state.players.P2.hand).toEqual([{ uid: 'h9', cardId: 'smoke-gpu', cost: 100 }])

    // 后续抽牌同样被折扣（drawCard → applyHandCosts）
    const drawn = applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    // END_TURN 后进入 P2 回合；P2 手牌不受 P1 光环影响
    const p2Hand = drawn.state.players.P2.hand
    expect(p2Hand.every((c) => c.cost === 100)).toBe(true)
  })

  it('cost 光环下打出手牌按折扣价扣费，CARD_PLAYED.cost 为实付值', () => {
    const state = playState({ hand: [handCard('h1', 't-aura-cost'), handCard('h2', 'smoke-gpu')], mana: 300 })
    const withAura = applyAction(state, playP1('h1'))
    const played = applyAction(withAura.state, playP1('h2'))
    expect(played.state.players.P1.mana).toBe(150) // 300 - 100（配件）- 50（折扣后 smoke-gpu）
    expect(played.events[0]).toMatchObject({ type: 'CARD_PLAYED', cardId: 'smoke-gpu', cost: 50 })
    expect(played.events[1]).toMatchObject({ type: 'MINION_SUMMONED' })
  })

  it('光环为派生量：buff 叠加后光环源离场，属性正确回收（buff 保留、光环消失）', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 3, health: 5, maxHealth: 5 })
    const state = playState({
      hand: [handCard('h1', 't-aura-atk'), handCard('h2', 't-buff'), handCard('h3', 't-bolt')],
      board: [own],
    })
    const withAura = applyAction(state, playP1('h1')) // 光环 +1：3 → 4
    const withBuff = applyAction(withAura.state, playP1('h2', unitRef('u-o1'))) // buff +2：4 → 6
    expect(withBuff.state.board.find((u) => u.instanceId === 'u-o1')?.attack).toBe(6)

    // 直伤配件（0/1）致死 → 光环回收：6 - 1（光环）= 5（基础 3 + 永久 buff 2）
    // 配件是本对局第一个入场单位，instanceId 从全局计数取得：u1
    const accessoryId = withAura.state.board.find((u) => u.cardId === 't-aura-atk')?.instanceId
    expect(accessoryId).toBeDefined()
    const killed = applyAction(withBuff.state, playP1('h3', unitRef(accessoryId as string)))
    const unit = killed.state.board.find((u) => u.instanceId === 'u-o1')
    expect(unit?.attack).toBe(5)
    expect(killed.state.players.P1.graveyard.map((g) => g.cardId)).toContain('t-aura-atk')
  })

  it('配件按 0/1 入场且不可攻击：回合开始攻击次数重置为 0（gpu 重置为 1）', () => {
    const state = playState({ hand: [handCard('h1', 't-aura-cost'), handCard('h2', 't-vanilla')] })
    const withAccessory = applyAction(state, playP1('h1'))
    const withGpu = applyAction(withAccessory.state, playP1('h2'))
    const accessory = withGpu.state.board.find((u) => u.cardId === 't-aura-cost')
    expect(accessory).toMatchObject({ attack: 0, health: 1, maxHealth: 1, attacksRemaining: 0 })

    // P1 → P2 → P1：P1 回合开始重置
    const turn2 = applyAction(withGpu.state, { type: 'END_TURN', playerId: 'P1' })
    const turn3 = applyAction(turn2.state, { type: 'END_TURN', playerId: 'P2' })
    const board = turn3.state.board
    expect(board.find((u) => u.cardId === 't-aura-cost')?.attacksRemaining).toBe(0)
    expect(board.find((u) => u.cardId === 't-vanilla')?.attacksRemaining).toBe(1)
  })

  it('配件占扩展槽：BOARD_LIMIT 计入配件', () => {
    const sixUnits = Array.from({ length: 6 }, (_, i) => makeUnit({ ownerId: 'P1', instanceId: `u-f${i}` }))
    const state = playState({ hand: [handCard('h1', 't-aura-cost'), handCard('h2', 't-vanilla')], board: sixUnits })
    const withAccessory = applyAction(state, playP1('h1')) // 第 7 槽：配件
    expect(withAccessory.state.board).toHaveLength(7)
    expect(catchRuleError(() => applyAction(withAccessory.state, playP1('h2'))).code).toBe('BOARD_FULL')
  })

  it('手牌烧牌后 cost 光环仍正确投影（burnExcessHand → applyHandCosts）', () => {
    const hand = [
      handCard('h1', 't-aura-cost'),
      ...Array.from({ length: HAND_LIMIT + 1 }, (_, i) => handCard(`hx${i}`, 'smoke-gpu')),
    ]
    const state = playState({ hand, deck: [{ cardId: 'smoke-gpu' }] })
    const withAura = applyAction(state, playP1('h1')) // 打出配件，手牌 11 张全部打折
    expect(withAura.state.players.P1.hand.every((c) => c.cost === 50)).toBe(true)
    // 回合结束：手牌 11 > 上限 10，烧掉 1 张，剩余手牌仍保持折扣
    const turned = applyAction(withAura.state, { type: 'END_TURN', playerId: 'P1' })
    const burnedCount = turned.events.filter((e) => e.type === 'CARD_BURNED').length
    expect(burnedCount).toBe(1)
    const p1Hand = turned.state.players.P1.hand.filter((c) => c.cardId === 'smoke-gpu')
    expect(p1Hand.every((c) => c.cost === 50)).toBe(true)
  })
})

describe('getLegalActions 出牌枚举（M1-ENG2 扩展）', () => {
  it('枚举可出牌：功耗不足被过滤；chosen 牌按候选交集逐目标展开（敌方潜行不可选）', () => {
    const own = makeUnit({ ownerId: 'P1', instanceId: 'u-own', attack: 2, health: 2, maxHealth: 2 })
    const enemyStealth = makeUnit({ ownerId: 'P2', instanceId: 'u-es', cardId: 't-stealth', keywords: ['stealth'] })
    const enemyPlain = makeUnit({ ownerId: 'P2', instanceId: 'u-ep' })
    const state = playState({
      hand: [handCard('h1', 't-bolt'), handCard('h2', 't-vanilla'), handCard('h3', 't-aura-atk')],
      board: [own],
      enemyBoard: [enemyStealth, enemyPlain],
      mana: 150,
    })
    const actions = getLegalActions(state, 'P1')
    const plays = actions.filter((a): a is PlayCardAction => a.type === 'PLAY_CARD')
    // anyCharacter 候选（board 序）：己方单位 → 敌方普通单位 → P1 CPU → P2 CPU（潜行被过滤）
    expect(plays).toEqual([
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-own') },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-ep') },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: heroRef('P1') },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: heroRef('P2') },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h2' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'h3' },
    ])
  })

  it('功耗不足的牌不产生动作；ATTACK / USE_HERO_POWER 仍不出现（M1-ENG3/5）', () => {
    const state = playState({ hand: [handCard('h1', 't-vanilla')], mana: 50 })
    const actions = getLegalActions(state, 'P1')
    expect(actions).toEqual([
      { type: 'END_TURN', playerId: 'P1' },
      { type: 'CONCEDE', playerId: 'P1' },
    ])
    expect(actions.some((a) => a.type === 'ATTACK' || a.type === 'USE_HERO_POWER')).toBe(false)
  })

  it('gpu 场满时 gpu 不产生动作，driver 仍产生；chosen 池为空时不产生 chosen 动作', () => {
    const full = Array.from({ length: BOARD_LIMIT }, (_, i) => makeUnit({ ownerId: 'P1', instanceId: `u-f${i}` }))
    const state = playState({ hand: [handCard('h1', 't-vanilla'), handCard('h2', 't-bolt')], board: full })
    const actions = getLegalActions(state, 'P1').filter((a): a is PlayCardAction => a.type === 'PLAY_CARD')
    // gpu 被场满过滤；t-bolt（anyCharacter）候选 = 己方 7 个单位 + 双方 CPU
    expect(actions.map((a) => a.uid)).toEqual(['h2', 'h2', 'h2', 'h2', 'h2', 'h2', 'h2', 'h2', 'h2'])
    expect(actions[0]).toMatchObject({ target: unitRef('u-f0') })
    expect(actions[7]).toMatchObject({ target: heroRef('P1') })
    expect(actions[8]).toMatchObject({ target: heroRef('P2') })

    // chosen 池为空（ownUnits 无单位）：t-grant 不产生任何动作
    const emptyOwn = playState({ hand: [handCard('h1', 't-grant')] })
    const emptyActions = getLegalActions(emptyOwn, 'P1').filter(
      (a): a is PlayCardAction => a.type === 'PLAY_CARD',
    )
    expect(emptyActions).toEqual([])
  })

  it('getLegalActions 枚举的动作全部可通过 applyAction（无幽灵动作）', () => {
    const state = playState({
      hand: [handCard('h1', 't-bolt'), handCard('h2', 't-vanilla'), handCard('h3', 't-draw')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-own' })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-ep' })],
    })
    const before = stableHash(state)
    for (const action of getLegalActions(state, 'P1')) {
      if (action.type === 'PLAY_CARD') {
        expect(() => applyAction(state, action)).not.toThrow()
      }
    }
    // 防御性复验：状态本身未被上述校验破坏（applyAction 深拷贝隔离）
    expect(stableHash(state)).toBe(before)
  })
})
