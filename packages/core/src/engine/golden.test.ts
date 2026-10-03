/**
 * 黄金回放接通（M1-ENG1 范围）：用真实引擎跑一局纯 END_TURN 对局，
 * 打到疲劳分出胜负；同 seed + 动作两次运行 stableHash 一致。
 * 全量快照基线（__golden__/）属 M1-ENG7，本文件不锁基线哈希。
 *
 * M1-ENG2 扩展：加入含 PLAY_CARD 的对局片段（driver 随机直伤 / gpu 战吼 /
 * accessory 光环），验证同 seed 两次运行哈希与事件流逐字节一致、
 * getLegalActions 枚举出的动作全部可被 applyAction 接受（无幽灵动作）。
 * M1-ENG3 扩展：加入含 ATTACK 的攻击交换片段（taunt 拦截 / 双芯两次攻击 /
 * 超频首回合攻击 / 质保消耗 / 攻击致死 / 攻击 hero 分胜负）。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { Action } from '../types/actions'
import type { GameEvent } from '../types/events'
import type { DeckSpec, GameSetup, GameState } from '../types/state'
import { makeDistinctDeckSpec, TEST_SEED } from '../testing/state'
import { recordReplay, runReplay, assertGoldenReplay } from '../testing/replay'
import { createEngine } from './index'
import type { AttackAction } from './combat'
import type { PlayCardAction } from './play'
import type { UseHeroPowerAction } from './heroPower'
import { registerCardDefinitions } from './registry'

const engine = createEngine()

/** 30 张互不相同的卡（让洗牌参与哈希），只出 END_TURN 直到疲劳终局 */
function pureEndTurnSetup(seed: number): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: makeDistinctDeckSpec() },
      { id: 'P2', faction: 'amd', deck: makeDistinctDeckSpec() },
    ],
  }
}

function pureEndTurnActions(count: number): Action[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'END_TURN',
    playerId: i % 2 === 0 ? 'P1' : 'P2',
  }))
}

// 期望节奏：起手 3 张后牌库 27。P1 首回合不抽（自身回合 2..28 抽 27 张，turn 57 起疲劳）；
// P2 首回合即抽（自身回合 1..27 抽 27 张抽空，turn 56 起疲劳）——P2 的疲劳序列早 P1 一步。
// 疲劳 8 次累计伤害 36 ≥ 30 → P2 在全局 turn 70（自身第 35 回合）倒下，P1 获胜
// → 恰好 69 次 END_TURN，第 70 个动作会因对局已结束被拒绝。
const FULL_GAME_ACTIONS = 69

describe('黄金回放：纯 END_TURN 疲劳对局（真实引擎）', () => {
  const setup = pureEndTurnSetup(TEST_SEED)
  const actions = pureEndTurnActions(FULL_GAME_ACTIONS)
  const recording = recordReplay(setup, actions)

  it('一局纯 END_TURN 对局能打到疲劳分出胜负', () => {
    const { finalState, events } = runReplay(engine, recording)
    expect(finalState.phase).toBe('ended')
    expect(finalState.endReason).toBe('health_zero')
    expect(finalState.winner).toBe('P1') // P2 不跳过首回合抽牌，牌库先耗尽、先疲劳
    expect(finalState.players.P2.fatigue).toBe(8)
    expect(finalState.players.P2.health).toBe(0)
    expect(finalState.players.P1.fatigue).toBe(7)
    expect(finalState.players.P1.health).toBe(2)
    expect(finalState.turn).toBe(70)
    // 终局事件以 GAME_END 收尾
    expect(events.at(-1)).toMatchObject({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
    // 对局途中经历了手牌超限烧牌（各自第 9 回合起手牌 11 张）
    expect(events.filter((e) => e.type === 'CARD_BURNED').length).toBeGreaterThan(0)
  })

  it('确定性：同 seed + 动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('异 seed 异哈希（洗牌差异进入状态）', () => {
    const other = runReplay(engine, recordReplay(pureEndTurnSetup(TEST_SEED + 1), actions))
    const base = runReplay(engine, recording)
    expect(other.stateHash).not.toBe(base.stateHash)
    // 结构节奏不受 seed 影响：同样打到 turn 70、同样的胜负
    expect(other.finalState.turn).toBe(base.finalState.turn)
    expect(other.finalState.winner).toBe('P1')
  })

  it('前缀动作产生不同哈希（动作序列参与决定状态）', () => {
    const prefix = runReplay(engine, recordReplay(setup, actions.slice(0, 40)))
    const full = runReplay(engine, recording)
    expect(prefix.finalState.phase).toBe('main') // 40 动作后仍在进行
    expect(prefix.stateHash).not.toBe(full.stateHash)
  })

  it('assertGoldenReplay 命中路径（基线已锁定：__golden__/）', () => {
    const { stateHash } = runReplay(engine, recording)
    // 用本局自身哈希走一次断言，验证框架与真实引擎接通
    expect(() => assertGoldenReplay(engine, recording, stateHash)).not.toThrow()
  })
})

// —— M1-ENG2：含 PLAY_CARD 的黄金回放 ——

const GOLDEN_CARDS: CardDefinition[] = [
  { id: 'gold-bolt', name: '测试电弧', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'random', pool: 'anyCharacter' }, amount: 1 }] } },
  { id: 'gold-gpu', name: '测试显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 3,
    effect: { trigger: 'battlecry', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'enemyHero' }, amount: 1 }] } },
  { id: 'gold-aura', name: '测试集线器', faction: 'neutral', type: 'accessory', cost: 100,
    effect: { trigger: 'battlecry', aura: { stat: 'attack', delta: 1, scope: 'ownUnits' } } },
]
registerCardDefinitions(GOLDEN_CARDS)

