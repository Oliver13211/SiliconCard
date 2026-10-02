/**
 * USE_HERO_POWER 派系技能单测（docs/rules.md §3 / §4 / §6 / §8，M1-ENG5）。
 *
 * 覆盖：注册框架（registerFactionSkills / 校验 / skillId 全局唯一 / 内置基线恢复）、
 * initGame 派系技能校验、四个内置技能（DLSS / 开光追试试 / 驱动更新 / 清灰）的
 * 正确结算与事件序列、合法性拒绝（非本回合 / 已用 / 功耗不足 / 非法目标 /
 * 对局结束）、heroPowerUsed 跨回合重置（ENG1）、光追 30% 失败的种子复现与
 * 异 seed 翻盘、getLegalActions 枚举与无幽灵动作、确定性。
 *
 * RNG 语义锁定（见 effects/handlers.ts）：ray_tracing_try 每次结算恰好消耗一次
 * rng.nextFloat()，成败均消耗。mulberry32 前几抽（确定性事实，测试据此锁定契约）：
 *   state 20261001（TEST_SEED）→ roll 0.3198 → 命中；state 4 → roll 0.9236 → 失败。
 */

import { describe, expect, it } from 'vitest'
import { HERO_POWER_COST } from '../constants'
import type { Action } from '../types/actions'
import type { GameEvent } from '../types/events'
import type { GameState, PlayerId } from '../types/state'
import type { GameSetup } from '../types/state'
import { catchRuleError, makeGameState, makePlayer, makeSetup, makeUnit, TEST_SEED } from '../testing/state'
import { stableHash } from '../testing/hash'
import { applyAction, getLegalActions } from './apply'
import { initGame } from './init'
import { nextUint32 } from './prng'
import {
  clearFactionSkills,
  findFactionSkillIssues,
  getFactionSkill,
  registerFactionSkills,
  resetFactionSkills,
} from './factions'
import type { FactionSkillDefinition } from './factions'

const unitRef = (instanceId: string) => ({ kind: 'unit' as const, instanceId })
const heroRef = (playerId: PlayerId) => ({ kind: 'hero' as const, playerId })
const heroPower = (playerId: PlayerId, target?: ReturnType<typeof unitRef> | ReturnType<typeof heroRef>): Action =>
  ({ type: 'USE_HERO_POWER', playerId, ...(target ? { target } : {}) })

interface SkillStateOptions {
  p1Faction?: string
  p2Faction?: string
  mana?: number
  board?: ReturnType<typeof makeUnit>[]
  enemyBoard?: ReturnType<typeof makeUnit>[]
  rngState?: number
  handCount?: number
}

/** 派系技能测试态：双方牌库留牌避免疲劳噪音，P1 满供电（默认 500 ≥ 200） */
function skillState(opts: SkillStateOptions = {}): GameState {
  const deck = Array.from({ length: 5 }, () => ({ cardId: 'smoke-gpu' }))
  const handCount = opts.handCount ?? 0
  return makeGameState({
    players: {
      P1: {
        ...makePlayer('P1', { faction: opts.p1Faction ?? 'neutral' }),
        mana: opts.mana ?? 500,
        maxMana: opts.mana ?? 500,
        deck,
        hand: Array.from({ length: handCount }, (_, i) => ({ uid: `h${i + 1}`, cardId: 'smoke-gpu', cost: 100 })),
      },
      P2: {
        ...makePlayer('P2', { faction: opts.p2Faction ?? 'neutral' }),
        deck,
      },
    },
    board: [...(opts.board ?? []), ...(opts.enemyBoard ?? [])],
    ...(opts.rngState !== undefined ? { rng: { state: opts.rngState } } : {}),
  })
}

// ———————— 注册框架 ————————

