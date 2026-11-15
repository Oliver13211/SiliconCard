/**
 * 过关判定纯函数单测（P2-EDU1 定向测试）—— 逐关构造事件样例（正例 + 反例）。
 * 判定唯一事实源是事件流：样例手工构造，不依赖引擎对局。
 */

import { describe, expect, it } from 'vitest'
import type { BoardUnit, GameEvent, Keyword, TargetRef } from '@siliconcard/core'
import {
  level1Objective,
  level2Objective,
  level4Objective,
  maxPlaysInOnePlayerTurn,
  playsInCurrentPlayerTurn,
  playerHeroPowerUses,
  sectionChargeObjective,
  sectionDeathrattleObjective,
  sectionOverloadObjective,
  sectionShieldObjective,
  sectionStealthObjective,
  sectionTauntObjective,
  sectionWindfuryObjective,
} from '../objectives'

const unit = (
  instanceId: string,
  cardId: string,
  ownerId: 'P1' | 'P2',
  keywords: Keyword[] = [],
): BoardUnit => ({
  instanceId,
  cardId,
  ownerId,
  attack: 2,
  health: 2,
  maxHealth: 2,
  keywords,
  summonedOnTurn: 1,
  attacksRemaining: 1,
  attackedThisTurn: false,
})

const turnStart = (turn: number, playerId: 'P1' | 'P2'): GameEvent => ({
  type: 'TURN_START',
  turn,
  playerId,
  maxMana: 100,
  drawCount: 1,
})

const played = (uid: string, cardId: string, target: TargetRef | null = null): GameEvent => ({
  type: 'CARD_PLAYED',
  playerId: 'P1',
  uid,
  cardId,
  cost: 100,
  target,
})

const summoned = (instanceId: string, cardId: string, ownerId: 'P1' | 'P2', keywords: Keyword[] = []): GameEvent => ({
  type: 'MINION_SUMMONED',
  source: 'play',
  unit: unit(instanceId, cardId, ownerId, keywords),
})

const attacked = (attackerId: string, target: TargetRef): GameEvent => ({
  type: 'ATTACK_DECLARED',
  attackerId,
  target,
})

const died = (instanceId: string, cardId: string, ownerId: 'P1' | 'P2'): GameEvent => ({
  type: 'MINION_DIED',
  unit: unit(instanceId, cardId, ownerId),
  cause: 'damage',
})

const damaged = (target: TargetRef, extra: { shieldConsumed?: boolean } = {}): GameEvent => ({
  type: 'DAMAGE_DEALT',
  source: { kind: 'unit', instanceId: 'atk1' },
  target,
  amount: 2,
  remainingHealth: 1,
  ...extra,
})

const tauntTarget: TargetRef = { kind: 'unit', instanceId: 'u-taunt' }
const enemyHero: TargetRef = { kind: 'hero', playerId: 'P2' }
const ownHero: TargetRef = { kind: 'hero', playerId: 'P1' }

describe('关1：一个回合内打出 3 张卡', () => {
  it('正例：同一 P1 回合 3 张 CARD_PLAYED', () => {
    const events: GameEvent[] = [turnStart(1, 'P1'), played('h1', 'a'), played('h2', 'b'), played('h3', 'c')]
    expect(maxPlaysInOnePlayerTurn(events)).toBe(3)
    expect(level1Objective(events)).toBe(true)
  })

  it('反例：跨回合累计 3 张不算（1 + 2）', () => {
    const events: GameEvent[] = [
      turnStart(1, 'P1'),
      played('h1', 'a'),
      turnStart(2, 'P2'),
      turnStart(3, 'P1'),
      played('h2', 'b'),
      played('h3', 'c'),
    ]
    expect(maxPlaysInOnePlayerTurn(events)).toBe(2)
    expect(level1Objective(events)).toBeNull()
  })

  it('进度：当前回合张数（跨回合后归零）', () => {
    const events: GameEvent[] = [turnStart(1, 'P1'), played('h1', 'a'), played('h2', 'b'), turnStart(2, 'P2'), turnStart(3, 'P1')]
    expect(playsInCurrentPlayerTurn(events)).toBe(0)
    events.push(played('h3', 'c'))
    expect(playsInCurrentPlayerTurn(events)).toBe(1)
  })
})

