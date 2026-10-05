/**
 * M4 三系派系技能单测（docs/rules.md §8 M4 行，M4-CNT5 引擎侧前置）：
 * apple「能效比」/ qualcomm「TOPS 营销」/ arm「公版方案」。
 *
 * 三技能均为既有原语组合（gainArmor / buff random / summon），无新原语、
 * 无 GameState/Action/GameEvent 契约变更。测试风格与 heroPower.test.ts（M1 四系）
 * 一致；覆盖：
 * - 三技能实打结算与事件序列（护甲增量 / 随机增益 / 1/1 token 上场）；
 * - random 选择器种子确定性（board 序候选恰取一枚、恰好消耗一次 RNG、池空不消耗）；
 * - summon 召唤失调（attacksRemaining=0）与场满静默截断；
 * - getLegalActions 枚举（无 chosen 步骤 → 单个无目标动作，空场照样可用——
 *   与 DLSS「chosen 池空则动作不存在」的边界差异）；
 * - 七系内置基线齐全（resetFactionSkills 恢复）与新派系 initGame 放行。
 *
 * arm token（cardId=arm-mali-reference）的 JSON 由 content 批次按 §4 schema 落盘；
 * 本文件按任务约定内联注册（core 禁止 import content 包），字段与 M4-CNT5 拍板一致。
 */

import { describe, expect, it } from 'vitest'
import { BOARD_LIMIT, HERO_POWER_COST } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { Action } from '../types/actions'
import type { GameState, PlayerId, TargetRef } from '../types/state'
import type { GameSetup } from '../types/state'
import { catchRuleError, makeDeckSpec, makeGameState, makePlayer, makeUnit, TEST_SEED } from '../testing/state'
import { stableHash } from '../testing/hash'
import { applyAction, getLegalActions } from './apply'
import { initGame } from './init'
import { createRng, nextUint32 } from './prng'
import { getFactionSkill, resetFactionSkills } from './factions'
import { registerCardDefinitions } from './registry'

/** arm「公版方案」token 定义（M4-CNT5 约定）：content 批次落盘前由测试内联注册 */
const ARM_MALI_REFERENCE: CardDefinition = {
  id: 'arm-mali-reference',
  name: '公版亮机卡',
  faction: 'arm',
  type: 'gpu',
  cost: 100,
  attack: 1,
  health: 1,
  rarity: 'common',
}

registerCardDefinitions([ARM_MALI_REFERENCE])

const heroPower = (playerId: PlayerId, target?: TargetRef): Action =>
  ({ type: 'USE_HERO_POWER', playerId, ...(target ? { target } : {}) })

interface SkillStateOptions {
  p1Faction?: string
  mana?: number
  board?: ReturnType<typeof makeUnit>[]
  enemyBoard?: ReturnType<typeof makeUnit>[]
  rngState?: number
}

/** M4 技能测试态：双方牌库留牌避免疲劳噪音，P1 满供电（默认 500 ≥ 200） */
function skillState(opts: SkillStateOptions = {}): GameState {
  const deck = Array.from({ length: 5 }, () => ({ cardId: 'smoke-gpu' }))
  return makeGameState({
    players: {
      P1: {
        ...makePlayer('P1', { faction: opts.p1Faction ?? 'neutral' }),
        mana: opts.mana ?? 500,
        maxMana: opts.mana ?? 500,
        deck,
      },
      P2: { ...makePlayer('P2'), deck },
    },
    board: [...(opts.board ?? []), ...(opts.enemyBoard ?? [])],
    ...(opts.rngState !== undefined ? { rng: { state: opts.rngState } } : {}),
  })
}

// ———————— M4 技能一：apple「能效比」（efficiency） ————————

