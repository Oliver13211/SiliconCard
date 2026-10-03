/**
 * 决策体单测（M1-AI1）：mock 引擎下逐分支断言 —— 斩杀优先 / 曲线填充 /
 * 返回值必为合法集成员且永不负胜 / 非本回合返回 null / 种子确定性，
 * 以及防作弊封印测试（AI 触碰 GameState 原始字段即刻抛错）。
 */

import { beforeAll, describe, expect, test } from 'vitest'
import {
  RuleError,
  createEngine,
  type Action,
  type Engine,
  type EngineResult,
  type GameEvent,
  type GameSetup,
  type GameState,
  type PlayerView,
} from '@siliconcard/core'
import { registerAiCardPool } from './cardPool'
import { createAiPlayer } from './player'
import { sealState } from './sealed'

beforeAll(() => registerAiCardPool())

// —— mock 引擎：viewFor / getLegalActions 返回夹具，applyAction 按 simulate 产出后果 ——

interface MockHandle {
  engine: Engine
  /** mock 引擎认得的「当前局面」对象（测试以此调用 decideNextAction） */
  readonly baseState: GameState
  readonly applied: Action[]
}

function mockEngine(
  baseView: PlayerView,
  legal: readonly Action[],
  simulate: (action: Action) => PlayerView,
): MockHandle {
  const applied: Action[] = []
  const baseState = { __mock: 'base' } as unknown as GameState
  const views = new Map<GameState, PlayerView>()
  const engine: Engine = {
    initGame: () => baseState,
    applyAction: (state, action): EngineResult => {
      if (state !== baseState) throw new RuleError('GAME_ENDED', 'mock 只接受初始状态')
      if (!legal.includes(action)) {
        throw new RuleError('INVALID_TARGET', `mock：动作不在合法集内 ${JSON.stringify(action)}`)
      }
      applied.push(action)
      const after = simulate(action)
      const afterState = { __mock: 'after' } as unknown as GameState
      views.set(afterState, after)
      return { state: afterState, events: [] as GameEvent[] }
    },
    getLegalActions: (state) => (state === baseState ? legal : []),
    viewFor: (state) => views.get(state) ?? (state === baseState ? baseView : undefined as unknown as PlayerView),
  }
  return { engine, baseState, applied }
}

function side(id: 'P1' | 'P2', over: Partial<PlayerView['you']> = {}): PlayerView['you'] {
  return {
    id,
    faction: 'nvidia',
    heroName: `cpu-${id}`,
    health: 30,
    maxHealth: 30,
    armor: 0,
    mana: 600,
    maxMana: 600,
    handSize: 2,
    deckSize: 20,
    graveyardSize: 0,
    fatigue: 0,
    heroPowerUsed: false,
    hand: [],
    ...over,
  }
}

function baseView(over: Partial<PlayerView> = {}): PlayerView {
  return {
    viewer: 'P1',
    turn: 5,
    phase: 'main',
    activePlayer: 'P1',
    winner: null,
    you: side('P1'),
    opponent: side('P2'),
    board: [],
    ...over,
  }
}

const END_TURN: Action = { type: 'END_TURN', playerId: 'P1' }
const CONCEDE: Action = { type: 'CONCEDE', playerId: 'P1' }

