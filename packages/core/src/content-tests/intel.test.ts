/**
 * M1-CNT intel 批次内容验收 —— packages/content/cards/intel/ 全 15 张卡。
 *
 * 验收口径（批次约束）：
 * - 15 张卡全部通过 findCardDefinitionIssues 结构校验（registry 的 content JSON
 *   运行期闸门，M1-ENG2），并满足批次自检：intel- 前缀、faction=intel、
 *   cost ∈ [100, 1000]、flavor/art/rarity 齐备、至少一张传说；
 * - 每张卡经 createEngine().initGame + applyAction(PLAY_CARD) 实打至少一次并断言
 *   关键事件（事件目录见 docs/rules.md §6）；
 * - 覆盖 3 个非法操作拒绝：INSUFFICIENT_MANA / INVALID_TARGET（潜行）/ NOT_YOUR_TURN。
 *
 * 测试卡组：目标卡 ×30（洗牌后每张入手必得）或「双卡对半 ×15」用于双卡配合场景；
 * P2 用 0 费白板 filler（仅测试注册，不属本批内容）。设计主题：驱动玄学（抽牌/爆牌
 * 风险）、Arc 从驱动地狱到逆袭的成长线、核显亮机卡（无输出亮机潜行）、14nm+++ 顽固身板。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '../types/cards'
import type { TargetRef } from '../types/actions'
import type { GameEvent } from '../types/events'
import type { DeckSpec, GameState, HandCard, PlayerId } from '../types/state'
import { createEngine, RuleError, type EngineResult, type RuleErrorCode } from '../index'
import { findCardDefinitionIssues, getCardDefinition, registerCardDefinitions } from '../engine/registry'

// —— 本批 15 张卡（相对路径 import content JSON，resolveJsonModule）——
import arcA380Json from '../../../content/cards/intel/intel-arc-a380.json'
import uhd770Json from '../../../content/cards/intel/intel-uhd-770.json'
import arcA750Json from '../../../content/cards/intel/intel-arc-a750.json'
import arcB580Json from '../../../content/cards/intel/intel-arc-b580.json'
import arcA770Json from '../../../content/cards/intel/intel-arc-a770-16g.json'
import i99900kJson from '../../../content/cards/intel/intel-i9-9900k.json'
import i914900kJson from '../../../content/cards/intel/intel-i9-14900k.json'
import hotfixJson from '../../../content/cards/intel/intel-driver-hotfix.json'
import betaDriverJson from '../../../content/cards/intel/intel-beta-driver.json'
import av1Json from '../../../content/cards/intel/intel-av1-encode.json'
import xtuJson from '../../../content/cards/intel/intel-xtu-undervolt.json'
import microcodeJson from '../../../content/cards/intel/intel-microcode-0x129.json'
import igpuRescueJson from '../../../content/cards/intel/intel-igpu-rescue.json'
import laminarJson from '../../../content/cards/intel/intel-laminar-cooler.json'
import nucJson from '../../../content/cards/intel/intel-nuc-13-extreme.json'

/** JSON → CardDefinition：编译期不依赖字面量推导，运行期以 registry 结构闸门把关 */
function toCard(raw: unknown): CardDefinition {
  const def = raw as unknown as CardDefinition
  const issue = findCardDefinitionIssues(def)
  if (issue) throw new Error(`content JSON 结构不合法（${def.id ?? '<无 id>'}）：${issue}`)
  return def
}

export const INTEL_CARDS: readonly CardDefinition[] = [
  arcA380Json,
  uhd770Json,
  arcA750Json,
  arcB580Json,
  arcA770Json,
  i99900kJson,
  i914900kJson,
  hotfixJson,
  betaDriverJson,
  av1Json,
  xtuJson,
  microcodeJson,
  igpuRescueJson,
  laminarJson,
  nucJson,
].map(toCard)

/** P2 用的 0 费白板测试卡（仅测试注册，不属本批内容） */
const TEST_FILLER: CardDefinition = {
  id: 'intel-test-filler',
  name: '白板测试卡',
  faction: 'neutral',
  type: 'gpu',
  cost: 0,
  attack: 1,
  health: 1,
}

registerCardDefinitions([...INTEL_CARDS, TEST_FILLER])

// —— 引擎与对局脚手架 ——

const engine = createEngine()
const SEED = 20261003