describe('派系技能注册框架（M1-ENG5）', () => {
  it('registerFactionSkills / getFactionSkill 往返；同 factionId 后写覆盖', () => {
    try {
      const sega: FactionSkillDefinition = {
        factionId: 'sega', skillName: '噴はないで', skillId: 'sega_power', cost: 200,
        effect: { trigger: 'onPlay', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] },
      }
      registerFactionSkills([sega])
      expect(getFactionSkill('sega')?.skillId).toBe('sega_power')
      const sega2: FactionSkillDefinition = { ...sega, skillId: 'sega_power_2' }
      registerFactionSkills([sega2])
      expect(getFactionSkill('sega')?.skillId).toBe('sega_power_2')
    } finally {
      resetFactionSkills()
    }
  })

  it('跨 faction 的 skillId 冲突响亮抛错（HERO_POWER_USED.skillId 须全局可归因）', () => {
    try {
      const a: FactionSkillDefinition = {
        factionId: 'sega', skillName: 'A', skillId: 'shared_skill', cost: 200,
        effect: { trigger: 'onPlay', steps: [] },
      }
      const b: FactionSkillDefinition = { ...a, factionId: 'snk' }
      registerFactionSkills([a])
      expect(() => registerFactionSkills([b])).toThrow(/shared_skill/)
    } finally {
      resetFactionSkills()
    }
  })

  it('findFactionSkillIssues：缺字段 / cost 越界 / trigger 非 onPlay / 未知步骤均报问题', () => {
    const base: FactionSkillDefinition = {
      factionId: 'x', skillName: 'X', skillId: 'x_skill', cost: 200,
      effect: { trigger: 'onPlay', steps: [] },
    }
    expect(findFactionSkillIssues(base)).toBeNull()
    expect(findFactionSkillIssues({ ...base, factionId: '' })).toMatch(/factionId/)
    expect(findFactionSkillIssues({ ...base, skillId: '' })).toMatch(/skillId/)
    expect(findFactionSkillIssues({ ...base, skillName: '' })).toMatch(/skillName/)
    expect(findFactionSkillIssues({ ...base, cost: 1.5 })).toMatch(/cost/)
    expect(findFactionSkillIssues({ ...base, cost: -1 })).toMatch(/cost/)
    expect(findFactionSkillIssues({ ...base, effect: { trigger: 'battlecry', steps: [] } })).toMatch(/onPlay/)
    expect(
      findFactionSkillIssues({ ...base, effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'mars' as never }, amount: 1 }] } }),
    ).toMatch(/目标池/)
    // steps 结构校验复用卡牌 EffectSpec 校验（registry.findEffectSpecIssues）
    expect(
      findFactionSkillIssues({ ...base, effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: -5 }] } }),
    ).toMatch(/amount/)
  })

  it('registerFactionSkills 对不合法定义响亮抛错（环境配置错误，非 RuleError）', () => {
    expect(() =>
      registerFactionSkills([{
        factionId: 'sega', skillName: 'S', skillId: 'sega_s', cost: 200,
        effect: { trigger: 'deathrattle', steps: [] },
      }]),
    ).toThrow(/onPlay/)
    resetFactionSkills()
  })

  it('resetFactionSkills 恢复 §8 内置四系基线', () => {
    resetFactionSkills()
    expect(getFactionSkill('nvidia')?.skillId).toBe('dlss')
    expect(getFactionSkill('amd')?.skillId).toBe('ray_tracing_try')
    expect(getFactionSkill('intel')?.skillId).toBe('driver_update')
    expect(getFactionSkill('neutral')?.skillId).toBe('dust_off')
    for (const skill of [getFactionSkill('nvidia'), getFactionSkill('amd'), getFactionSkill('intel'), getFactionSkill('neutral')]) {
      expect(skill?.cost).toBe(HERO_POWER_COST)
    }
  })
})

// ———————— initGame 派系技能校验 ————————