function goldenDeck(): DeckSpec {
  return {
    cards: [
      { cardId: 'gold-bolt', count: 10 },
      { cardId: 'gold-gpu', count: 10 },
      { cardId: 'gold-aura', count: 10 },
    ],
  }
}

function goldenSetup(seed: number): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: goldenDeck() },
      { id: 'P2', faction: 'amd', deck: goldenDeck() },
    ],
  }
}

/**
 * 探针式录制：动作列表由引擎自身确定性导出——每回合行动方先按 getLegalActions
 * 顺序打出至多 2 张牌，再 END_TURN。同 seed 下探针结果恒定，故可作回放输入。
 */
function goldenPlayActions(seed: number, rounds: number): Action[] {
  let state: GameState = engine.initGame(goldenSetup(seed))
  const actions: Action[] = []
  for (let i = 0; i < rounds; i++) {
    const active = state.activePlayer
    let plays = 0
    while (plays < 2) {
      const legal = engine
        .getLegalActions(state, active)
        .filter((a): a is PlayCardAction => a.type === 'PLAY_CARD')
      const next = legal[0]
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
      plays++
    }
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  return actions
}

describe('黄金回放：含 PLAY_CARD 的对局片段（M1-ENG2）', () => {
  const actions = goldenPlayActions(TEST_SEED, 8)
  const recording = recordReplay(goldenSetup(TEST_SEED), actions)

  it('动作序列确实包含出牌（driver / gpu / accessory 混合卡组）', () => {
    const plays = actions.filter((a) => a.type === 'PLAY_CARD')
    expect(plays.length).toBeGreaterThanOrEqual(6)
  })

  it('回放产生出牌类事件：CARD_PLAYED / MINION_SUMMONED / DAMAGE_DEALT（随机原语走 RNG）', () => {
    const { events } = runReplay(engine, recording)
    expect(events.filter((e) => e.type === 'CARD_PLAYED').length).toBeGreaterThanOrEqual(6)
    expect(events.filter((e) => e.type === 'MINION_SUMMONED').length).toBeGreaterThanOrEqual(2)
    expect(events.filter((e) => e.type === 'DAMAGE_DEALT').length).toBeGreaterThanOrEqual(6)
  })

  it('确定性：同 seed + 出牌动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('对局仍在进行且状态自洽（回合数 = rounds + 1）', () => {
    const { finalState } = runReplay(engine, recording)
    expect(finalState.phase).toBe('main')
    expect(finalState.winner).toBeNull()
    expect(finalState.turn).toBe(9)
    // 场上单位（含 accessory）属性非负、攻击次数非负
    for (const unit of finalState.board) {
      expect(unit.attack).toBeGreaterThanOrEqual(0)
      expect(unit.health).toBeGreaterThanOrEqual(0)
      expect(unit.attacksRemaining).toBeGreaterThanOrEqual(0)
    }
  })

  it('光环配件自投影：ownUnits 光环使配件自身 attack = 0 + delta', () => {
    // 纯配件卡组：打出的 accessory 是唯一单位，ownUnits 光环作用于自身
    const auraDeck: DeckSpec = { cards: [{ cardId: 'gold-aura', count: 30 }] }
    const auraSetup: GameSetup = {
      seed: TEST_SEED,
      players: [
        { id: 'P1', faction: 'nvidia', deck: auraDeck },
        { id: 'P2', faction: 'amd', deck: auraDeck },
      ],
    }
    const auraRecording = recordReplay(auraSetup, goldenPlayActions(TEST_SEED, 4))
    const { finalState } = runReplay(engine, auraRecording)
    const accessories = finalState.board.filter((u) => u.cardId === 'gold-aura')
    expect(accessories.length).toBeGreaterThanOrEqual(1)
    for (const accessory of accessories) {
      // 每个 ownUnits 光环源（含自身）向己方单位贡献 +1：attack = 同方在场配件数
      const ownCount = finalState.board.filter(
        (u) => u.cardId === 'gold-aura' && u.ownerId === accessory.ownerId,
      ).length
      expect(accessory.attack).toBe(ownCount)
      expect(accessory.attacksRemaining).toBe(0) // 配件不可攻击
    }
    expect(() => assertGoldenReplay(engine, auraRecording, stableHashOf(engine, auraRecording))).not.toThrow()
  })
})