describe('关2：摧毁敌方一台显卡', () => {
  it('正例：P2 单位 MINION_DIED', () => {
    expect(level2Objective([died('e1', 'intel-arc-a380', 'P2')])).toBe(true)
  })

  it('反例：自己单位死亡不算', () => {
    expect(level2Objective([died('m1', 'amd-rx-550', 'P1')])).toBeNull()
  })
})

describe('关4：善用 3 次派系技能', () => {
  const skill: GameEvent = { type: 'HERO_POWER_USED', playerId: 'P1', skillId: 'dust_off', target: enemyHero }

  it('正例：3 次使用', () => {
    expect(level4Objective([skill, skill, skill])).toBe(true)
    expect(playerHeroPowerUses([skill, skill, skill])).toBe(3)
  })

  it('反例：2 次不够', () => {
    expect(level4Objective([skill, skill])).toBeNull()
  })

  it('反例：对面的技能使用不算', () => {
    expect(level4Objective([{ type: 'HERO_POWER_USED', playerId: 'P2', skillId: 'dust_off', target: ownHero }, skill, skill])).toBeNull()
  })
})

describe('关3-s1 信仰充值：对面的刀被迫落在嘲讽单位上', () => {
  const base: GameEvent[] = [
    turnStart(1, 'P1'),
    played('h1', 'intel-i9-9900k'),
    summoned('u-taunt', 'intel-i9-9900k', 'P1', ['taunt']),
    turnStart(2, 'P2'),
    summoned('e1', 'intel-arc-a380', 'P2'),
  ]

  it('正例：P2 攻击目标为嘲讽单位', () => {
    expect(sectionTauntObjective([...base, attacked('e1', tauntTarget)])).toBe(true)
  })

  it('反例：还没嘲讽单位被攻击', () => {
    expect(sectionTauntObjective(base)).toBeNull()
  })

  it('反例：自己的攻击打嘲讽单位不算', () => {
    expect(sectionTauntObjective([...base, attacked('u-taunt', { kind: 'unit', instanceId: 'e1' })])).toBeNull()
  })
})

describe('关3-s2 三年质保：质保真实吃掉一刀', () => {
  const base: GameEvent[] = [
    turnStart(1, 'P1'),
    played('h1', 'amd-rx-550'),
    summoned('m1', 'amd-rx-550', 'P1'),
    played('h2', 'apple-applecare-plus', { kind: 'unit', instanceId: 'm1' }),
  ]

  it('正例：AppleCare+ 打出后出现 shieldConsumed 伤害', () => {
    expect(sectionShieldObjective([...base, damaged({ kind: 'unit', instanceId: 'm1' }, { shieldConsumed: true })])).toBe(true)
  })

  it('反例：质保上场前吃到的伤害不算', () => {
    expect(sectionShieldObjective([damaged({ kind: 'unit', instanceId: 'm1' }, { shieldConsumed: true })])).toBeNull()
  })

  it('反例：普通伤害（无 shieldConsumed）不算', () => {
    expect(sectionShieldObjective([...base, damaged({ kind: 'unit', instanceId: 'm1' })])).toBeNull()
  })
})

