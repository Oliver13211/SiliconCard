/**
 * 回放序列化测试（M1-ENG7）：serializeReplay / deserializeReplay 双向转换。
 *
 * - 确定性：同一录制 canonicalJson 输出逐字节相同（存档可按内容寻址 / 进 git）；
 * - 往返无损：deserialize(serialize(rec)) 深等于 rec；二次序列化逐字节稳定；
 * - 回放等价：序列化往返后的录制经真实引擎回放，状态哈希与事件流与原录制一致；
 * - 可读错误：非法 JSON / 错误 schemaVersion / 未知字段 / 字段缺失 / 目标形状错误
 *   全部显式报错且消息可读（拼错字段不允许静默丢失——会无声改变回放语义）。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { Action } from '../types/actions'
import type { GameSetup } from '../types/state'
import { TEST_SEED, makeDistinctDeckSpec } from './state'
import { recordReplay, runReplay } from './replay'
import { REPLAY_SCHEMA_VERSION, deserializeReplay, serializeReplay } from './replaySerialize'
import { createEngine } from '../engine/index'
import { registerCardDefinitions } from '../engine/registry'

// —— 真实引擎 + 混合卡组探针（含 chosen 目标动作，覆盖 target 载荷的往返） ——

const RS_CARDS: CardDefinition[] = [
  { id: 'rs-bolt', name: '序列化电弧', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 1 }] } },
  { id: 'rs-gpu', name: '序列化显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 2, health: 2 },
]
registerCardDefinitions(RS_CARDS)

function rsDeck(): GameSetup['players'][number]['deck'] {
  return { cards: [{ cardId: 'rs-bolt', count: 15 }, { cardId: 'rs-gpu', count: 15 }] }
}

function rsSetup(seed = TEST_SEED): GameSetup {
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: rsDeck() },
      { id: 'P2', faction: 'intel', deck: rsDeck() },
    ],
  }
}

/** 探针录制：每回合行动方打出至多 1 张牌（含 chosen 目标）、可用则放技能、再 END_TURN */
function probeRecording(seed = TEST_SEED): ReturnType<typeof recordReplay> {
  const engine = createEngine()
  let state = engine.initGame(rsSetup(seed))
  const actions: Action[] = []
  for (let round = 0; round < 6; round++) {
    if (state.phase !== 'main') break
    const active = state.activePlayer
    const play = engine.getLegalActions(state, active).find((a): a is Action => a.type === 'PLAY_CARD')
    if (play) {
      actions.push(play)
      state = engine.applyAction(state, play).state
    }
    if (state.phase !== 'main') break
    const power = engine.getLegalActions(state, active).find((a): a is Action => a.type === 'USE_HERO_POWER')
    if (power) {
      actions.push(power)
      state = engine.applyAction(state, power).state
    }
    if (state.phase !== 'main') break
    const end: Action = { type: 'END_TURN', playerId: active }
    actions.push(end)
    state = engine.applyAction(state, end).state
  }
  return recordReplay(rsSetup(seed), actions)
}

describe('回放序列化：确定性输出', () => {
  const recording = probeRecording()

  it('同一录制两次序列化输出逐字节相同', () => {
    expect(serializeReplay(recording)).toBe(serializeReplay(recording))
  })

  it('输出含 schemaVersion 且为 canonical JSON（键已排序、无 undefined）', () => {
    const parsed = JSON.parse(serializeReplay(recording)) as Record<string, unknown>
    expect(parsed.schemaVersion).toBe(REPLAY_SCHEMA_VERSION)
    expect(Object.keys(parsed).sort()).toEqual(['actions', 'players', 'schemaVersion', 'seed'])
    // canonicalJson 键递归排序：actions < players < schemaVersion < seed（逐字节稳定）
    expect(serializeReplay(recording).startsWith('{"actions":')).toBe(true)
    const schemaIdx = serializeReplay(recording).indexOf('"schemaVersion"')
    const seedIdx = serializeReplay(recording).indexOf('"seed"')
    expect(schemaIdx).toBeGreaterThan(-1)
    expect(seedIdx).toBeGreaterThan(schemaIdx)
  })

  it('undefined 可选字段被剔除：{END_TURN, target: undefined} 与无 target 动作序列化等价', () => {
    const withUndefined = recordReplay(rsSetup(), [
      { type: 'END_TURN', playerId: 'P1', target: undefined } as unknown as Action,
    ])
    const clean = recordReplay(rsSetup(), [{ type: 'END_TURN', playerId: 'P1' }])
    expect(serializeReplay(withUndefined)).toBe(serializeReplay(clean))
  })
})

