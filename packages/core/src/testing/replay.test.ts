import { describe, expect, it } from 'vitest'
import type { Engine, EngineResult } from '../engine'
import { RuleError } from '../engine'
import type { Action } from '../types/actions'
import type { GameSetup, GameState, PlayerId, PlayerState, PlayerView } from '../types/state'
import { FIRST_PLAYER, HERO_MAX_HEALTH } from '../constants'
import { canonicalJson, stableHash } from './hash'
import { assertGoldenReplay, recordReplay, runReplay } from './replay'

const SEED = 0xc0ffee

describe('canonicalJson / stableHash', () => {
  it('对象键顺序无关', () => {
    expect(canonicalJson({ b: 1, a: [2, { z: 3, y: 4 }] })).toBe(
      canonicalJson({ a: [2, { y: 4, z: 3 }], b: 1 }),
    )
  })
  it('undefined 字段不参与哈希', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })
  it('哈希稳定且可区分', () => {
    expect(stableHash({ x: 1 })).toBe(stableHash({ x: 1 }))
    expect(stableHash({ x: 1 })).not.toBe(stableHash({ x: 2 }))
  })
  it('拒绝引擎状态中不允许的值', () => {
    expect(() => canonicalJson({ m: new Map() })).toThrow(/Map|object/)
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(/non-finite/)
  })
})

/**
 * 测试桩引擎：不实现真实规则，只以确定性方式消化动作。
 * 它的存在是为了验证回放框架本身的确定性，不依赖 M1 的规则实现。
 */
function makeStubEngine(): Engine {
  const mkPlayer = (id: PlayerId, faction: string): PlayerState => ({
    id,
    faction,
    heroName: 'stub-cpu',
    health: HERO_MAX_HEALTH,
    maxHealth: HERO_MAX_HEALTH,
    armor: 0,
    mana: 1,
    maxMana: 1,
    lockedMana: 0,
    deck: [],
    hand: [],
    graveyard: [],
    fatigue: 0,
    heroPowerUsed: false,
  })

  return {
    initGame(setup: GameSetup): GameState {
      return {
        turn: 1,
        activePlayer: FIRST_PLAYER,
        phase: 'main',
        players: {
          P1: mkPlayer('P1', setup.players[0]?.faction ?? 'neutral'),
          P2: mkPlayer('P2', setup.players[1]?.faction ?? 'neutral'),
        },
        board: [],
        nextInstanceId: 1,
        rng: { state: setup.seed >>> 0 },
        winner: null,
        endReason: null,
      }
    },
    applyAction(state, action): EngineResult {
      // 以动作名长度扰动 RNG 链——不同动作必然产生不同状态
      const next: GameState = {
        ...state,
        turn: state.turn + 1,
        rng: { state: (state.rng.state + action.type.length) >>> 0 },
      }
      return {
        state: next,
        events: [{ type: 'TURN_END', turn: next.turn, playerId: action.playerId }],
      }
    },
    getLegalActions(state, playerId) {
      if (state.phase === 'ended') return []
      return [{ type: 'END_TURN', playerId } satisfies Action]
    },
    viewFor(state, playerId): PlayerView {
      const opponent: PlayerId = playerId === 'P1' ? 'P2' : 'P1'
      const toPublic = (p: PlayerState) => ({
        id: p.id,
        faction: p.faction,
        heroName: p.heroName,
        health: p.health,
        maxHealth: p.maxHealth,
        armor: p.armor,
        mana: p.mana,
        maxMana: p.maxMana,
        handSize: p.hand.length,
        deckSize: p.deck.length,
        graveyardSize: p.graveyard.length,
        fatigue: p.fatigue,
        heroPowerUsed: p.heroPowerUsed,
      })
      const you = state.players[playerId]
      const opp = state.players[opponent]
      return {
        viewer: playerId,
        turn: state.turn,
        phase: state.phase,
        activePlayer: state.activePlayer,
        winner: state.winner,
        you: { ...toPublic(you), hand: you.hand },
        opponent: toPublic(opp),
        board: state.board,
      }
    },
  }
}

describe('黄金回放框架', () => {
  const engine = makeStubEngine()
  const actions: Action[] = [
    { type: 'END_TURN', playerId: 'P1' },
    { type: 'PLAY_CARD', playerId: 'P2', uid: 'h1' },
    { type: 'END_TURN', playerId: 'P2' },
  ]
  const makeSetup = (seed = SEED): GameSetup => ({
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: { cards: [] } },
      { id: 'P2', faction: 'amd', deck: { cards: [] } },
    ],
  })

  it('同一录制两次运行哈希一致', () => {
    const rec = recordReplay(makeSetup(), actions)
    expect(runReplay(engine, rec).stateHash).toBe(runReplay(engine, rec).stateHash)
  })
  it('动作序列不同则哈希不同', () => {
    const a = runReplay(engine, recordReplay(makeSetup(), [{ type: 'END_TURN', playerId: 'P1' }]))
    const b = runReplay(engine, recordReplay(makeSetup(), [{ type: 'CONCEDE', playerId: 'P1' }]))
    expect(a.stateHash).not.toBe(b.stateHash)
  })
  it('种子不同则哈希不同', () => {
    const a = runReplay(engine, recordReplay(makeSetup(SEED), []))
    const b = runReplay(engine, recordReplay(makeSetup(SEED + 1), []))
    expect(a.stateHash).not.toBe(b.stateHash)
  })
  it('assertGoldenReplay 命中与漂移路径', () => {
    const rec = recordReplay(makeSetup(), actions)
    const { stateHash } = runReplay(engine, rec)
    expect(() => assertGoldenReplay(engine, rec, stateHash)).not.toThrow()
    expect(() => assertGoldenReplay(engine, rec, 'deadbeef')).toThrow(/黄金回放漂移/)
  })
  it('RuleError 可构造且带错误码', () => {
    expect(new RuleError('INSUFFICIENT_MANA', '供电不够').message).toContain('INSUFFICIENT_MANA')
  })
})