const deckOf = (cardId: string, count: number): DeckSpec => ({ cards: [{ cardId, count }] })
const pairDeck = (a: string, b: string): DeckSpec => ({
  cards: [
    { cardId: a, count: 15 },
    { cardId: b, count: 15 },
  ],
})
const FILLER_DECK: DeckSpec = deckOf(TEST_FILLER.id, 30)

/** intel 派系 P1（内置技能 driver_update 已随 factions 模块注册）vs 中立 P2 */
function newGame(p1Deck: DeckSpec): GameState {
  return engine.initGame({
    seed: SEED,
    players: [
      { id: 'P1', faction: 'intel', deck: p1Deck },
      { id: 'P2', faction: 'neutral', deck: FILLER_DECK },
    ],
  })
}

const handFind = (s: GameState, pid: PlayerId, cardId: string): HandCard | undefined =>
  s.players[pid].hand.find((c) => c.cardId === cardId)

/** P1→P2 各过一回合（双方都只 END_TURN，不铺场不攻击） */
function passRound(s: GameState): GameState {
  const mid = engine.applyAction(s, { type: 'END_TURN', playerId: s.activePlayer }).state
  return engine.applyAction(mid, { type: 'END_TURN', playerId: mid.activePlayer }).state
}

/** 过回合直到 P1 手中有该卡且功耗足够（卡组含多份副本，确定性必达；预算兜底防死循环） */
function waitHand(s: GameState, cardId: string, maxRounds = 40): GameState {
  for (let i = 0; i < maxRounds; i++) {
    const card = handFind(s, 'P1', cardId)
    if (card && s.players.P1.mana >= (getCardDefinition(cardId)?.cost ?? 0)) return s
    s = passRound(s)
  }
  throw new Error(`waitHand 超出回合预算：P1 一直没等到可打出的 ${cardId}`)
}

function playFromHand(s: GameState, pid: PlayerId, cardId: string, target?: TargetRef): EngineResult {
  const card = handFind(s, pid, cardId)
  if (!card) throw new Error(`测试脚本错误：${pid} 手牌中没有 ${cardId}`)
  return engine.applyAction(s, { type: 'PLAY_CARD', playerId: pid, uid: card.uid, ...(target ? { target } : {}) })
}

function p2PlayFiller(s: GameState): GameState {
  const card = handFind(s, 'P2', TEST_FILLER.id)
  if (!card) throw new Error('测试脚本错误：P2 手牌中没有 filler')
  return engine.applyAction(s, { type: 'PLAY_CARD', playerId: 'P2', uid: card.uid }).state
}

function ofType<E extends GameEvent['type']>(
  events: readonly GameEvent[],
  type: E,
): Extract<GameEvent, { type: E }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: E }> => e.type === type)
}

/** 断言式捕获 RuleError，校验错误码后原样返回（非法操作状态不变由调用方自行复核） */
function expectRuleError(code: RuleErrorCode, fn: () => unknown): RuleError {
  try {
    fn()
  } catch (error) {
    if (error instanceof RuleError) {
      expect(error.code).toBe(code)
      return error
    }
    throw error
  }
  throw new Error(`期望抛出 ${code}，但动作正常执行`)
}

// —— 批次闸门 ——

describe('M1-CNT intel 批次：卡池定义闸门', () => {
  it('15 张卡全部通过 findCardDefinitionIssues，且批次约束成立', () => {
    expect(INTEL_CARDS).toHaveLength(15)
    for (const def of INTEL_CARDS) {
      expect(findCardDefinitionIssues(def)).toBeNull()
      expect(def.id.startsWith('intel-')).toBe(true)
      expect(def.faction).toBe('intel')
      expect(def.cost).toBeGreaterThanOrEqual(100)
      expect(def.cost).toBeLessThanOrEqual(1000)
      expect(def.flavor).toBeTruthy()
      expect(def.rarity).toBeTruthy()
      expect(def.art?.shape).toBeTruthy()
      expect(def.art?.palette).toBeTruthy()
    }
    expect(new Set(INTEL_CARDS.map((c) => c.id)).size).toBe(15)
    expect(INTEL_CARDS.some((c) => c.rarity === 'legendary')).toBe(true)
    // 注册表回读一致：宿主注册流程对本批数据无损
    for (const def of INTEL_CARDS) expect(getCardDefinition(def.id)).toEqual(def)
  })
})

// —— 14nm+++ 的顽固身板 ——