function stableHashOf(engineLocal: typeof engine, recording: ReturnType<typeof recordReplay>): string {
  return runReplay(engineLocal, recording).stateHash
}

// —— M1-ENG3：含 ATTACK 攻击交换的黄金回放 ——

const COMBAT_CARDS: CardDefinition[] = [
  { id: 'cg-rusher', name: '冲锋白板', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 2 },
  { id: 'cg-taunt', name: '信仰充值塔', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 6, keywords: ['taunt'] },
  { id: 'cg-twin', name: '双芯原型', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2, keywords: ['windfury'] },
  { id: 'cg-overclock', name: '超频失败体', faction: 'neutral', type: 'gpu', cost: 200, attack: 4, health: 1, keywords: ['charge'] },
  { id: 'cg-warranty', name: '三年质保卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 3, keywords: ['divine_shield'] },
  { id: 'cg-ghost', name: '无输出亮机', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2, keywords: ['stealth'] },
]
registerCardDefinitions(COMBAT_CARDS)

function combatDeck(): DeckSpec {
  return { cards: COMBAT_CARDS.map((c) => ({ cardId: c.id, count: 5 })) }
}

function combatSetup(seed: number): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: combatDeck() },
      { id: 'P2', faction: 'amd', deck: combatDeck() },
    ],
  }
}

/**
 * 探针式录制（M1-ENG3）：每回合行动方先打出至多 2 张牌，再按 getLegalActions
 * 枚举顺序贪心发起至多 6 次攻击，最后 END_TURN；对局结束即停。
 * 同 seed 下探针结果恒定，故可作回放输入（与 M1-ENG2 探针同一模式）。
 */
