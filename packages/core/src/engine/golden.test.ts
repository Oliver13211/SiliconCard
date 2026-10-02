/**
 * 黄金回放接通（M1-ENG1 范围）：用真实引擎跑一局纯 END_TURN 对局，
 * 打到疲劳分出胜负；同 seed + 动作两次运行 stableHash 一致。
 * 全量快照基线（__golden__/）属 M1-ENG7，本文件不锁基线哈希。
 *
 * M1-ENG2 扩展：加入含 PLAY_CARD 的对局片段（driver 随机直伤 / gpu 战吼 /
 * accessory 光环），验证同 seed 两次运行哈希与事件流逐字节一致、
 * getLegalActions 枚举出的动作全部可被 applyAction 接受（无幽灵动作）。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { Action } from '../types/actions'
import type { DeckSpec, GameSetup, GameState } from '../types/state'
import { makeDistinctDeckSpec, TEST_SEED } from '../testing/state'
import { recordReplay, runReplay, assertGoldenReplay } from '../testing/replay'
import { createEngine } from './index'
import type { PlayCardAction } from './play'
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

  it('assertGoldenReplay 命中路径（M1-ENG7 将以此锁基线）', () => {
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