describe('M1-CNT intel 批次：14nm+++ 顽固身板', () => {
  it('i9-9900K：2/6 信仰充值（taunt）入场', () => {
    let s = newGame(deckOf('intel-i9-9900k', 30))
    s = waitHand(s, 'intel-i9-9900k') // 100W：首回合即可
    const { state, events } = playFromHand(s, 'P1', 'intel-i9-9900k')
    expect(ofType(events, 'CARD_PLAYED')[0]).toMatchObject({ playerId: 'P1', cardId: 'intel-i9-9900k', cost: 100 })
    expect(ofType(events, 'MINION_SUMMONED')).toHaveLength(1)
    expect(state.board[0]).toMatchObject({ cardId: 'intel-i9-9900k', attack: 2, health: 6 })
    expect(state.board[0]?.keywords).toContain('taunt')
  })

  it('i9-14900K：五年盒装质保（divine_shield）+ 跳闸 300W（battlecry lockMana → BURN_OUT）', () => {
    let s = newGame(deckOf('intel-i9-14900k', 30))
    s = waitHand(s, 'intel-i9-14900k') // 125W：第 2 回合
    const { state, events } = playFromHand(s, 'P1', 'intel-i9-14900k')
    expect(state.board[0]).toMatchObject({ cardId: 'intel-i9-14900k', attack: 5, health: 6 })
    expect(state.board[0]?.keywords).toContain('divine_shield')
    // 跳闸：battlecry lockMana 300 → lockedMana 累加 + overload 关键词事件
    expect(state.players.P1.lockedMana).toBe(300)
    expect(ofType(events, 'KEYWORD_TRIGGERED').some((e) => e.keyword === 'overload')).toBe(true)
    // P1 的下一回合（供电上限 300W）开始结算跳闸：BURN_OUT + 可用功耗被锁
    s = engine.applyAction(state, { type: 'END_TURN', playerId: 'P1' }).state
    const next = engine.applyAction(s, { type: 'END_TURN', playerId: 'P2' })
    expect(ofType(next.events, 'BURN_OUT')[0]).toMatchObject({ playerId: 'P1', lockedMana: 300 })
    expect(next.state.players.P1.lockedMana).toBe(0)
    expect(next.state.players.P1.maxMana).toBe(300)
    expect(next.state.players.P1.mana).toBe(0) // 300W 上限 − 300W 锁定
  })
})

// —— 驱动玄学：抽牌与爆牌风险 ——

describe('M1-CNT intel 批次：驱动玄学', () => {
  it('Hotfix 热修复：出牌抽 1（CARD_DRAWN，手牌 3−1+1=3）', () => {
    let s = newGame(deckOf('intel-driver-hotfix', 30))
    s = waitHand(s, 'intel-driver-hotfix')
    const { state, events } = playFromHand(s, 'P1', 'intel-driver-hotfix')
    expect(ofType(events, 'CARD_DRAWN')).toHaveLength(1)
    expect(ofType(events, 'CARD_DRAWN')[0]).toMatchObject({ playerId: 'P1', cardId: 'intel-driver-hotfix', source: 'deck' })
    expect(state.players.P1.hand).toHaveLength(3)
  })

  it('BETA 通道驱动：抽 2 + 跳闸锁定 100W（驱动玄学的代价）', () => {
    let s = newGame(deckOf('intel-beta-driver', 30))
    s = waitHand(s, 'intel-beta-driver')
    const { state, events } = playFromHand(s, 'P1', 'intel-beta-driver')
    expect(ofType(events, 'CARD_DRAWN')).toHaveLength(2)
    expect(state.players.P1.hand).toHaveLength(4) // 3 − 1 + 2
    expect(state.players.P1.lockedMana).toBe(100) // lockMana 步骤给出 N，不走默认兜底
    expect(ofType(events, 'KEYWORD_TRIGGERED').some((e) => e.keyword === 'overload')).toBe(true)
    // P1 的下一回合（自身第 2 回合，供电上限 200W）开始结算跳闸：BURN_OUT + 可用功耗被锁
    const mid = engine.applyAction(state, { type: 'END_TURN', playerId: 'P1' }).state
    const t3 = engine.applyAction(mid, { type: 'END_TURN', playerId: 'P2' })
    expect(ofType(t3.events, 'BURN_OUT')[0]).toMatchObject({ playerId: 'P1', lockedMana: 100 })
    expect(t3.state.players.P1.maxMana).toBe(200)
    expect(t3.state.players.P1.mana).toBe(100) // 200W 上限 − 100W 锁定
  })

  it('非法操作：功耗不足（INSUFFICIENT_MANA），状态原样保留', () => {
    const s = newGame(deckOf('intel-arc-a750', 30))
    // 首回合 100W < 225W：出牌闸门拒绝
    expectRuleError('INSUFFICIENT_MANA', () => playFromHand(s, 'P1', 'intel-arc-a750'))
    expect(s.players.P1.mana).toBe(100)
    expect(s.players.P1.hand).toHaveLength(3)
    expect(s.board).toHaveLength(0)
  })
})