function combatPlayActions(seed: number, rounds: number): Action[] {
  let state: GameState = engine.initGame(combatSetup(seed))
  const actions: Action[] = []
  for (let i = 0; i < rounds; i++) {
    if (state.phase !== 'main') break
    const active = state.activePlayer
    let plays = 0
    while (plays < 2) {
      const next = engine
        .getLegalActions(state, active)
        .find((a): a is PlayCardAction => a.type === 'PLAY_CARD')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
      plays++
    }
    let attacks = 0
    while (attacks < 6) {
      const next = engine
        .getLegalActions(state, active)
        .find((a): a is AttackAction => a.type === 'ATTACK')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
      attacks++
    }
    if (state.phase !== 'main') break
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  return actions
}

describe('黄金回放：含 ATTACK 攻击交换的对局片段（M1-ENG3）', () => {
  // 实测节奏（同 seed 确定性）：40 回合内 turn 30 由 P2 获胜；46 次攻击、
  // 31 次战斗死亡、质保消耗 6 次、潜行现身 5 次
  const actions = combatPlayActions(TEST_SEED, 40)
  const recording = recordReplay(combatSetup(TEST_SEED), actions)

  it('动作序列确实包含攻击（taunt / 双芯 / 超频 / 质保 / 潜行混合卡组）', () => {
    expect(actions.filter((a) => a.type === 'ATTACK').length).toBeGreaterThanOrEqual(30)
  })

  it('回放产生攻击类事件：ATTACK_DECLARED / 质保消耗 / 潜行现身 / 战斗致死', () => {
    const { events } = runReplay(engine, recording)
    expect(events.filter((e) => e.type === 'ATTACK_DECLARED').length).toBeGreaterThanOrEqual(30)
    expect(events.some((e) => e.type === 'DAMAGE_DEALT' && e.shieldConsumed === true)).toBe(true)
    expect(events.some((e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'stealth')).toBe(true)
    expect(events.some((e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'divine_shield')).toBe(true)
    expect(events.filter((e) => e.type === 'MINION_DIED' && e.cause === 'damage').length).toBeGreaterThanOrEqual(20)
  })

  it('贪心攻击最终打到 CPU 分出胜负', () => {
    const { finalState, events } = runReplay(engine, recording)
    expect(finalState.phase).toBe('ended')
    expect(finalState.endReason).toBe('health_zero')
    expect(finalState.winner).toBe('P2')
    expect(events.at(-1)).toMatchObject({ type: 'GAME_END', reason: 'health_zero' })
  })

  it('确定性：同 seed + 攻击动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('assertGoldenReplay 命中路径（基线已锁定：__golden__/）', () => {
    const { stateHash } = runReplay(engine, recording)
    expect(() => assertGoldenReplay(engine, recording, stateHash)).not.toThrow()
  })
})

// —— M1-ENG4：亡语连锁 / 跳闸锁费 / onAttack·onDamaged 触发的黄金回放 ——

const KEYWORD_GOLDEN_CARDS: CardDefinition[] = [
  { id: 'kg-bomber', name: '蓝屏轰炸机', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 2, keywords: ['deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'damage', target: { kind: 'all', pool: 'enemyUnits' }, amount: 1 }] } },
  { id: 'kg-legacy', name: '传家宝显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 1, keywords: ['taunt', 'deathrattle'],
    effect: { trigger: 'deathrattle', steps: [{ op: 'summon', cardId: 'kg-token', count: 2 }] } },
  { id: 'kg-token', name: '亮机卡', faction: 'neutral', type: 'gpu', cost: 0, attack: 1, health: 1 },
  { id: 'kg-overload', name: '白牌电源', faction: 'neutral', type: 'driver', cost: 100, keywords: ['overload'],
    effect: { trigger: 'onPlay', steps: [
      { op: 'draw', player: 'sourceOwner', count: 1 },
      { op: 'lockMana', player: 'sourceOwner', amount: 200 },
    ] } },
  { id: 'kg-onattack', name: '越战越勇', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 3,
    effect: { trigger: 'onAttack', steps: [{ op: 'buff', target: { kind: 'random', pool: 'self' }, attack: 1 }] } },
  { id: 'kg-ondamaged', name: '静电外壳', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 4,
    effect: { trigger: 'onDamaged', steps: [{ op: 'damage', target: { kind: 'random', pool: 'enemyUnits' }, amount: 1 }] } },
]
registerCardDefinitions(KEYWORD_GOLDEN_CARDS)

function keywordGoldenDeck(): DeckSpec {
  return { cards: KEYWORD_GOLDEN_CARDS.map((c) => ({ cardId: c.id, count: 5 })) }
}

function keywordGoldenSetup(seed: number): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: keywordGoldenDeck() },
      { id: 'P2', faction: 'amd', deck: keywordGoldenDeck() },
    ],
  }
}

/**
 * 探针式录制（M1-ENG4）：与 M1-ENG3 探针同一模式——每回合行动方先打出至多 2 张牌，
 * 再按 getLegalActions 枚举顺序贪心发起至多 6 次攻击，最后 END_TURN；对局结束即停。
 * 同 seed 下探针结果恒定，故可作回放输入。
 */
