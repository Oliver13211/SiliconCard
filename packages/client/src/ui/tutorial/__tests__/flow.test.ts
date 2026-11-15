/**
 * 教程引导流端到端验证（P2-EDU1 定向测试）——
 * 用固定 seed + 教学卡组跑每个关卡/分节的引导路径（玩家视角决策，只消费
 * view + legalActions + 门控），断言过关判定在真实事件流上触发。
 *
 * 这是对 phase2-plan §P2-EDU1「教程内容全部数据驱动且可完成」的兜底回归：
 * 引擎或卡组变动导致某关不可完成时，本文件第一时间红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarness, expectPassed, runGuidedFlow } from './harness'
import { TUTORIAL_LEVELS, TUTORIAL_SEEDS, tutorialLevelById } from '../levels'
import { enemyUnitDied, maxPlaysInOnePlayerTurn, playerHeroPowerUses } from '../objectives'
import type { TutorialLevel, TutorialSection } from '../types'

const level1 = tutorialLevelById(1) as TutorialLevel
const level2 = tutorialLevelById(2) as TutorialLevel
const level3 = tutorialLevelById(3) as TutorialLevel
const level4 = tutorialLevelById(4) as TutorialLevel

async function runLevel(level: TutorialLevel, section: TutorialSection | null, eagerSkill = false) {
  const harness = createHarness()
  await runGuidedFlow(harness, level, section, { eagerSkill })
  expectPassed(harness)
  return harness
}

describe('关1 通电：一个回合内打出 3 张卡', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it(`seed=${TUTORIAL_SEEDS.level1} 引导流可完成`, async () => {
    const harness = await runLevel({ ...level1, seed: TUTORIAL_SEEDS.level1 }, null)
    expect(maxPlaysInOnePlayerTurn(harness.events())).toBeGreaterThanOrEqual(3)
    // 步骤机推进：气泡至少走过"第一张卡"与"结束回合"两步
    expect(harness.controller.status().stepIndex).toBeGreaterThanOrEqual(2)
  })
})

describe('关2 上机：摧毁敌方一台显卡（技能+攻击链）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it(`seed=${TUTORIAL_SEEDS.level2} 引导流可完成`, async () => {
    const harness = await runLevel({ ...level2, seed: TUTORIAL_SEEDS.level2 }, null)
    const events = harness.events()
    expect(enemyUnitDied(events)).toBe(true)
    expect(playerHeroPowerUses(events)).toBeGreaterThanOrEqual(1) // 信仰充值步骤真实走过
    expect(events.some((event) => event.type === 'ATTACK_DECLARED')).toBe(true)
  })
})

describe('关3 关键词七连：逐节"必用该关键词"', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('s1 信仰充值：对面的刀被迫落在 9900K 上', async () => {
    const harness = await runLevel(level3, tutorialLevelById(3)?.sections?.[0] ?? null)
    const events = harness.events()
    expect(events.some((event) => event.type === 'CARD_PLAYED' && event.cardId === 'intel-i9-9900k')).toBe(true)
    expect(events.some((event) => event.type === 'ATTACK_DECLARED' && event.target.kind === 'unit')).toBe(true)
  })

  it('s2 三年质保：AppleCare+ 打出后真实吃掉一刀', async () => {
    const harness = await runLevel(level3, tutorialLevelById(3)?.sections?.[1] ?? null)
    const events = harness.events()
    const playedIndex = events.findIndex((event) => event.type === 'CARD_PLAYED' && event.cardId === 'apple-applecare-plus')
    expect(playedIndex).toBeGreaterThanOrEqual(0)
    expect(events.slice(playedIndex + 1).some((event) => event.type === 'DAMAGE_DEALT' && event.shieldConsumed === true)).toBe(true)
  })

  it('s3 超频：天玑 9300 入场当回合完成攻击', async () => {
    const harness = await runLevel(level3, tutorialLevelById(3)?.sections?.[2] ?? null)
    expect(harness.events().some((event) => event.type === 'CARD_PLAYED' && event.cardId === 'arm-dimensity-9300')).toBe(true)
    expectPassed(harness)
  })

  it('s4 双芯 GPU：M1 Ultra 同回合两刀', async () => {
    const harness = await runLevel(level3, tutorialLevelById(3)?.sections?.[3] ?? null)
    const events = harness.events()
    expect(events.some((event) => event.type === 'CARD_PLAYED' && event.cardId === 'apple-m1-ultra')).toBe(true)
    expect(events.filter((event) => event.type === 'ATTACK_DECLARED').length).toBeGreaterThanOrEqual(2)
  })

  it('s5 蓝屏/传家宝：G99 战死且亡语召唤公版亮机卡', async () => {
    const harness = await runLevel(level3, tutorialLevelById(3)?.sections?.[4] ?? null)
    const events = harness.events()
    const diedIndex = events.findIndex((event) => event.type === 'MINION_DIED' && event.unit.cardId === 'arm-helio-g99')
    expect(diedIndex).toBeGreaterThanOrEqual(0)
    expect(
      events
        .slice(diedIndex + 1)
        .some((event) => event.type === 'MINION_SUMMONED' && event.source === 'effect' && event.unit.cardId === 'arm-mali-reference'),
    ).toBe(true)
  })

  it('s6 无输出亮机：潜行躲一刀后主动现身', async () => {
    const harness = await runLevel(level3, tutorialLevelById(3)?.sections?.[5] ?? null)
    const events = harness.events()
    // 对面先砍了玩家 CPU（潜行保护演示）——段内玩家 CPU 掉血且玩家无其他可被指定单位
    expect(events.some((event) => event.type === 'DAMAGE_DEALT' && event.target.kind === 'hero' && event.target.playerId === 'P1')).toBe(true)
    // M2 亲自现身（过关判定本体）
    expectPassed(harness)
  })

  it('s7 跳闸：Exynos 打出后下回合开局 BURN_OUT', async () => {
    const harness = await runLevel(level3, tutorialLevelById(3)?.sections?.[6] ?? null)
    const events = harness.events()
    const playedIndex = events.findIndex((event) => event.type === 'CARD_PLAYED' && event.cardId === 'arm-exynos-8895')
    expect(playedIndex).toBeGreaterThanOrEqual(0)
    expect(events.slice(playedIndex + 1).some((event) => event.type === 'BURN_OUT' && event.playerId === 'P1')).toBe(true)
  })
})

describe('关4 派系对决：善用 3 次派系技能', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it(`seed=${TUTORIAL_SEEDS.level4} 引导流可完成（eagerSkill 走法）`, async () => {
    const harness = await runLevel({ ...level4, seed: TUTORIAL_SEEDS.level4 }, null, true)
    expect(playerHeroPowerUses(harness.events())).toBeGreaterThanOrEqual(3)
  })
})

describe('关卡数据完整性', () => {
  it('五关齐备，关3 恰好七节且节 id 唯一', () => {
    expect(TUTORIAL_LEVELS.map((level) => level.id)).toEqual([1, 2, 3, 4, 5])
    const sections = level3.sections ?? []
    expect(sections.map((section) => section.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7'])
    const keywords = sections.map((section) => section.keyword)
    expect(new Set(keywords).size).toBe(7)
  })
})