describe('USE_HERO_POWER：apple「能效比」（efficiency）', () => {
  it('gainArmor sourceOwner 2：护甲 0→2、扣费 200、置位 heroPowerUsed；事件 HERO_POWER_USED → ARMOR_GAINED', () => {
    const state = skillState({ p1Faction: 'apple' })
    const result = applyAction(state, heroPower('P1'))
    expect(result.state.players.P1.armor).toBe(2)
    expect(result.state.players.P1.mana).toBe(300)
    expect(result.state.players.P1.heroPowerUsed).toBe(true)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'efficiency', target: null },
      { type: 'ARMOR_GAINED', playerId: 'P1', amount: 2, totalArmor: 2 },
    ])
    expect(result.state.rng.state).toBe(TEST_SEED) // 护甲原语不消耗 RNG
  })

  it('护甲可叠加：已有 3 点 → 5 点，ARMOR_GAINED.totalArmor 携带累计值', () => {
    const state = skillState({ p1Faction: 'apple' })
    state.players.P1.armor = 3
    const result = applyAction(state, heroPower('P1'))
    expect(result.state.players.P1.armor).toBe(5)
    expect(result.events.at(-1)).toEqual({ type: 'ARMOR_GAINED', playerId: 'P1', amount: 2, totalArmor: 5 })
  })

  it('无 chosen 步骤：无需目标即可用；多余 target 宽容忽略（对方 CPU 不掉血）', () => {
    const state = skillState({ p1Faction: 'apple' })
    const result = applyAction(state, heroPower('P1', { kind: 'hero', playerId: 'P2' }))
    expect(result.state.players.P1.armor).toBe(2)
    expect(result.state.players.P2.health).toBe(30) // target 被忽略，无事发生
  })

  it('getLegalActions：空场（无己方单位）照样枚举单个无目标动作（gainArmor 无 chosen 池）', () => {
    const state = skillState({ p1Faction: 'apple' })
    const powers = getLegalActions(state, 'P1').filter((a) => a.type === 'USE_HERO_POWER')
    expect(powers).toEqual([{ type: 'USE_HERO_POWER', playerId: 'P1' }])
  })
})

// ———————— M4 技能二：qualcomm「TOPS 营销」（tops_marketing） ————————

describe('USE_HERO_POWER：qualcomm「TOPS 营销」（tops_marketing）', () => {
  it('buff random ownUnits +1/+1：种子 RNG 按 board 序候选恰取一枚，恰好消耗一次 RNG', () => {
    const state = skillState({
      p1Faction: 'qualcomm',
      rngState: TEST_SEED,
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 2, health: 2, maxHealth: 2 }),
        makeUnit({ ownerId: 'P1', instanceId: 'u-o2', attack: 3, health: 3, maxHealth: 3 }),
      ],
      enemyBoard: [makeUnit({ ownerId: 'P2', instanceId: 'u-e1', attack: 9, health: 9, maxHealth: 9 })],
    })
    // 候选 = ownUnits 池按 board 序（[u-o1, u-o2]）；nextInt(2) 无拒绝采样（2 | 2^32），
    // 恰好消耗一次 nextUint32——用同一 PRNG 计算期望命中，锁定「board 序 + 种子 RNG」契约
    const expectedId = createRng(TEST_SEED).nextInt(2) === 0 ? 'u-o1' : 'u-o2'
    const buffedBase = expectedId === 'u-o1' ? { attack: 2, health: 2 } : { attack: 3, health: 3 }

    const result = applyAction(state, heroPower('P1'))
    const buffed = result.state.board.find((u) => u.instanceId === expectedId)
    expect(buffed).toMatchObject({
      instanceId: expectedId,
      attack: buffedBase.attack + 1,
      health: buffedBase.health + 1,
      maxHealth: buffedBase.health + 1, // buff health 同步抬 maxHealth（buffUnit 语义）
    })
    // 恰一枚：其余单位（含己方另一枚与敌方）原样
    for (const unit of result.state.board.filter((u) => u.instanceId !== expectedId)) {
      const before = state.board.find((u) => u.instanceId === unit.instanceId)
      expect(unit.attack).toBe(before?.attack)
      expect(unit.health).toBe(before?.health)
      expect(unit.maxHealth).toBe(before?.maxHealth)
    }
    // buff 无目录事件：仅技能演出；RNG 恰耗一次
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'tops_marketing', target: null },
    ])
    expect(result.state.rng.state).toBe(nextUint32(TEST_SEED >>> 0).state)
    expect(result.state.players.P1.mana).toBe(300)
    expect(result.state.players.P1.heroPowerUsed).toBe(true)
  })

  it('随机即种子决定（§11）：同 state 两次运行逐字节一致；异 seed 可翻盘命中另一枚', () => {
    const makeBoard = () => [
      makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 2, health: 2, maxHealth: 2 }),
      makeUnit({ ownerId: 'P1', instanceId: 'u-o2', attack: 3, health: 3, maxHealth: 3 }),
    ]
    const runWith = (rngState: number) =>
      applyAction(skillState({ p1Faction: 'qualcomm', rngState, board: makeBoard() }), heroPower('P1'))
    const pickOf = (rngState: number) => (createRng(rngState).nextInt(2) === 0 ? 'u-o1' : 'u-o2')

    const a = runWith(TEST_SEED)
    const b = runWith(TEST_SEED)
    expect(a.events).toEqual(b.events)
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state))

    // 异 seed 翻盘：找一个首抽奇偶不同的种子——同动作序列、命中另一枚（§11 种子唯一决定）
    const flippedSeed = [1, 2, 3, 4, 5, 6, 7, 8].find((s) => pickOf(s) !== pickOf(TEST_SEED))
    expect(flippedSeed).toBeDefined()
    const flipped = runWith(flippedSeed as number)
    const flippedId = pickOf(flippedSeed as number)
    const baseId = pickOf(TEST_SEED)
    // 翻盘种子命中的那枚获得 +1/+1，基线种子命中的那枚原样
    expect(flipped.state.board.find((u) => u.instanceId === flippedId)?.attack).toBe(flippedId === 'u-o1' ? 3 : 4)
    expect(flipped.state.board.find((u) => u.instanceId === baseId)?.attack).toBe(baseId === 'u-o1' ? 2 : 3)
  })

  it('己方空场：技能可用（无 chosen 不设目标闸门）、池空不消耗 RNG、无事发生但功耗照扣', () => {
    const state = skillState({ p1Faction: 'qualcomm' })
    const before = stableHash(state)
    const result = applyAction(state, heroPower('P1'))
    expect(result.state.players.P1.mana).toBe(300) // 功耗照扣（技能"营销过了"）
    expect(result.state.players.P1.heroPowerUsed).toBe(true)
    expect(result.state.rng.state).toBe(TEST_SEED) // 池空不消耗 RNG（§5 既定随机语义）
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'tops_marketing', target: null },
    ])
    // 与 DLSS 的边界差异：无 chosen 池 → 空场仍枚举动作（选中与否由 RNG 结算时裁定）
    expect(getLegalActions(state, 'P1').filter((a) => a.type === 'USE_HERO_POWER')).toEqual([
      { type: 'USE_HERO_POWER', playerId: 'P1' },
    ])
    expect(stableHash(state)).toBe(before) // 原状态不变
  })

  it('getLegalActions：单个无目标动作且全部可实打（无幽灵动作）', () => {
    const state = skillState({
      p1Faction: 'qualcomm',
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-o1' })],
    })
    const powers = getLegalActions(state, 'P1').filter((a) => a.type === 'USE_HERO_POWER')
    expect(powers).toEqual([{ type: 'USE_HERO_POWER', playerId: 'P1' }])
    for (const action of powers) expect(() => applyAction(state, action)).not.toThrow()
  })
})