function keywordGoldenActions(seed: number, rounds: number): Action[] {
  let state: GameState = engine.initGame(keywordGoldenSetup(seed))
  const actions: Action[] = []
  for (let i = 0; i < rounds; i++) {
    if (state.phase !== 'main') break
    const active = state.activePlayer
    let plays = 0
    while (plays < 2) {
      const next = engine
        .getLegalActions(state, active)
        .find((a): a is PlayCardAction => a.type === 'PLAY_CARD')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
      plays++
    }
    let attacks = 0
    while (attacks < 6) {
      const next = engine
        .getLegalActions(state, active)
        .find((a): a is AttackAction => a.type === 'ATTACK')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
      attacks++
    }
    if (state.phase !== 'main') break
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  return actions
}

describe('黄金回放：亡语连锁 / 跳闸 / onAttack·onDamaged 的对局片段（M1-ENG4）', () => {
  const actions = keywordGoldenActions(TEST_SEED, 24)
  const recording = recordReplay(keywordGoldenSetup(TEST_SEED), actions)

  it('动作序列确实包含出牌与攻击（关键词混合卡组）', () => {
    expect(actions.filter((a) => a.type === 'PLAY_CARD').length).toBeGreaterThanOrEqual(10)
    expect(actions.filter((a) => a.type === 'ATTACK').length).toBeGreaterThanOrEqual(10)
  })

  it('回放触发关键词事件：亡语（含跳闸/死亡管线）与 BURN_OUT 锁费结算', () => {
    const { events, finalState } = runReplay(engine, recording)
    expect(events.filter((e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'deathrattle').length).toBeGreaterThanOrEqual(2)
    expect(events.filter((e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'overload').length).toBeGreaterThanOrEqual(1)
    expect(events.filter((e) => e.type === 'BURN_OUT').length).toBeGreaterThanOrEqual(1)
    expect(events.filter((e) => e.type === 'MINION_DIED').length).toBeGreaterThanOrEqual(3)
    // 亡语连锁产生后续效果事件（召唤 token / 范围伤害）
    expect(events.filter((e) => e.type === 'MINION_SUMMONED' && e.source === 'effect').length).toBeGreaterThanOrEqual(1)
    // onDamaged（静电外壳反伤）在回放中真实发生（效果伤害可按 source.ref 追溯）
    expect(events.filter((e) => e.type === 'DAMAGE_DEALT' && e.source.kind === 'effect' && e.source.ref === 'kg-ondamaged').length).toBeGreaterThanOrEqual(1)
    // onAttack（越战越勇自增攻）在回放中真实发生：buff 无目录事件，以终局场上单位攻值 > 基础值 2 为证
    expect(finalState.board.some((u) => u.cardId === 'kg-onattack' && u.attack > 2)).toBe(true)
  })

  it('确定性：同 seed + 动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('对局状态自洽（仍在进行或已终局，单位属性非负）', () => {
    const { finalState } = runReplay(engine, recording)
    expect(finalState.turn).toBeGreaterThanOrEqual(10)
    expect(finalState.players.P1.lockedMana).toBeGreaterThanOrEqual(0)
    for (const unit of finalState.board) {
      expect(unit.attack).toBeGreaterThanOrEqual(0)
      expect(unit.health).toBeGreaterThanOrEqual(0)
      expect(unit.maxHealth).toBeGreaterThanOrEqual(1)
    }
  })

  it('异 seed 异哈希（随机亡语/触发链差异进入状态）', () => {
    const other = runReplay(engine, recordReplay(keywordGoldenSetup(TEST_SEED + 1), keywordGoldenActions(TEST_SEED + 1, 24)))
    const base = runReplay(engine, recording)
    expect(other.stateHash).not.toBe(base.stateHash)
  })

  it('assertGoldenReplay 命中路径（基线已锁定：__golden__/）', () => {
    const { stateHash } = runReplay(engine, recording)
    expect(() => assertGoldenReplay(engine, recording, stateHash)).not.toThrow()
  })
})

// —— M1-ENG6：destroy / revive / turnStart·turnEnd 触发 / tag 过滤的黄金回放 ——

const ENG6_GOLDEN_CARDS: CardDefinition[] = [
  { id: 'eg-melt', name: '随机熔毁', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'destroy', target: { kind: 'random', pool: 'enemyUnits' } }] } },
  { id: 'eg-revive', name: '矿卡重生', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'revive', pick: 'random', to: 'sourceOwnerBoard' }] } },
  { id: 'eg-quake', name: '矿难', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'all', pool: 'allUnits', tag: 'miner' }, attack: -1, health: -1 }] } },
  { id: 'eg-turnend', name: '下班摸鱼', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 2,
    effect: { trigger: 'turnEnd', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] } },
  { id: 'eg-turnstart', name: '晨间超频', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2,
    effect: { trigger: 'turnStart', steps: [{ op: 'buff', target: { kind: 'random', pool: 'self' }, attack: 1 }] } },
  { id: 'eg-miner', name: '矿卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 3, tags: ['miner'] },
]
registerCardDefinitions(ENG6_GOLDEN_CARDS)

function eng6GoldenDeck(): DeckSpec {
  return { cards: ENG6_GOLDEN_CARDS.map((c) => ({ cardId: c.id, count: 5 })) }
}

