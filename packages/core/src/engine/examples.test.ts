/**
 * M1-ENG6 核心验收 —— 效果原语组合表达 docs/design-report.md §2.5 全部 7 张示例牌
 * （规则书 v1.0 契约下的表达力测试；正式数值/文案由 content 包 M1-CNT 定稿）：
 *
 *   1. 「12VHPWR 熔毁」  destroy chosen allUnits（摧毁一张显卡）
 *   2. 「矿难」          buff all allUnits tag='miner' -2/-2（全场矿卡 -2/-2，
 *                        依赖 M1-ENG6 additive tag 过滤扩展）
 *   3. 「显卡撕裂者」    damage chosen enemyHero（对敌方 CPU 直伤）
 *   4. 「矿卡重生」      revive random（从墓地捞回显卡）
 *   5. 「性价比真香」    revive lastOwnedGpu（复活己方上一张死亡的显卡）
 *   6. 「DLSS 4」        handler double_attack（一张显卡攻击翻倍，帧生成）
 *   7. 「驱动回滚」      removeKeyword chosen enemyUnits（移除敌方显卡关键词）
 *
 * 每张卡：注册为测试卡 → 经 applyAction 实际打出 → 断言结算结果与事件流。
 */

import { describe, expect, it } from 'vitest'
import { MAX_MANA } from '../constants'
import type { CardDefinition } from '../types/cards'
import type { TargetRef } from '../types/actions'
import type { GameState, HandCard } from '../types/state'
import { makeGameState, makePlayer, makeUnit, TEST_SEED } from '../testing/state'
import { applyAction, getLegalActions } from './apply'
import { registerCardDefinitions } from './registry'

// —— §2.5 示例牌（表达力样张：trigger='onPlay' 的 driver 事件牌）——
const EXAMPLE_CARDS: CardDefinition[] = [
  { id: 'ex-12vhpwr', name: '12VHPWR 熔毁', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'destroy', target: { kind: 'chosen', pool: 'allUnits' } }] } },
  { id: 'ex-quake', name: '矿难', faction: 'amd', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'buff', target: { kind: 'all', pool: 'allUnits', tag: 'miner' }, attack: -2, health: -2 }] } },
  { id: 'ex-ripper', name: '显卡撕裂者', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'enemyHero' }, amount: 4 }] } },
  { id: 'ex-rebirth', name: '矿卡重生', faction: 'amd', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'revive', pick: 'random', to: 'sourceOwnerBoard' }] } },
  { id: 'ex-zhenxiang', name: '性价比真香', faction: 'neutral', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'revive', pick: 'lastOwnedGpu', to: 'sourceOwnerBoard' }] } },
  { id: 'ex-dlss4', name: 'DLSS 4', faction: 'nvidia', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'handler', name: 'double_attack' }] } },
  { id: 'ex-rollback', name: '驱动回滚', faction: 'intel', type: 'driver', cost: 100,
    effect: { trigger: 'onPlay', steps: [{ op: 'removeKeyword', target: { kind: 'chosen', pool: 'enemyUnits' }, keyword: 'taunt' }] } },
  // —— 配套测试单位 ——
  { id: 'ex-miner', name: '矿卡', faction: 'amd', type: 'gpu', cost: 100, attack: 3, health: 3, tags: ['miner'] },
  { id: 'ex-vanilla', name: '白板显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 3, health: 3 },
  { id: 'ex-taunt', name: '信仰充值卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 4, keywords: ['taunt'] },
  { id: 'ex-shielded', name: '质保显卡', faction: 'neutral', type: 'gpu', cost: 100, attack: 1, health: 3, keywords: ['divine_shield'] },
  { id: 'ex-rig', name: '信仰灯条', faction: 'neutral', type: 'accessory', cost: 100 },
]
registerCardDefinitions(EXAMPLE_CARDS)

function handCard(uid: string, cardId: string): HandCard {
  return { uid, cardId, cost: 100 }
}

const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })
const heroRef = (playerId: 'P1' | 'P2'): TargetRef => ({ kind: 'hero', playerId })