describe('回放序列化：往返无损（property 式）', () => {
  const recordings = [
    probeRecording(TEST_SEED),
    probeRecording(TEST_SEED + 7919),
    recordReplay(rsSetup(), []), // 空动作
    recordReplay(
      { seed: 0, players: [{ id: 'P1', faction: 'amd', deck: makeDistinctDeckSpec() }, { id: 'P2', faction: 'neutral', deck: makeDistinctDeckSpec(), heroName: '手动命名' }] },
      [{ type: 'CONCEDE', playerId: 'P2' }],
    ),
  ]

  it('deserialize(serialize(rec)) 深等于 rec（多组录制，含目标动作 / 空动作 / heroName）', () => {
    for (const recording of recordings) {
      const roundTrip = deserializeReplay(serializeReplay(recording))
      expect(roundTrip).toEqual(recording)
    }
  })

  it('二次序列化逐字节稳定：serialize(deserialize(serialize(rec))) === serialize(rec)', () => {
    for (const recording of recordings) {
      const once = serializeReplay(recording)
      expect(serializeReplay(deserializeReplay(once))).toBe(once)
    }
  })

  it('回放等价：往返后的录制经真实引擎回放，状态哈希与事件流与原录制一致', () => {
    const engine = createEngine()
    for (const recording of recordings) {
      const roundTrip = deserializeReplay(serializeReplay(recording))
      const original = runReplay(engine, recording)
      const restored = runReplay(engine, roundTrip)
      expect(restored.stateHash).toBe(original.stateHash)
      expect(restored.events).toEqual(original.events)
    }
  })

  it('探针录制确实携带目标动作（target 载荷往返被真实覆盖）', () => {
    const withTarget = recordings[0]?.actions.filter((a) => 'target' in a) ?? []
    expect(withTarget.length).toBeGreaterThanOrEqual(2)
  })
})