// ———————— M4 技能三：arm「公版方案」（reference_design） ————————

describe('USE_HERO_POWER：arm「公版方案」（reference_design）', () => {
  it('summon 1/1 token：己方场上末尾新增 arm-mali-reference 实例；召唤失调 attacksRemaining=0', () => {
    const state = skillState({
      p1Faction: 'arm',
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-o1', attack: 5, health: 5, maxHealth: 5 })],
    })
    const result = applyAction(state, heroPower('P1'))
    expect(result.state.board).toHaveLength(2)
    const token = result.state.board[1] // board = 入场顺序：token 追加在末尾
    expect(token).toMatchObject({
      instanceId: 'u1', // instanceId 取自全局计数（makeGameState nextInstanceId=1）
      cardId: 'arm-mali-reference',
      ownerId: 'P1',
      attack: 1,
      health: 1,
      maxHealth: 1,
      keywords: [],
      summonedOnTurn: 1,
      attacksRemaining: 0, // 召唤失调：入场当回合不可攻击
      attackedThisTurn: false,
    })
    expect(result.state.nextInstanceId).toBe(2)
    expect(result.state.players.P1.mana).toBe(300)
    expect(result.state.players.P1.heroPowerUsed).toBe(true)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'reference_design', target: null },
      { type: 'MINION_SUMMONED', unit: token, source: 'effect' },
    ])
    expect(result.state.rng.state).toBe(TEST_SEED) // summon 原语不消耗 RNG
  })

  it('场满（己方 BOARD_LIMIT=7）：召唤静默截断——无 MINION_SUMMONED、功耗照扣、次数照置位', () => {
    const board = Array.from({ length: BOARD_LIMIT }, (_, i) =>
      makeUnit({ ownerId: 'P1', instanceId: `u-full-${i}`, attack: 1, health: 1, maxHealth: 1 }),
    )
    const state = skillState({ p1Faction: 'arm', board })
    const result = applyAction(state, heroPower('P1'))
    expect(result.state.board).toHaveLength(BOARD_LIMIT) // 场上未新增
    expect(result.state.board.every((u) => u.cardId !== 'arm-mali-reference')).toBe(true)
    expect(result.state.players.P1.mana).toBe(300)
    expect(result.state.players.P1.heroPowerUsed).toBe(true)
    expect(result.events).toEqual([
      { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'reference_design', target: null },
    ])
  })

  it('getLegalActions：单个无目标动作；多余 target 宽容忽略', () => {
    const state = skillState({ p1Faction: 'arm' })
    expect(getLegalActions(state, 'P1').filter((a) => a.type === 'USE_HERO_POWER')).toEqual([
      { type: 'USE_HERO_POWER', playerId: 'P1' },
    ])
    const result = applyAction(state, heroPower('P1', { kind: 'unit', instanceId: 'ghost' }))
    expect(result.state.board).toHaveLength(1) // target 被忽略，token 照常上场
    expect(result.state.board[0]?.cardId).toBe('arm-mali-reference')
  })
})