interface ExampleStateOptions {
  hand?: HandCard[]
  board?: GameState['board']
  graveyard?: GameState['players']['P1']['graveyard']
}

function exampleState(opts: ExampleStateOptions = {}): GameState {
  return makeGameState({
    activePlayer: 'P1',
    players: {
      P1: {
        ...makePlayer('P1'),
        hand: opts.hand ?? [],
        mana: MAX_MANA, // 足够七张示例牌连打（组合确定性测试 700W）
        maxMana: MAX_MANA,
        graveyard: opts.graveyard ?? [],
      },
      P2: { ...makePlayer('P2'), mana: 0, maxMana: 0 },
    },
    board: opts.board ?? [],
  })
}

describe('§2.5 表达力验收：原语组合表达全部 7 张示例牌（M1-ENG6 核心验收）', () => {
  it('1.「12VHPWR 熔毁」= destroy chosen allUnits：摧毁一张显卡，三年质保不抵挡', () => {
    const state = exampleState({
      hand: [handCard('h1', 'ex-12vhpwr')],
      board: [
        makeUnit({ ownerId: 'P2', instanceId: 'u-shield', cardId: 'ex-shielded', keywords: ['divine_shield'] }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-van', cardId: 'ex-vanilla' }),
      ],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-shield') })
    // 质保单位被直接摧毁（不消耗质保、无 shieldConsumed）；另一台不受波及
    expect(result.state.board.map((u) => u.instanceId)).toEqual(['u-van'])
    expect(result.state.players.P2.graveyard).toContainEqual({ instanceId: 'u-shield', cardId: 'ex-shielded' })
    expect(result.events.find((e) => e.type === 'MINION_DIED')).toMatchObject({ cause: 'destroy' })
    expect(result.events.some((e) => e.type === 'DAMAGE_DEALT' && e.shieldConsumed)).toBe(false)
  })

  it('2.「矿难」= buff all allUnits tag=miner：全场矿卡 -2/-2，非矿卡不受波及，矿卡致死走死亡管线', () => {
    const state = exampleState({
      hand: [handCard('h1', 'ex-quake')],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-my-miner', cardId: 'ex-miner', attack: 3, health: 3, maxHealth: 3 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-enemy-miner', cardId: 'ex-miner', attack: 2, health: 2, maxHealth: 2 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-van', cardId: 'ex-vanilla', attack: 3, health: 3, maxHealth: 3 }),
      ],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    // 己方矿卡 3/3 → 1/1；敌方矿卡 2/2 → 0/0 阵亡；白板不受波及
    expect(result.state.board.find((u) => u.instanceId === 'u-my-miner')).toMatchObject({ attack: 1, health: 1 })
    expect(result.state.board.find((u) => u.instanceId === 'u-van')).toMatchObject({ attack: 3, health: 3 })
    expect(result.state.board.find((u) => u.instanceId === 'u-enemy-miner')).toBeUndefined()
    expect(result.state.players.P2.graveyard).toContainEqual({ instanceId: 'u-enemy-miner', cardId: 'ex-miner' })
    expect(result.events.find((e) => e.type === 'MINION_DIED')).toMatchObject({ cause: 'damage' })
  })

  it('3.「显卡撕裂者」= damage chosen enemyHero：对敌方 CPU 直伤并发出 DAMAGE_DEALT', () => {
    const state = exampleState({ hand: [handCard('h1', 'ex-ripper')] })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: heroRef('P2') })
    expect(result.state.players.P2.health).toBe(26) // 30 - 4
    expect(result.events.find((e) => e.type === 'DAMAGE_DEALT')).toMatchObject({
      source: { kind: 'effect', ref: 'ex-ripper' },
      target: { kind: 'hero', playerId: 'P2' },
      amount: 4,
      remainingHealth: 26,
    })
  })

  it('4.「矿卡重生」= revive random：从墓地随机捞回一张显卡（种子 RNG，同 seed 确定性）', () => {
    const build = () =>
      exampleState({
        hand: [handCard('h1', 'ex-rebirth')],
        graveyard: [
          { instanceId: 'g-dead-1', cardId: 'ex-miner' },
          { instanceId: 'g-dead-2', cardId: 'ex-vanilla' },
        ],
      })
    const a = applyAction(build(), { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const b = applyAction(build(), { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    // 恰复活其一：场上 +1 台、墓地 -1 条；随机结果由 seed 唯一决定
    expect(a.state.board).toHaveLength(1)
    expect(a.state.players.P1.graveyard).toHaveLength(1)
    expect(a.state.board[0]?.cardId).toEqual(b.state.board[0]?.cardId)
    expect(a.events).toEqual(b.events)
    expect(a.state.board[0]).toMatchObject({ ownerId: 'P1', summonedOnTurn: 1, attacksRemaining: 0 })
    expect(a.events.find((e) => e.type === 'MINION_SUMMONED')).toMatchObject({ source: 'effect' })
    expect(a.state.rng.state).not.toBe(TEST_SEED >>> 0)
  })

  it('5.「性价比真香」= revive lastOwnedGpu：复活己方上一张死亡的显卡（非显卡条目跳过）', () => {
    const state = exampleState({
      hand: [handCard('h1', 'ex-zhenxiang')],
      graveyard: [
        { instanceId: 'g-first', cardId: 'ex-vanilla' },
        { instanceId: 'g-acc', cardId: 'ex-rig' }, // 配件条目：可入墓但不可复活
        { instanceId: 'g-last', cardId: 'ex-miner' },
      ],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1' })
    const revived = result.state.board[0]
    expect(revived).toMatchObject({ cardId: 'ex-miner', ownerId: 'P1', health: 3, maxHealth: 3 })
    expect(revived?.instanceId).not.toBe('g-last') // 复活为新实例
    // 复活即离墓：最近死亡的显卡被捞走，更早条目与配件条目保留
    expect(result.state.players.P1.graveyard).toEqual([
      { instanceId: 'g-first', cardId: 'ex-vanilla' },
      { instanceId: 'g-acc', cardId: 'ex-rig' },
    ])
  })

  it('6.「DLSS 4」= handler double_attack：一张显卡攻击翻倍（帧生成）；0 攻无事发生', () => {
    const state = exampleState({
      hand: [handCard('h1', 'ex-dlss4')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-me', cardId: 'ex-vanilla', attack: 3, health: 3, maxHealth: 3 })],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-me') })
    expect(result.state.board.find((u) => u.instanceId === 'u-me')).toMatchObject({ attack: 6, health: 3 })
    // 0 攻显卡：翻倍无事发生（buff 原语对 0/0 增益天然 no-op）
    const zeroState = exampleState({
      hand: [handCard('h1', 'ex-dlss4')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-zero', cardId: 'ex-miner', attack: 0, health: 3, maxHealth: 3 })],
    })
    const zeroResult = applyAction(zeroState, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-zero') })
    expect(zeroResult.state.board.find((u) => u.instanceId === 'u-zero')).toMatchObject({ attack: 0 })
  })

  it('7.「驱动回滚」= removeKeyword chosen enemyUnits：移除敌方显卡的 taunt，嘲讽随之失效', () => {
    const state = exampleState({
      hand: [handCard('h1', 'ex-rollback')],
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-taunt', cardId: 'ex-taunt', keywords: ['taunt'] })],
    })
    const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'h1', target: unitRef('u-taunt') })
    expect(result.state.board.find((u) => u.instanceId === 'u-taunt')?.keywords).toEqual([])
    // removeKeyword 无目录事件（§6）：改动经状态可见
    expect(result.events.filter((e) => e.type === 'KEYWORD_TRIGGERED')).toHaveLength(0)
  })

  it('getLegalActions 联动：示例牌按 chosen 池/tag 过滤枚举目标（矿难无 chosen 不展开目标）', () => {
    const state = exampleState({
      hand: [handCard('h1', 'ex-12vhpwr'), handCard('h2', 'ex-quake'), handCard('h3', 'ex-rollback')],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-me', cardId: 'ex-vanilla' }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-enemy', cardId: 'ex-taunt', keywords: ['taunt'] }),
      ],
    })
    const plays = getLegalActions(state, 'P1').filter((a) => a.type === 'PLAY_CARD')
    // 12VHPWR：全场两台均可选；矿难：all+tag 无 chosen → 单个无 target 动作；驱动回滚：仅敌方单位
    const meltTargets = plays.filter((a) => a.type === 'PLAY_CARD' && a.uid === 'h1').map((a) => (a.type === 'PLAY_CARD' ? a.target : null))
    expect(meltTargets).toHaveLength(2)
    const quakePlays = plays.filter((a) => a.type === 'PLAY_CARD' && a.uid === 'h2')
    expect(quakePlays).toHaveLength(1)
    expect(quakePlays[0]).toMatchObject({ type: 'PLAY_CARD', uid: 'h2' })
    // 矿难无 chosen 步骤：不展开目标（target 字段缺席）
    expect((quakePlays[0] as { target?: TargetRef }).target).toBeUndefined()
    const rollbackTargets = plays.filter((a) => a.type === 'PLAY_CARD' && a.uid === 'h3').map((a) => (a.type === 'PLAY_CARD' ? a.target : null))
    expect(rollbackTargets).toEqual([{ kind: 'unit', instanceId: 'u-enemy' }])
  })

  it('确定性：七张示例牌各打一遍的组合动作，两次运行状态逐字节一致', () => {
    const build = () =>
      exampleState({
        hand: [
          handCard('h1', 'ex-12vhpwr'), handCard('h2', 'ex-quake'), handCard('h3', 'ex-ripper'),
          handCard('h4', 'ex-rebirth'), handCard('h5', 'ex-zhenxiang'), handCard('h6', 'ex-dlss4'),
          handCard('h7', 'ex-rollback'),
        ],
        board: [
          makeUnit({ ownerId: 'P1', instanceId: 'u-my-miner', cardId: 'ex-miner', attack: 3, health: 3, maxHealth: 3 }),
          makeUnit({ ownerId: 'P2', instanceId: 'u-shield', cardId: 'ex-shielded', keywords: ['divine_shield'] }),
          makeUnit({ ownerId: 'P2', instanceId: 'u-enemy', cardId: 'ex-taunt', keywords: ['taunt'] }),
        ],
        graveyard: [
          { instanceId: 'g-1', cardId: 'ex-vanilla' },
          { instanceId: 'g-2', cardId: 'ex-miner' },
        ],
      })
    // chosen 目标按各牌语义指定：熔毁→质保敌卡；撕裂者→敌方 CPU；DLSS4→己方矿卡；
    // 驱动回滚→敌方 taunt 卡；矿难/两张复活牌无 chosen
    const targets: Record<string, TargetRef | undefined> = {
      h1: unitRef('u-shield'), h2: undefined, h3: heroRef('P2'),
      h4: undefined, h5: undefined, h6: unitRef('u-my-miner'), h7: unitRef('u-enemy'),
    }
    const run = (): string[] => {
      let state = build()
      const fingerprints: string[] = []
      for (const uid of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7']) {
        const target = targets[uid]
        const result = applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid, ...(target ? { target } : {}) })
        state = result.state
        fingerprints.push(JSON.stringify({
          board: state.board.map((u) => [u.instanceId, u.cardId, u.attack, u.health]),
          grave: state.players.P1.graveyard.length,
          p2: state.players.P2.health,
        }))
      }
      return fingerprints
    }
    expect(run()).toEqual(run())
  })
})