describe('initGame 派系技能校验（M1-ENG5）', () => {
  it('任一方 faction 未注册技能 → DECK_INVALID{reason: faction_skill_unregistered}', () => {
    try {
      clearFactionSkills()
      const error = catchRuleError(() => initGame(makeSetup()))
      expect(error.code).toBe('DECK_INVALID')
      expect(error.detail).toMatchObject({ reason: 'faction_skill_unregistered', factionId: 'nvidia' })
    } finally {
      resetFactionSkills()
    }
    // 恢复后同一 setup 可正常开局
    expect(() => initGame(makeSetup())).not.toThrow()
  })

  it('未注册的新派系（如 sega）开局被拒；注册后放行', () => {
    try {
      const base = makeSetup()
      const segaSetup: GameSetup = {
        seed: base.seed,
        players: [{ ...base.players[0], faction: 'sega' }, base.players[1]],
      }
      const error = catchRuleError(() => initGame(segaSetup))
      expect(error.detail).toMatchObject({ reason: 'faction_skill_unregistered', factionId: 'sega' })
      registerFactionSkills([{
        factionId: 'sega', skillName: '土星机', skillId: 'sega_skill', cost: 200,
        effect: { trigger: 'onPlay', steps: [{ op: 'gainArmor', player: 'sourceOwner', amount: 2 }] },
      }])
      expect(() => initGame(segaSetup)).not.toThrow()
    } finally {
      resetFactionSkills()
    }
  })
})

// ———————— 内置技能一：nvidia「DLSS」 ————————

describe('USE_HERO_POWER：nvidia「DLSS」（dlss）', () => {
  it('buff chosen ownUnits attack +1；扣费 200、置位 heroPowerUsed；事件仅 HERO_POWER_USED（buff 无目录事件）', () => {
    const state = skillState({
      p1Faction: 'nvidia',
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 2, health: 2, maxHealth: 2 })],
    })
    const result = applyAction(state, heroPower('P1', unitRef('u-o1')))
    expect(result.state.board[0]?.attack).toBe(3)
    expect(result.state.board[0]?.health).toBe(2) // 只加攻不加血
    expect(result.state.players.P1.mana).toBe(300)
    expect(result.state.players.P1.heroPowerUsed).toBe(true)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'dlss', target: unitRef('u-o1') },
    ])
  })

  it('无目标 → INVALID_TARGET{reason: target_required}；目标不在 ownUnits 池 → INVALID_TARGET{reason: not_in_pool}', () => {
    const state = skillState({
      p1Faction: 'nvidia',
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1' })],
    })
    const noTarget = catchRuleError(() => applyAction(state, heroPower('P1')))
    expect(noTarget.code).toBe('INVALID_TARGET')
    expect(noTarget.detail).toMatchObject({ reason: 'target_required', pools: ['ownUnits'] })

    const enemy = catchRuleError(() => applyAction(state, heroPower('P1', unitRef('u-e1'))))
    expect(enemy.code).toBe('INVALID_TARGET')
    expect(enemy.detail).toMatchObject({ reason: 'not_in_pool', pool: 'ownUnits' })
  })

  it('己方场上无单位时技能不可用（chosen 池为空，功耗不扣）', () => {
    const state = skillState({ p1Faction: 'nvidia' })
    expect(getLegalActions(state, 'P1').some((a) => a.type === 'USE_HERO_POWER')).toBe(false)
    const error = catchRuleError(() => applyAction(state, heroPower('P1')))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'target_required' })
    expect(stableHash(state)).toBe(stableHash(skillState({ p1Faction: 'nvidia' }))) // 状态未被破坏
  })
})

// ———————— 内置技能二：amd「开光追试试」（30% 失败走种子 RNG） ————————