// ———————— 注册基线与开局校验 ————————

describe('M4 三系注册基线（builtin.ts 追加后 §8 七系齐全）', () => {
  it('resetFactionSkills 后七系技能齐全，cost 均为 HERO_POWER_COST（§8 全表）', () => {
    resetFactionSkills()
    const expected: Readonly<Record<string, string>> = {
      nvidia: 'dlss',
      amd: 'ray_tracing_try',
      intel: 'driver_update',
      neutral: 'dust_off',
      apple: 'efficiency',
      qualcomm: 'tops_marketing',
      arm: 'reference_design',
    }
    for (const [factionId, skillId] of Object.entries(expected)) {
      const skill = getFactionSkill(factionId)
      expect(skill?.skillId).toBe(skillId)
      expect(skill?.cost).toBe(HERO_POWER_COST)
    }
  })

  it('initGame 接受新派系（apple vs arm）开局；供电到位后技能实打走通（M4-CNT5 引擎侧放行）', () => {
    const setup: GameSetup = {
      seed: TEST_SEED,
      players: [
        { id: 'P1', faction: 'apple', deck: makeDeckSpec() },
        { id: 'P2', faction: 'arm', deck: makeDeckSpec() },
      ],
    }
    const fresh = initGame(setup) // initGame 只返回 state（M1-ENG7 契约定稿）
    expect(fresh.players.P1.faction).toBe('apple')
    expect(fresh.players.P2.faction).toBe('arm')
    expect(fresh.players.P1.mana).toBe(100) // 首回合 100W < 200W：注册放行 ≠ 首回合即可用

    // 推进到 P1 自身第 2 回合（turn 3，供电 200W）：能效比 +2 护甲实打
    let state = applyAction(fresh, { type: 'END_TURN', playerId: 'P1' }).state
    state = applyAction(state, { type: 'END_TURN', playerId: 'P2' }).state
    const armored = applyAction(state, heroPower('P1'))
    expect(armored.state.players.P1.armor).toBe(2)
    expect(armored.events[0]).toMatchObject({ type: 'HERO_POWER_USED', skillId: 'efficiency' })

    // 推进到 P2 自身第 2 回合（turn 4，供电 200W）：公版方案 1/1 token 上场
    //（content 批次落盘前，由本文件内联注册的 token 定义支撑 summon 原语）
    const p2Ready = applyAction(armored.state, { type: 'END_TURN', playerId: 'P1' }).state
    const summoned = applyAction(p2Ready, heroPower('P2'))
    expect(summoned.state.board.some((u) => u.cardId === 'arm-mali-reference' && u.ownerId === 'P2')).toBe(true)
    expect(summoned.events.at(-1)).toMatchObject({ type: 'MINION_SUMMONED', source: 'effect' })
  })

  it('非法使用仍被既有闸门拦截（非行动方 NOT_YOUR_TURN / 功耗不足 INSUFFICIENT_MANA）', () => {
    const state = skillState({ p1Faction: 'apple' })
    expect(catchRuleError(() => applyAction(state, heroPower('P2'))).code).toBe('NOT_YOUR_TURN')
    const poor = skillState({ p1Faction: 'arm', mana: 100 })
    const error = catchRuleError(() => applyAction(poor, heroPower('P1')))
    expect(error.code).toBe('INSUFFICIENT_MANA')
    expect(error.detail).toMatchObject({ cost: HERO_POWER_COST, mana: 100, skillId: 'reference_design' })
  })
})