// —— Arc 从驱动地狱到逆袭的成长线 ——

describe('M1-CNT intel 批次：Arc 成长线', () => {
  it('Arc A380：100W 白板入场（成长线起点）', () => {
    let s = newGame(deckOf('intel-arc-a380', 30))
    s = waitHand(s, 'intel-arc-a380')
    const { state, events } = playFromHand(s, 'P1', 'intel-arc-a380')
    expect(ofType(events, 'CARD_PLAYED')[0]).toMatchObject({ playerId: 'P1', cardId: 'intel-arc-a380', cost: 100 })
    expect(ofType(events, 'MINION_SUMMONED')[0]).toMatchObject({
      source: 'play',
      unit: { cardId: 'intel-arc-a380', attack: 2, health: 3, maxHealth: 3 },
    })
    expect(state.board).toHaveLength(1)
  })

  it('Arc A750：战吼抽 1（驱动上手即用）', () => {
    let s = newGame(deckOf('intel-arc-a750', 30))
    s = waitHand(s, 'intel-arc-a750') // 225W：第 3 回合
    const handBefore = s.players.P1.hand.length
    const { state, events } = playFromHand(s, 'P1', 'intel-arc-a750')
    expect(ofType(events, 'CARD_DRAWN')).toHaveLength(1)
    expect(ofType(events, 'CARD_DRAWN')[0]).toMatchObject({ playerId: 'P1', cardId: 'intel-arc-a750', source: 'deck' })
    expect(state.players.P1.hand).toHaveLength(handBefore) // −1 出牌 +1 战吼
  })

  it('Arc B580：战吼抽 1 + 自身 +1 攻（3/4 → 4/4）', () => {
    let s = newGame(deckOf('intel-arc-b580', 30))
    s = waitHand(s, 'intel-arc-b580') // 190W：第 2 回合
    const { state, events } = playFromHand(s, 'P1', 'intel-arc-b580')
    expect(ofType(events, 'CARD_DRAWN')).toHaveLength(1)
    expect(state.board[0]).toMatchObject({ cardId: 'intel-arc-b580', attack: 4, health: 4 })
  })

  it('Arc A770 16GB：turnStart 每回合 +1/+1（全场双方回合都触发，逆袭按回合刷）', () => {
    let s = newGame(deckOf('intel-arc-a770-16g', 30))
    s = waitHand(s, 'intel-arc-a770-16g') // 225W：第 3 回合
    s = playFromHand(s, 'P1', 'intel-arc-a770-16g').state
    expect(s.board[0]).toMatchObject({ attack: 2, health: 3 })
    // P2 回合开始：全场 turnStart 触发 → 3/4
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P1' }).state
    expect(s.board[0]).toMatchObject({ attack: 3, health: 4 })
    // P1 回合开始：再次 +1/+1 → 4/5
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P2' }).state
    expect(s.board[0]).toMatchObject({ attack: 4, health: 5 })
  })
})

// —— 核显亮机卡：无输出亮机潜行 ——