describe('USE_HERO_POWER：amd「开光追试试」（ray_tracing_try）', () => {
  it('命中（roll < 0.7）：对目标结算 1 点伤害，source = heroPower；恰好消耗一次 RNG', () => {
    // TEST_SEED 首抽 roll 0.3198 < 0.7 → 命中（mulberry32 确定性事实）
    const state = skillState({ p1Faction: 'amd', rngState: TEST_SEED })
    const result = applyAction(state, heroPower('P1', heroRef('P2')))
    expect(result.state.players.P2.health).toBe(29)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'ray_tracing_try', target: heroRef('P2') },
      {
        type: 'DAMAGE_DEALT',
        source: { kind: 'heroPower', playerId: 'P1' },
        target: heroRef('P2'),
        amount: 1,
        remainingHealth: 29,
      },
    ])
    // RNG 语义锁定：恰好一次 nextFloat，成败同耗
    expect(result.state.rng.state).toBe(nextUint32(TEST_SEED >>> 0).state)
  })

  it('失败（roll ≥ 0.7）：KEYWORD_TRIGGERED{detail: 光追失败} 且无事发生；同样恰好消耗一次 RNG', () => {
    // rng.state=4 首抽 roll 0.9236 ≥ 0.7 → 失败（mulberry32 确定性事实）
    const state = skillState({ p1Faction: 'amd', rngState: 4, enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1', health: 2, maxHealth: 2 })] })
    const before = stableHash(state)
    const result = applyAction(state, heroPower('P1', unitRef('u-e1')))
    // 无事发生：目标血量不变、CPU 血量不变
    expect(result.state.board.find((u) => u.instanceId === 'u-e1')?.health).toBe(2)
    expect(result.state.players.P2.health).toBe(30)
    // 功耗照扣、次数照置位（技能"试过了"，失败不退费）
    expect(result.state.players.P1.mana).toBe(300)
    expect(result.state.players.P1.heroPowerUsed).toBe(true)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'ray_tracing_try', target: unitRef('u-e1') },
      { type: 'KEYWORD_TRIGGERED', keyword: 'overload', instanceId: 'ray_tracing_try', detail: '光追失败' },
    ])
    expect(result.state.rng.state).toBe(nextUint32(4).state) // 失败同样恰好消耗一次 RNG
    expect(stableHash(state)).toBe(before) // 原状态不变
  })

  it('命中判定可作用于单位（含三年质保：完全抵挡并碎盾）', () => {
    const state = skillState({
      p1Faction: 'amd',
      rngState: TEST_SEED, // 命中
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1', keywords: ['divine_shield'] })],
    })
    const result = applyAction(state, heroPower('P1', unitRef('u-e1')))
    expect(result.events[1]).toMatchObject({ type: 'DAMAGE_DEALT', shieldConsumed: true })
    expect(result.events[2]).toMatchObject({ type: 'KEYWORD_TRIGGERED', keyword: 'divine_shield' })
    expect(result.state.board.find((u) => u.instanceId === 'u-e1')?.keywords).toEqual([])
  })

  it('30% 失败由 seed 唯一决定：同 state 两次运行结果逐字节一致；异 seed 可翻盘（失败 ↔ 命中）', () => {
    const runWith = (rngState: number) =>
      applyAction(skillState({ p1Faction: 'amd', rngState }), heroPower('P1', heroRef('P2')))
    const a = runWith(4)
    const b = runWith(4)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))

    // 异 seed 翻盘：rng.state=4 失败、rng.state=TEST_SEED 命中——同一动作序列、不同结果
    const failed = runWith(4).events.find((e) => e.type === 'KEYWORD_TRIGGERED' && e.detail === '光追失败')
    const succeeded = runWith(TEST_SEED).events.find((e) => e.type === 'DAMAGE_DEALT')
    expect(failed).toBeDefined()
    expect(succeeded).toBeDefined()
  })

  it('非法目标：缺目标 / 潜行敌方单位均 INVALID_TARGET，RNG 不消耗', () => {
    const state = skillState({
      p1Faction: 'amd',
      rngState: TEST_SEED,
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-es', keywords: ['stealth'] })],
    })
    // 目标池经定义级 targetPool='anyCharacter' 声明（handler 步骤无 target 字段）：
    // 缺目标 → target_required；潜行现身前不可被指定 → not_in_pool
    const missing = catchRuleError(() => applyAction(state, heroPower('P1')))
    expect(missing.code).toBe('INVALID_TARGET')
    expect(missing.detail).toMatchObject({ reason: 'target_required', pools: ['anyCharacter'] })

    const error = catchRuleError(() => applyAction(state, heroPower('P1', unitRef('u-es'))))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'not_in_pool', pool: 'anyCharacter' })
    // 闸门拒绝：状态原样（rng.state 未被判定消耗）
    expect(stableHash(state)).toBe(stableHash(skillState({ p1Faction: 'amd', rngState: TEST_SEED, enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-es', keywords: ['stealth'] })] })))
  })
})