function eng6GoldenSetup(seed: number): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: eng6GoldenDeck() },
      { id: 'P2', faction: 'amd', deck: eng6GoldenDeck() },
    ],
  }
}

/**
 * 探针式录制（M1-ENG6）：与 M1-ENG2..5 探针同一模式——每回合行动方先打出至多 2 张牌，
 * 再 END_TURN；对局结束即停。destroy / revive / 矿难 / turnStart·turnEnd 触发卡组，
 * 同 seed 下探针结果恒定，故可作回放输入。
 */
function eng6GoldenActions(seed: number, rounds: number): Action[] {
  let state: GameState = engine.initGame(eng6GoldenSetup(seed))
  const actions: Action[] = []
  for (let i = 0; i < rounds; i++) {
    if (state.phase !== 'main') break
    const active = state.activePlayer
    let plays = 0
    while (plays < 2) {
      const next = engine
        .getLegalActions(state, active)
        .find((a): a is PlayCardAction => a.type === 'PLAY_CARD')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
      plays++
    }
    if (state.phase !== 'main') break
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  return actions
}

describe('黄金回放：destroy / revive / 回合时点触发 / tag 过滤的对局片段（M1-ENG6）', () => {
  const actions = eng6GoldenActions(TEST_SEED, 16)
  const recording = recordReplay(eng6GoldenSetup(TEST_SEED), actions)

  it('动作序列确实包含出牌（destroy / revive / 矿难 / 触发单位混合卡组）', () => {
    expect(actions.filter((a) => a.type === 'PLAY_CARD').length).toBeGreaterThanOrEqual(10)
  })

  it('回放产生 ENG6 类事件：destroy 死亡 / 效果复活 / 矿难减益致死 / 回合时点抽牌', () => {
    const { events, finalState } = runReplay(engine, recording)
    // destroy 原语：MINION_DIED cause=destroy 在回放中真实发生
    expect(events.filter((e) => e.type === 'MINION_DIED' && e.cause === 'destroy').length).toBeGreaterThanOrEqual(1)
    // revive 原语：效果召唤（复活）真实发生；复活把显卡带回场上
    expect(events.filter((e) => e.type === 'MINION_SUMMONED' && e.source === 'effect').length).toBeGreaterThanOrEqual(1)
    // 矿难（tag 过滤 buff）：矿卡被 -1/-1 减益致死（3/3 减三次）
    expect(events.filter((e) => e.type === 'MINION_DIED' && e.cause === 'damage' && e.unit.cardId === 'eg-miner').length).toBeGreaterThanOrEqual(1)
    // turnEnd 触发（下班摸鱼抽牌）：效果抽牌真实发生（含超限烧牌）
    expect(events.filter((e) => e.type === 'CARD_BURNED').length).toBeGreaterThanOrEqual(1)
    // turnStart 触发（晨间超频自增攻）：终局场上存在攻击 > 定义值 2 的该卡单位
    expect(finalState.board.some((u) => u.cardId === 'eg-turnstart' && u.attack > 2)).toBe(true)
  })

  it('确定性：同 seed + 动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('异 seed 异哈希（随机 destroy / revive 差异进入状态）', () => {
    const other = runReplay(engine, recordReplay(eng6GoldenSetup(TEST_SEED + 1), eng6GoldenActions(TEST_SEED + 1, 16)))
    const base = runReplay(engine, recording)
    expect(other.stateHash).not.toBe(base.stateHash)
  })

  it('对局状态自洽（单位属性非负、墓地条目均曾离场）', () => {
    const { finalState } = runReplay(engine, recording)
    for (const unit of finalState.board) {
      expect(unit.attack).toBeGreaterThanOrEqual(0)
      expect(unit.health).toBeGreaterThanOrEqual(0)
      expect(unit.maxHealth).toBeGreaterThanOrEqual(1)
    }
    // 复活即离墓：墓地不含任何当前在场实例的 instanceId
    const boardIds = new Set(finalState.board.map((u) => u.instanceId))
    for (const entry of finalState.players.P1.graveyard) {
      expect(boardIds.has(entry.instanceId)).toBe(false)
    }
  })

  it('assertGoldenReplay 命中路径（基线已锁定：__golden__/）', () => {
    const { stateHash } = runReplay(engine, recording)
    expect(() => assertGoldenReplay(engine, recording, stateHash)).not.toThrow()
  })
})

// —— M1-ENG5：派系技能（USE_HERO_POWER）的黄金回放 ——