describe('M1-CNT intel 批次：核显亮机卡', () => {
  it('UHD Graphics 770：潜行入场，敌方现身前不可被攻击（INVALID_TARGET）', () => {
    let s = newGame(deckOf('intel-uhd-770', 30))
    s = waitHand(s, 'intel-uhd-770')
    s = playFromHand(s, 'P1', 'intel-uhd-770').state
    const uhd = s.board[0]
    expect(uhd).toMatchObject({ cardId: 'intel-uhd-770', attack: 1, health: 1 })
    expect(uhd?.keywords).toContain('stealth')
    // P2 第 1 回合铺白板 → P2 第 2 回合攻击潜行单位：闸门拒绝
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P1' }).state
    s = p2PlayFiller(s)
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P2' }).state
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P1' }).state
    const filler = s.board.find((u) => u.cardId === TEST_FILLER.id)
    expect(filler).toBeTruthy()
    const err = expectRuleError('INVALID_TARGET', () =>
      engine.applyAction(s, {
        type: 'ATTACK',
        playerId: 'P2',
        attackerId: filler!.instanceId,
        target: { kind: 'unit', instanceId: uhd!.instanceId },
      }),
    )
    expect(err.detail).toMatchObject({ reason: 'stealth_hidden' })
    // 无输出亮机仍在场上保持潜行
    expect(s.board.some((u) => u.instanceId === uhd?.instanceId && u.keywords.includes('stealth'))).toBe(true)
  })

  it('核显顶上：召唤一台 UHD Graphics 770（source=effect，自带潜行）', () => {
    let s = newGame(deckOf('intel-igpu-rescue', 30))
    s = waitHand(s, 'intel-igpu-rescue')
    const { state, events } = playFromHand(s, 'P1', 'intel-igpu-rescue')
    expect(ofType(events, 'MINION_SUMMONED')).toHaveLength(1)
    expect(ofType(events, 'MINION_SUMMONED')[0]).toMatchObject({
      source: 'effect',
      unit: { cardId: 'intel-uhd-770', ownerId: 'P1', keywords: ['stealth'] },
    })
    expect(state.board).toHaveLength(1)
  })
})

// —— 驱动事件牌：直伤 / 增益 / 治疗 ——

describe('M1-CNT intel 批次：驱动事件牌', () => {
  it('AV1 硬编码：对敌方单位压 2 点血（致死走死亡管线）', () => {
    let s = newGame(deckOf('intel-av1-encode', 30))
    // P1 第 1 回合无敌方单位，直接过回合
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P1' }).state
    // P2 第 1 回合铺白板
    s = p2PlayFiller(s)
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P2' }).state
    // P1 第 2 回合：AV1 指定白板 → 2 点伤害，1/1 当场去世
    s = waitHand(s, 'intel-av1-encode')
    const filler = s.board.find((u) => u.cardId === TEST_FILLER.id)
    expect(filler).toBeTruthy()
    const { state, events } = playFromHand(s, 'P1', 'intel-av1-encode', {
      kind: 'unit',
      instanceId: filler!.instanceId,
    })
    expect(ofType(events, 'CARD_PLAYED')[0]).toMatchObject({ cardId: 'intel-av1-encode', cost: 100 })
    expect(ofType(events, 'DAMAGE_DEALT')).toHaveLength(1)
    expect(ofType(events, 'DAMAGE_DEALT')[0]).toMatchObject({
      amount: 2,
      remainingHealth: 0,
      source: { kind: 'effect', ref: 'intel-av1-encode' },
      target: { kind: 'unit', instanceId: filler?.instanceId },
    })
    expect(ofType(events, 'MINION_DIED')[0]).toMatchObject({ cause: 'damage' })
    expect(state.board.some((u) => u.instanceId === filler?.instanceId)).toBe(false)
    expect(state.players.P2.graveyard).toContainEqual({ instanceId: filler?.instanceId, cardId: TEST_FILLER.id })
  })

  it('XTU 降压超频：己方显卡 +3 攻 / −1 血（体质差的当场去世不在本例）', () => {
    let s = newGame(pairDeck('intel-arc-a380', 'intel-xtu-undervolt'))
    s = waitHand(s, 'intel-arc-a380')
    s = playFromHand(s, 'P1', 'intel-arc-a380').state
    const a380 = s.board.find((u) => u.cardId === 'intel-arc-a380')
    expect(a380).toBeTruthy()
    s = waitHand(s, 'intel-xtu-undervolt')
    const { state } = playFromHand(s, 'P1', 'intel-xtu-undervolt', {
      kind: 'unit',
      instanceId: a380!.instanceId,
    })
    // 2/3 → 5/2（maxHealth 同步 −1，3→2；未致死）
    expect(state.board.find((u) => u.instanceId === a380?.instanceId)).toMatchObject({
      attack: 5,
      health: 2,
      maxHealth: 2,
    })
  })

  it('0x129 微码补丁：治疗受伤的己方显卡 3 点（HEALING，上限 maxHealth）', () => {
    let s = newGame(pairDeck('intel-arc-a380', 'intel-microcode-0x129'))
    s = waitHand(s, 'intel-arc-a380')
    s = playFromHand(s, 'P1', 'intel-arc-a380').state
    const a380 = s.board.find((u) => u.cardId === 'intel-arc-a380')!
    // P2 第 1 回合铺白板；P1 第 2 回合先攻击（A380 反击掉 1 血）再打补丁
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P1' }).state
    s = p2PlayFiller(s)
    s = engine.applyAction(s, { type: 'END_TURN', playerId: 'P2' }).state
    const filler = s.board.find((u) => u.cardId === TEST_FILLER.id)
    expect(filler).toBeTruthy()
    s = engine.applyAction(s, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: a380.instanceId,
      target: { kind: 'unit', instanceId: filler!.instanceId },
    }).state
    // A380 2 攻击杀死 1/1 白板，吃 1 点反击：3 → 2
    expect(s.board.find((u) => u.instanceId === a380.instanceId)?.health).toBe(2)
    s = waitHand(s, 'intel-microcode-0x129')
    const { state, events } = playFromHand(s, 'P1', 'intel-microcode-0x129', {
      kind: 'unit',
      instanceId: a380.instanceId,
    })
    expect(ofType(events, 'HEALING')).toHaveLength(1)
    expect(ofType(events, 'HEALING')[0]).toMatchObject({
      amount: 3,
      resultingHealth: 3,
      target: { kind: 'unit', instanceId: a380.instanceId },
    })
    expect(state.board.find((u) => u.instanceId === a380.instanceId)?.health).toBe(3)
  })

  it('非法操作：不是你的回合出牌（NOT_YOUR_TURN），状态原样保留', () => {
    const s = newGame(deckOf('intel-arc-a380', 30))
    const p2Card = s.players.P2.hand[0]
    expect(p2Card).toBeTruthy()
    expectRuleError('NOT_YOUR_TURN', () =>
      engine.applyAction(s, { type: 'PLAY_CARD', playerId: 'P2', uid: p2Card!.uid }),
    )
    expect(s.activePlayer).toBe('P1')
    expect(s.players.P2.hand).toHaveLength(3)
    expect(s.board).toHaveLength(0)
  })
})