// ———————— 内置技能三：intel「驱动更新」 ————————

describe('USE_HERO_POWER：intel「驱动更新」（driver_update）', () => {
  it('draw sourceOwner 1：抽 1 张入手，事件 HERO_POWER_USED → CARD_DRAWN', () => {
    const state = skillState({ p1Faction: 'intel', handCount: 1 })
    const result = applyAction(state, heroPower('P1'))
    expect(result.state.players.P1.hand).toHaveLength(2)
    expect(result.state.players.P1.deck).toHaveLength(4)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'driver_update', target: null },
      { type: 'CARD_DRAWN', playerId: 'P1', cardId: 'smoke-gpu', source: 'deck' },
    ])
  })

  it('牌库为空：走疲劳管线（CARD_DRAWN{fatigue} → DAMAGE_DEALT → FATIGUE）', () => {
    const state = skillState({ p1Faction: 'intel' })
    state.players.P1.deck = []
    const result = applyAction(state, heroPower('P1'))
    expect(result.events.map((e) => e.type)).toEqual(['HERO_POWER_USED', 'CARD_DRAWN', 'DAMAGE_DEALT', 'FATIGUE'])
    expect(result.state.players.P1.fatigue).toBe(1)
    expect(result.state.players.P1.health).toBe(29)
  })

  it('无 chosen 步骤：多余的 target 宽容忽略（与出牌同取舍）', () => {
    const state = skillState({ p1Faction: 'intel', handCount: 1 })
    const result = applyAction(state, heroPower('P1', heroRef('P2')))
    expect(result.state.players.P1.hand).toHaveLength(2)
    expect(result.state.players.P2.health).toBe(30) // target 被忽略，无事发生
  })
})

// ———————— 内置技能四：neutral「清灰」 ————————

describe('USE_HERO_POWER：neutral「清灰」（dust_off）', () => {
  it('damage chosen anyCharacter 1：可打敌方 CPU，source = heroPower', () => {
    const state = skillState({ p1Faction: 'neutral' })
    const result = applyAction(state, heroPower('P1', heroRef('P2')))
    expect(result.state.players.P2.health).toBe(29)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'dust_off', target: heroRef('P2') },
      {
        type: 'DAMAGE_DEALT',
        source: { kind: 'heroPower', playerId: 'P1' },
        target: heroRef('P2'),
        amount: 1,
        remainingHealth: 29,
      },
    ])
  })

  it('anyCharacter 含己方单位/CPU：打自己的 1 血单位会阵亡并走死亡管线', () => {
    const state = skillState({
      p1Faction: 'neutral',
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-o1', health: 1, maxHealth: 1 })],
    })
    const result = applyAction(state, heroPower('P1', unitRef('u-o1')))
    expect(result.state.board.find((u) => u.instanceId === 'u-o1')).toBeUndefined()
    expect(result.state.players.P1.graveyard).toEqual([{ instanceId: 'u-o1', cardId: 'test-gpu' }])
    expect(result.events.map((e) => e.type)).toEqual(['HERO_POWER_USED', 'DAMAGE_DEALT', 'MINION_DIED'])
  })

  it('清灰也可指定己方 CPU（回血不适用，纯伤害）；打对方 CPU 到 0 触发 GAME_END', () => {
    const state = skillState({ p1Faction: 'neutral' })
    state.players.P2.health = 1
    const result = applyAction(state, heroPower('P1', heroRef('P2')))
    expect(result.state.phase).toBe('ended')
    expect(result.state.winner).toBe('P1')
    expect(result.events.at(-1)).toEqual({ type: 'GAME_END', winner: 'P1', reason: 'health_zero' })
  })
})