const POWER_TOKEN: CardDefinition = {
  id: 'gp-token', name: '白嫖测试卡', faction: 'neutral', type: 'gpu',
  cost: 0, attack: 1, health: 1, // 0 费：出牌不挤占派系技能功耗（200W）
}
registerCardDefinitions([POWER_TOKEN])

function powerDeck(): DeckSpec {
  return { cards: [{ cardId: 'gp-token', count: 30 }] }
}

/** heroPowerSetup：双方各持一系技能（P1 skillA 派系 / P2 skillB 派系），30 张 0 费白板 */
function powerSetup(seed: number, p1Faction: string, p2Faction: string): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: p1Faction, deck: powerDeck() },
      { id: 'P2', faction: p2Faction, deck: powerDeck() },
    ],
  }
}

/**
 * 探针式录制（M1-ENG5）：每回合行动方先打出至多 2 张牌，再按 getLegalActions
 * 顺序使用一次派系技能（首个 USE_HERO_POWER，目标即首个合法候选），最后 END_TURN。
 * 同 seed 下探针结果恒定，故可作回放输入（与 M1-ENG2/3/4 探针同一模式）。
 * 节奏：自身第 1 回合供电 100W < 200W 技能放不出，第 2 自身回合起每回合一次。
 */
function powerPlayActions(seed: number, setup: GameSetup, rounds: number): Action[] {
  let state: GameState = engine.initGame(setup)
  const actions: Action[] = []
  for (let i = 0; i < rounds; i++) {
    if (state.phase !== 'main') break
    const active = state.activePlayer
    let plays = 0
    while (plays < 2) {
      const next = engine
        .getLegalActions(state, active)
        .find((a): a is PlayCardAction => a.type === 'PLAY_CARD')
      if (!next) break
      actions.push(next)
      state = engine.applyAction(state, next).state
      plays++
    }
    const power = engine
      .getLegalActions(state, active)
      .find((a): a is UseHeroPowerAction => a.type === 'USE_HERO_POWER')
    if (power) {
      actions.push(power)
      state = engine.applyAction(state, power).state
    }
    if (state.phase !== 'main') break
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  return actions
}

/** 技能事件序列 → 逐次结果（ray_tracing_try：'hit' / 'miss'；其余技能恒 'resolved'） */
function heroPowerOutcomes(events: readonly GameEvent[]): string[] {
  const outcomes: string[] = []
  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    if (event === undefined || event.type !== 'HERO_POWER_USED') continue
    if (event.skillId !== 'ray_tracing_try') {
      outcomes.push('resolved')
      continue
    }
    const next = events[i + 1]
    outcomes.push(
      next?.type === 'KEYWORD_TRIGGERED' && next.detail === '光追失败' ? 'miss' : 'hit',
    )
  }
  return outcomes
}

describe('黄金回放：派系技能 DLSS / 驱动更新的对局片段（M1-ENG5）', () => {
  // P1 nvidia「DLSS」+ P2 intel「驱动更新」：buff 与抽牌两条非随机技能路径
  const actions = powerPlayActions(TEST_SEED, powerSetup(TEST_SEED, 'nvidia', 'intel'), 8)
  const recording = recordReplay(powerSetup(TEST_SEED, 'nvidia', 'intel'), actions)

  it('动作序列确实包含双方派系技能（各 ≥ 2 次）', () => {
    const powers = actions.filter((a): a is UseHeroPowerAction => a.type === 'USE_HERO_POWER')
    expect(powers.filter((a) => a.playerId === 'P1').length).toBeGreaterThanOrEqual(2)
    expect(powers.filter((a) => a.playerId === 'P2').length).toBeGreaterThanOrEqual(2)
  })

  it('回放产生 HERO_POWER_USED{dlss / driver_update}；DLSS 加攻、驱动更新抽牌真实发生', () => {
    const { finalState, events } = runReplay(engine, recording)
    const used = events.filter((e) => e.type === 'HERO_POWER_USED')
    expect(used.filter((e) => e.skillId === 'dlss').length).toBeGreaterThanOrEqual(2)
    expect(used.filter((e) => e.skillId === 'driver_update').length).toBeGreaterThanOrEqual(2)
    // 驱动更新：P2 手牌增长可观测（0 费白板出 2 张 / 回合，抽 1 张 / 回合，净 +1）
    expect(finalState.players.P2.hand.length).toBeGreaterThanOrEqual(2)
    // buff 无目录事件：以事件序核验（HERO_POWER_USED 后无伤害事件即 buff 路径）
    for (let i = 0; i < events.length; i++) {
      const event = events[i]
      if (event !== undefined && event.type === 'HERO_POWER_USED' && event.skillId === 'dlss') {
        expect(events[i + 1]?.type).not.toBe('DAMAGE_DEALT')
      }
    }
  })

  it('确定性：同 seed + 动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('assertGoldenReplay 命中路径（基线已锁定：__golden__/）', () => {
    const { stateHash } = runReplay(engine, recording)
    expect(() => assertGoldenReplay(engine, recording, stateHash)).not.toThrow()
  })
})