// —— 配件：Laminar 公版涡轮 / NUC 13 Extreme ——

describe('M1-CNT intel 批次：配件', () => {
  it('Laminar 公版涡轮：光环己方全体 +1 攻（配件 0/1 入场，自身同吃光环但不可攻击）', () => {
    let s = newGame(pairDeck('intel-laminar-cooler', 'intel-arc-a380'))
    s = waitHand(s, 'intel-laminar-cooler')
    s = playFromHand(s, 'P1', 'intel-laminar-cooler').state
    // 0/1 入场 + 光环 attack +1 → 1/1
    expect(s.board.find((u) => u.cardId === 'intel-laminar-cooler')).toMatchObject({ attack: 1, health: 1 })
    s = waitHand(s, 'intel-arc-a380')
    const { state } = playFromHand(s, 'P1', 'intel-arc-a380')
    // A380 2/3 + 光环 → 3/3
    expect(state.board.find((u) => u.cardId === 'intel-arc-a380')).toMatchObject({
      attack: 3,
      health: 3,
      maxHealth: 3,
    })
  })

  it('NUC 13 Extreme：战吼 +3 护甲（ARMOR_GAINED）+ 光环己方全体 +1 血', () => {
    let s = newGame(pairDeck('intel-nuc-13-extreme', 'intel-arc-a380'))
    s = waitHand(s, 'intel-arc-a380')
    s = playFromHand(s, 'P1', 'intel-arc-a380').state
    s = waitHand(s, 'intel-nuc-13-extreme') // 150W：第 2 回合
    const { state, events } = playFromHand(s, 'P1', 'intel-nuc-13-extreme')
    expect(ofType(events, 'ARMOR_GAINED')).toHaveLength(1)
    expect(ofType(events, 'ARMOR_GAINED')[0]).toMatchObject({ playerId: 'P1', amount: 3, totalArmor: 3 })
    expect(state.players.P1.armor).toBe(3)
    // 光环 health +1：A380 2/3 → 2/4；NUC 0/1 → 0/2（配件自身同吃）
    expect(state.board.find((u) => u.cardId === 'intel-arc-a380')).toMatchObject({
      attack: 2,
      health: 4,
      maxHealth: 4,
    })
    expect(state.board.find((u) => u.cardId === 'intel-nuc-13-extreme')).toMatchObject({
      attack: 0,
      health: 2,
      maxHealth: 2,
    })
  })
})