// ———————— 合法性拒绝与跨回合重置 ————————

describe('USE_HERO_POWER 合法性闸门（rules.md §3）', () => {
  it('非行动方使用 → NOT_YOUR_TURN', () => {
    const state = skillState({ p1Faction: 'neutral' })
    const error = catchRuleError(() => applyAction(state, heroPower('P2')))
    expect(error.code).toBe('NOT_YOUR_TURN')
  })

  it('本回合已使用 → INVALID_TARGET{reason: hero_power_used}（错误码裁定见汇报）', () => {
    const state = skillState({ p1Faction: 'neutral' })
    const first = applyAction(state, heroPower('P1', heroRef('P2')))
    expect(first.state.players.P1.heroPowerUsed).toBe(true)
    const second = catchRuleError(() => applyAction(first.state, heroPower('P1', heroRef('P2'))))
    expect(second.code).toBe('INVALID_TARGET')
    expect(second.detail).toMatchObject({ reason: 'hero_power_used', skillId: 'dust_off' })
  })

  it('功耗不足（mana < 200）→ INSUFFICIENT_MANA；原状态不被修改', () => {
    const state = skillState({ p1Faction: 'neutral', mana: 100 })
    const before = stableHash(state)
    const error = catchRuleError(() => applyAction(state, heroPower('P1', heroRef('P2'))))
    expect(error.code).toBe('INSUFFICIENT_MANA')
    expect(error.detail).toMatchObject({ cost: HERO_POWER_COST, mana: 100, skillId: 'dust_off' })
    expect(stableHash(state)).toBe(before)
  })

  it('对局结束后 → GAME_ENDED', () => {
    const state = skillState({ p1Faction: 'neutral' })
    const ended = applyAction(state, { type: 'CONCEDE', playerId: 'P2' }).state
    const error = catchRuleError(() => applyAction(ended, heroPower('P1')))
    expect(error.code).toBe('GAME_ENDED')
  })

  it('heroPowerUsed 跨回合重置（ENG1）：下个自身回合可再次使用', () => {
    let state = skillState({ p1Faction: 'neutral', p2Faction: 'intel', mana: 500 })
    state = applyAction(state, heroPower('P1', heroRef('P2'))).state // P1 用技能
    state = applyAction(state, { type: 'END_TURN', playerId: 'P1' }).state // → P2 回合
    state = applyAction(state, { type: 'END_TURN', playerId: 'P2' }).state // → P1 回合（turn 3）
    expect(state.players.P1.heroPowerUsed).toBe(false)
    expect(state.players.P1.mana).toBe(200) // 供电曲线：自身第 2 回合 = 200W，恰好够
    const again = applyAction(state, heroPower('P1', heroRef('P2')))
    expect(again.state.players.P1.heroPowerUsed).toBe(true)
    expect(again.events[0]).toMatchObject({ type: 'HERO_POWER_USED', skillId: 'dust_off' })
  })
})

// ———————— getLegalActions 枚举 ————————