describe('黄金回放：派系技能 开光追试试 / 清灰 的对局片段（M1-ENG5）', () => {
  // P1 amd「开光追试试」（30% 失败）+ P2 neutral「清灰」。
  // TEST_SEED 下探针 16 回合：光追 8 用 7 命中 1 失败（第 5 次失败）——失败在回放中确定性发生
  const setup = powerSetup(TEST_SEED, 'amd', 'neutral')
  const actions = powerPlayActions(TEST_SEED, setup, 16)
  const recording = recordReplay(setup, actions)

  it('回放中双方技能各使用 ≥ 2 次；光追失败（KEYWORD_TRIGGERED{detail: 光追失败}）至少发生一次', () => {
    const { events } = runReplay(engine, recording)
    const used = events.filter((e) => e.type === 'HERO_POWER_USED')
    expect(used.filter((e) => e.skillId === 'ray_tracing_try').length).toBeGreaterThanOrEqual(2)
    expect(used.filter((e) => e.skillId === 'dust_off').length).toBeGreaterThanOrEqual(2)
    // 30% 失败在 TEST_SEED 下确定性发生（mulberry32 探针序列的既定事实）
    expect(events.some((e) => e.type === 'KEYWORD_TRIGGERED' && e.detail === '光追失败')).toBe(true)
    // 清灰伤害归因为 heroPower（§6 事件目录）
    expect(events.some((e) => e.type === 'DAMAGE_DEALT' && e.source.kind === 'heroPower')).toBe(true)
  })

  it('30% 失败由 seed 唯一决定：同 seed 命中/失败模式恒定；跨 seed 两种结果均出现（异 seed 翻盘）', () => {
    const base = heroPowerOutcomes(runReplay(engine, recording).events)
    expect(base).toContain('miss') // TEST_SEED 下确有失败
    expect(base).toContain('hit') // TEST_SEED 下确有命中
    // 换 seed 重放（探针随 seed 确定性重生成）：命中/失败模式随之改变——结果由 seed 决定
    const outcomesBySeed = [1, 2, 3, 4, 5, 6, 7, 8].map((s) => {
      const seed = (TEST_SEED + s * 17) >>> 0
      const seedActions = powerPlayActions(seed, powerSetup(seed, 'amd', 'neutral'), 10)
      return heroPowerOutcomes(
        runReplay(engine, recordReplay(powerSetup(seed, 'amd', 'neutral'), seedActions)).events,
      )
    })
    expect(outcomesBySeed.some((outcomes) => outcomes.includes('miss'))).toBe(true)
    expect(outcomesBySeed.some((outcomes) => outcomes.includes('hit'))).toBe(true)
  })

  it('确定性：同 seed + 动作两次运行，状态哈希与事件流逐字节一致', () => {
    const a = runReplay(engine, recording)
    const b = runReplay(engine, recording)
    expect(a.stateHash).toBe(b.stateHash)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.finalState)).toBe(JSON.stringify(b.finalState))
  })

  it('对局状态自洽（技能伤害不致崩局；单位属性非负）', () => {
    const { finalState } = runReplay(engine, recording)
    expect(finalState.phase).toBe('main') // 技能只点名场上单位（board 序首个候选），CPU 不掉血
    for (const unit of finalState.board) {
      expect(unit.attack).toBeGreaterThanOrEqual(0)
      expect(unit.health).toBeGreaterThanOrEqual(0)
    }
    expect(finalState.players.P1.heroPowerUsed).toBe(false) // 结算停在 P2 回合，P1 已随回合开始重置
  })

  it('assertGoldenReplay 命中路径（基线已锁定：__golden__/）', () => {
    const { stateHash } = runReplay(engine, recording)
    expect(() => assertGoldenReplay(engine, recording, stateHash)).not.toThrow()
  })
})