describe('decideNextAction（mock 引擎）', () => {
  test('斩杀线：有斩杀时直打脸收束，不绕路解场', () => {
    const zap = { uid: 'z1', cardId: 'ai-zap', cost: 100 }
    const playFace: Action = { type: 'PLAY_CARD', playerId: 'P1', uid: 'z1', target: { kind: 'hero', playerId: 'P2' } }
    const playUnit: Action = { type: 'PLAY_CARD', playerId: 'P1', uid: 'z1', target: { kind: 'unit', instanceId: 'e1' } }
    const v = baseView({
      you: side('P1', { mana: 100, hand: [zap] }),
      opponent: side('P2', { health: 1 }),
      board: [
        { instanceId: 'e1', cardId: 'ai-brick', ownerId: 'P2', attack: 5, health: 5, maxHealth: 5, keywords: [], summonedOnTurn: 1, attacksRemaining: 0, attackedThisTurn: false },
      ],
    })
    const mock = mockEngine(v, [END_TURN, CONCEDE, playFace, playUnit], (action) =>
      action.type === 'PLAY_CARD' && action.target?.kind === 'hero'
        ? baseView({ you: side('P1', { mana: 0, hand: [] }), opponent: side('P2', { health: 0 }), phase: 'ended', winner: 'P1' })
        : baseView({ you: side('P1', { mana: 0, hand: [] }) }),
    )
    const ai = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 42 })
    expect(ai.decideNextAction(mock.engine, mock.baseState)).toBe(playFace)
  })

  test('无斩杀时曲线填充优先：下 4/5（+9 场面）胜过 5 攻打脸（+5+2 加成）', () => {
    const brick = { uid: 'b1', cardId: 'ai-brick', cost: 300 }
    const playBrick: Action = { type: 'PLAY_CARD', playerId: 'P1', uid: 'b1' }
    const attackFace: Action = { type: 'ATTACK', playerId: 'P1', attackerId: 'm1', target: { kind: 'hero', playerId: 'P2' } }
    const myBoard: PlayerView['board'] = [
      { instanceId: 'm1', cardId: 'ai-beast', ownerId: 'P1', attack: 9, health: 9, maxHealth: 9, keywords: [], summonedOnTurn: 1, attacksRemaining: 1, attackedThisTurn: false },
    ]
    const v = baseView({ you: side('P1', { mana: 600, hand: [brick] }), board: myBoard })
    const mock = mockEngine(v, [END_TURN, CONCEDE, playBrick, attackFace], (action) => {
      if (action === playBrick) {
        return baseView({
          you: side('P1', { mana: 300, hand: [] }),
          board: [...myBoard, { instanceId: 'm2', cardId: 'ai-brick', ownerId: 'P1', attack: 4, health: 5, maxHealth: 5, keywords: [], summonedOnTurn: 5, attacksRemaining: 0, attackedThisTurn: false }],
        })
      }
      if (action === attackFace) {
        return baseView({
          you: side('P1', { mana: 600, hand: [brick] }),
          opponent: side('P2', { health: 25 }),
          board: myBoard,
        })
      }
      return v
    })
    const ai = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 7 })
    expect(ai.decideNextAction(mock.engine, mock.baseState)).toBe(playBrick)
  })

  test('永不负胜：CONCEDE 不在评估集、返回值必为合法集成员', () => {
    const mock = mockEngine(baseView(), [END_TURN, CONCEDE], () => baseView())
    const ai = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 1 })
    const action = ai.decideNextAction(mock.engine, mock.baseState)
    expect(action).toBe(END_TURN)
    expect(action).not.toBe(CONCEDE)
    expect(mock.applied).not.toContain(CONCEDE)
  })

  test('同 seed 同局面 → 同决策（决策 RNG 确定性）', () => {
    const brick = { uid: 'b1', cardId: 'ai-brick', cost: 300 }
    const spark = { uid: 's1', cardId: 'ai-spark', cost: 200 }
    const hand = [brick, spark]
    const legal: Action[] = [
      END_TURN,
      CONCEDE,
      { type: 'PLAY_CARD', playerId: 'P1', uid: 'b1' },
      { type: 'PLAY_CARD', playerId: 'P1', uid: 's1' },
    ]
    // 两张牌模拟后果分差极小（±0.1），Normal 噪声（±1.2）足以翻转——噪声必须可复现
    const v = baseView({ you: side('P1', { mana: 300, hand }) })
    const makeMock = () =>
      mockEngine(v, legal, (action) => {
        const bonus = action.type === 'PLAY_CARD' && action.uid === 'b1' ? 0.1 : 0
        return baseView({ you: side('P1', { mana: 0, hand: [] }), opponent: side('P2', { health: 30 - bonus }) })
      })
    const a1 = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 1234 })
    const a2 = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 1234 })
    const m1 = makeMock()
    const m2 = makeMock()
    expect(a1.decideNextAction(m1.engine, m1.baseState)).toBe(a2.decideNextAction(m2.engine, m2.baseState))
  })

  test('非本回合 / 对局已结束 / 无合法动作 → null', () => {
    const notMyTurn = mockEngine(baseView({ activePlayer: 'P2' }), [END_TURN, CONCEDE], () => baseView())
    const ai = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 1 })
    expect(ai.decideNextAction(notMyTurn.engine, notMyTurn.baseState)).toBeNull()

    const ended = mockEngine(baseView({ phase: 'ended', winner: 'P2' }), [], () => baseView())
    expect(ai.decideNextAction(ended.engine, ended.baseState)).toBeNull()
  })
})

// —— 防作弊封印：AI 决策全程不得触碰 GameState 原始字段 ——

describe('防作弊闸门（sealState）', () => {
  test('封印状态下驱动真实对局数步：读原始字段即抛错，不抛 = 未作弊', () => {
    const engine = createEngine()
    let state = engine.initGame({
      seed: 20261003,
      players: [
        { id: 'P1', faction: 'nvidia', deck: { cards: [{ cardId: 'ai-brick', count: 30 }] } },
        { id: 'P2', faction: 'amd', deck: { cards: [{ cardId: 'ai-zap', count: 30 }] } },
      ],
    })
    const ai = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 99 })
    for (let i = 0; i < 60 && state.phase !== 'ended'; i++) {
      if (state.activePlayer !== 'P1') {
        // 对手回合直接代打 END_TURN，把行动权交回被测 AI
        state = engine.applyAction(state, { type: 'END_TURN', playerId: state.activePlayer }).state
        continue
      }
      const sealed = sealState(state)
      const action = ai.decideNextAction(engine, sealed)
      expect(action).not.toBeNull()
      if (!action) break
      state = engine.applyAction(state, action).state
    }
    expect(state.turn).toBeGreaterThan(1)
  })
})

// —— 真引擎连通性：工厂产物可在真实对局中循环出招 ——

describe('真引擎连通', () => {
  test('AI 对空场对手能完整出完一个回合（动作均出自合法集）', () => {
    const engine = createEngine()
    const setup: GameSetup = {
      seed: 7,
      players: [
        { id: 'P1', faction: 'neutral', deck: { cards: [{ cardId: 'ai-glitch', count: 30 }] } },
        { id: 'P2', faction: 'neutral', deck: { cards: [{ cardId: 'ai-zap', count: 30 }] } },
      ],
    }
    let state = engine.initGame(setup)
    const ai = createAiPlayer({ playerId: 'P1', difficulty: 'normal', seed: 5 })
    let guard = 0
    while (state.activePlayer === 'P1' && state.phase === 'main' && guard < 64) {
      guard += 1
      const legal = engine.getLegalActions(state, 'P1')
      const action = ai.decideNextAction(engine, state)
      expect(action).not.toBeNull()
      expect(legal).toContainEqual(action)
      if (!action) break
      state = engine.applyAction(state, action).state
    }
    expect(state.activePlayer).toBe('P2')
  })
})