describe('getLegalActions：USE_HERO_POWER 枚举（M1-ENG5）', () => {
  it('未用且功耗足：按 chosen 池逐目标枚举（空场 anyCharacter = 双方 CPU，己方在前）', () => {
    const state = skillState({ p1Faction: 'neutral' })
    const powers = getLegalActions(state, 'P1').filter((a): a is Extract<Action, { type: 'USE_HERO_POWER' }> => a.type === 'USE_HERO_POWER')
    expect(powers).toEqual([
      { type: 'USE_HERO_POWER', playerId: 'P1', target: heroRef('P1') },
      { type: 'USE_HERO_POWER', playerId: 'P1', target: heroRef('P2') },
    ])
  })

  it('已使用 / 功耗不足 / 非行动方 / 对局结束：均不枚举', () => {
    const used = applyAction(skillState({ p1Faction: 'neutral' }), heroPower('P1', heroRef('P2'))).state
    expect(getLegalActions(used, 'P1').some((a) => a.type === 'USE_HERO_POWER')).toBe(false)

    const poor = skillState({ p1Faction: 'neutral', mana: 100 })
    expect(getLegalActions(poor, 'P1').some((a) => a.type === 'USE_HERO_POWER')).toBe(false)

    expect(getLegalActions(skillState({ p1Faction: 'neutral' }), 'P2')).toEqual([])

    const ended = applyAction(skillState({ p1Faction: 'neutral' }), { type: 'CONCEDE', playerId: 'P1' }).state
    expect(getLegalActions(ended, 'P1')).toEqual([])
  })

  it('单位目标展开：dust_off 候选 = 场上单位（board 序，滤敌方潜行）+ 双方 CPU', () => {
    const state = skillState({
      p1Faction: 'neutral',
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-o1' })],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-es', keywords: ['stealth'] }), makeUnit({ ownerId: 'P2', instanceId: 'u-e2' })],
    })
    const powers = getLegalActions(state, 'P1').filter((a) => a.type === 'USE_HERO_POWER')
    expect(powers).toEqual([
      { type: 'USE_HERO_POWER', playerId: 'P1', target: unitRef('u-o1') },
      { type: 'USE_HERO_POWER', playerId: 'P1', target: unitRef('u-e2') },
      { type: 'USE_HERO_POWER', playerId: 'P1', target: heroRef('P1') },
      { type: 'USE_HERO_POWER', playerId: 'P1', target: heroRef('P2') },
    ])
  })

  it('无幽灵动作：枚举出的 USE_HERO_POWER 全部可被 applyAction 接受', () => {
    const states = [
      skillState({ p1Faction: 'neutral', board: [makeUnit({ ownerId: 'P1', instanceId: 'u-o1' })], enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1' })] }),
      skillState({ p1Faction: 'nvidia', board: [makeUnit({ ownerId: 'P1', instanceId: 'u-o1' })] }),
      skillState({ p1Faction: 'intel', handCount: 2 }),
      skillState({ p1Faction: 'amd' }),
    ]
    for (const state of states) {
      const before = stableHash(state)
      for (const action of getLegalActions(state, 'P1')) {
        if (action.type === 'USE_HERO_POWER') {
          expect(() => applyAction(state, action)).not.toThrow()
        }
      }
      expect(stableHash(state)).toBe(before)
    }
  })
})

// ———————— 确定性 ————————

describe('USE_HERO_POWER 确定性（rules.md §11）', () => {
  // P1（neutral 清灰）跨两个自身回合各用一次技能：use → END_TURN → P2 pass → use
  const buildActions = (): readonly Action[] => [
    heroPower('P1', heroRef('P2')),
    { type: 'END_TURN', playerId: 'P1' },
    { type: 'END_TURN', playerId: 'P2' },
    heroPower('P1', heroRef('P2')),
  ]

  it('同 state + 动作序列两次运行：状态哈希与事件流逐字节一致', () => {
    const run = () => {
      let state = skillState({ mana: 500 })
      const events: GameEvent[] = []
      for (const action of buildActions()) {
        const result = applyAction(state, action)
        state = result.state
        events.push(...result.events)
      }
      return { state, events }
    }
    const a = run()
    const b = run()
    expect(a.events).toEqual(b.events)
    expect(stableHash(a.state)).toBe(stableHash(b.state))
    // P2 被清灰 2 次：30 → 28；heroPowerUsed 因 heroPowerUsed=false 重置后可再次使用
    expect(a.state.players.P2.health).toBe(28)
    expect(a.state.players.P1.health).toBe(30)
    expect(a.state.players.P1.heroPowerUsed).toBe(true)
    expect(a.state.players.P1.mana).toBe(0) // 自身第 2 回合供电 200W，恰好一次技能
  })
})