describe('回放序列化：反序列化校验与可读错误', () => {
  const good = serializeReplay(probeRecording())

  const expectFail = (json: string, pattern: RegExp): void => {
    expect(() => deserializeReplay(json)).toThrow(pattern)
  }

  it('非法 JSON → 可读错误', () => {
    expectFail('{not json', /非法 JSON/)
  })

  it('schemaVersion 缺失 / 非整数 / 未来版本 → 可读错误', () => {
    expectFail('{"seed":1,"players":[],"actions":[]}', /schemaVersion/)
    expectFail('{"schemaVersion":"1","seed":1,"players":[],"actions":[]}', /schemaVersion/)
    const future = JSON.parse(good) as Record<string, unknown>
    future.schemaVersion = REPLAY_SCHEMA_VERSION + 1
    expectFail(JSON.stringify(future), /不支持的存档版本/)
  })

  it('根 / players / actions 结构错误 → 可读错误', () => {
    expectFail('[]', /应为对象/)
    expectFail(JSON.stringify({ schemaVersion: 1, seed: 1, players: [{ id: 'P1' }], actions: [] }), /恰好两名玩家/)
    const badActions = JSON.parse(good) as Record<string, unknown>
    badActions.actions = 'nope'
    expectFail(JSON.stringify(badActions), /actions.*必须为数组/)
  })

  it('seed 非 uint32 整数 → 可读错误', () => {
    const bad = JSON.parse(good) as Record<string, unknown>
    bad.seed = -1
    expectFail(JSON.stringify(bad), /seed/)
    bad.seed = 1.5
    expectFail(JSON.stringify(bad), /seed/)
  })

  it('玩家 id 按位校验、faction/卡组条目校验 → 可读错误', () => {
    const swapped = JSON.parse(good) as { players: [{ id: string }, { id: string }] }
    swapped.players[0]!.id = 'P2'
    expectFail(JSON.stringify(swapped), /按位对应 P1/)
    const noFaction = JSON.parse(good) as { players: [Record<string, unknown>, Record<string, unknown>] }
    delete noFaction.players[0]!.faction
    expectFail(JSON.stringify(noFaction), /faction/)
    const badCount = JSON.parse(good) as { players: [{ deck: { cards: [{ count: number }] } }, unknown] }
    badCount.players[0]!.deck.cards[0]!.count = 0
    expectFail(JSON.stringify(badCount), /count 必须为正整数/)
  })

  it('动作：未知类型 / 缺字段 / 未知字段 / ATTACK 无 target → 可读错误', () => {
    const unknownType = JSON.parse(good) as { actions: unknown[] }
    unknownType.actions = [{ type: 'RAGE_QUIT', playerId: 'P1' }]
    expectFail(JSON.stringify(unknownType), /未知动作类型 "RAGE_QUIT"/)

    const noUid = JSON.parse(good) as { actions: unknown[] }
    noUid.actions = [{ type: 'PLAY_CARD', playerId: 'P1' }]
    expectFail(JSON.stringify(noUid), /uid/)

    const typoField = JSON.parse(good) as { actions: unknown[] }
    typoField.actions = [{ type: 'END_TURN', playerId: 'P1', plyaer: 'P2' }]
    expectFail(JSON.stringify(typoField), /未知字段「plyaer」/)

    const noTarget = JSON.parse(good) as { actions: unknown[] }
    noTarget.actions = [{ type: 'ATTACK', playerId: 'P1', attackerId: 'u1' }]
    expectFail(JSON.stringify(noTarget), /ATTACK 必须携带 target/)
  })

  it('目标：未知 kind / unit 缺 instanceId / hero 非法 playerId / 未知字段 → 可读错误', () => {
    const badKind = JSON.parse(good) as { actions: unknown[] }
    badKind.actions = [{ type: 'ATTACK', playerId: 'P1', attackerId: 'u1', target: { kind: 'minion', instanceId: 'u2' } }]
    expectFail(JSON.stringify(badKind), /未知目标类型 "minion"/)

    const noInstance = JSON.parse(good) as { actions: unknown[] }
    noInstance.actions = [{ type: 'ATTACK', playerId: 'P1', attackerId: 'u1', target: { kind: 'unit' } }]
    expectFail(JSON.stringify(noInstance), /instanceId/)

    const badHero = JSON.parse(good) as { actions: unknown[] }
    badHero.actions = [{ type: 'USE_HERO_POWER', playerId: 'P1', target: { kind: 'hero', playerId: 'P9' } }]
    expectFail(JSON.stringify(badHero), /playerId 必须为 P1或P2/)

    const extraKey = JSON.parse(good) as { actions: unknown[] }
    extraKey.actions = [{ type: 'USE_HERO_POWER', playerId: 'P1', target: { kind: 'hero', playerId: 'P2', extra: 1 } }]
    expectFail(JSON.stringify(extraKey), /未知字段「extra」/)
  })

  it('序列化同样过闸门：损坏录制无法被 serialize 洗白', () => {
    const corrupted = {
      schemaVersion: REPLAY_SCHEMA_VERSION,
      seed: TEST_SEED,
      players: [],
      actions: [],
    }
    expect(() => serializeReplay(corrupted as unknown as ReturnType<typeof recordReplay>)).toThrow(/恰好两名玩家/)
  })
})