describe('关3-s3 超频：入场当回合完成攻击', () => {
  const base: GameEvent[] = [
    turnStart(3, 'P1'),
    played('h1', 'arm-dimensity-9300'),
    summoned('c1', 'arm-dimensity-9300', 'P1', ['charge']),
  ]

  it('正例：同回合 ATTACK_DECLARED', () => {
    expect(sectionChargeObjective([...base, attacked('c1', { kind: 'unit', instanceId: 'e1' })])).toBe(true)
  })

  it('反例：攻击发生在下一回合（召唤失调路径）', () => {
    const events: GameEvent[] = [...base, turnStart(4, 'P2'), turnStart(5, 'P1'), attacked('c1', enemyHero)]
    expect(sectionChargeObjective(events)).toBeNull()
  })

  it('反例：别的单位攻击不算', () => {
    expect(sectionChargeObjective([...base, attacked('other', enemyHero)])).toBeNull()
  })
})

describe('关3-s4 双芯 GPU：同一回合两刀', () => {
  const base: GameEvent[] = [
    turnStart(7, 'P1'),
    played('h1', 'apple-m1-ultra'),
    summoned('w1', 'apple-m1-ultra', 'P1', ['windfury']),
  ]

  it('正例：同回合 2 次 ATTACK_DECLARED', () => {
    expect(sectionWindfuryObjective([...base, attacked('w1', enemyHero), attacked('w1', enemyHero)])).toBe(true)
  })

  it('反例：只砍一刀', () => {
    expect(sectionWindfuryObjective([...base, attacked('w1', enemyHero)])).toBeNull()
  })

  it('反例：两刀分两回合', () => {
    const events: GameEvent[] = [...base, attacked('w1', enemyHero), turnStart(8, 'P2'), turnStart(9, 'P1'), attacked('w1', enemyHero)]
    expect(sectionWindfuryObjective(events)).toBeNull()
  })
})

describe('关3-s5 蓝屏/传家宝：死亡触发亡语召唤', () => {
  const death: GameEvent = died('g1', 'arm-helio-g99', 'P1')
  const legacy: GameEvent = { type: 'MINION_SUMMONED', source: 'effect', unit: unit('m9', 'arm-mali-reference', 'P1') }

  it('正例：死亡后召唤公版亮机卡', () => {
    expect(sectionDeathrattleObjective([death, legacy])).toBe(true)
  })

  it('反例：召唤发生在死亡前', () => {
    expect(sectionDeathrattleObjective([legacy, death])).toBeNull()
  })

  it('反例：source=play 的召唤不算亡语', () => {
    expect(sectionDeathrattleObjective([death, { ...legacy, source: 'play' }])).toBeNull()
  })

  it('反例：死的不是 G99', () => {
    expect(sectionDeathrattleObjective([died('x1', 'amd-rx-550', 'P1'), legacy])).toBeNull()
  })
})

describe('关3-s6 无输出亮机：潜行单位主动现身', () => {
  const base: GameEvent[] = [turnStart(1, 'P1'), played('h1', 'apple-macbook-air-m2'), summoned('m2', 'apple-macbook-air-m2', 'P1', ['stealth'])]

  it('正例：M2 亲自攻击', () => {
    expect(sectionStealthObjective([...base, attacked('m2', { kind: 'unit', instanceId: 'e1' })])).toBe(true)
  })

  it('反例：别的单位攻击不算现身', () => {
    expect(sectionStealthObjective([...base, attacked('other', enemyHero)])).toBeNull()
  })
})

describe('关3-s7 跳闸：打出后下回合开局 BURN_OUT', () => {
  const play: GameEvent = played('h1', 'arm-exynos-8895')
  const burn: GameEvent = { type: 'BURN_OUT', playerId: 'P1', lockedMana: 100 }

  it('正例：出牌后吃到 BURN_OUT', () => {
    expect(sectionOverloadObjective([play, burn])).toBe(true)
  })

  it('反例：没出过 Exynos 的跳闸不算', () => {
    expect(sectionOverloadObjective([burn])).toBeNull()
  })

  it('反例：对面的跳闸不算', () => {
    expect(sectionOverloadObjective([play, { ...burn, playerId: 'P2' }])).toBeNull()
  })
})
