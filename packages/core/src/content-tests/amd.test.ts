/**
 * M1-CNT 批次「卡牌内容·AMD 矿卡批次」验收 —— packages/content/cards/amd/ 全部 15 张卡。
 *
 * 验收方式（任务约定）：registerCardDefinitions 注册本批 JSON 后，经 createEngine
 * 真实开局（initGame 双方 30 张卡组、amd 派系技能走内置注册），每张卡至少被打出
 * 一次并断言关键事件/状态；另覆盖 3 个非法操作拒绝（INSUFFICIENT_MANA /
 * INVALID_TARGET / NOT_YOUR_TURN）。
 *
 * 卡组构成只用本批卡（内置技能 + 本批注册即可开局，不依赖其他批次数据）。
 * 全程仅 use 公开四函数（initGame / applyAction / getLegalActions / viewFor 的
 * 合法动作枚举），测试读取完整 state 仅为断言——与引擎测试基建（testing/state）
 * 同口径，不构成对架构铁律 3 的违反。
 */

import { describe, expect, it } from 'vitest'
import { createEngine, RuleError } from '../index'
import type { Engine, RuleErrorCode } from '../engine'
import { getCardDefinition, registerCardDefinitions } from '../engine/registry'
import type { CardDefinition } from '../types/cards'
import type { Action, PlayerId, TargetRef } from '../types/actions'
import type { GameEvent } from '../types/events'
import type { BoardUnit, DeckSpec, GameState, HandCard } from '../types/state'

import amdRx550 from '../../../content/cards/amd/amd-rx-550.json'
import amdRx470 from '../../../content/cards/amd/amd-rx-470.json'
import amdRx480 from '../../../content/cards/amd/amd-rx-480.json'
import amdRx580 from '../../../content/cards/amd/amd-rx-580.json'
import amdR9290 from '../../../content/cards/amd/amd-r9-290.json'
import amdRx6400 from '../../../content/cards/amd/amd-rx-6400.json'
import amdRx7900Xtx from '../../../content/cards/amd/amd-rx-7900-xtx.json'
import amdRadeonProDuo from '../../../content/cards/amd/amd-radeon-pro-duo.json'
import amdTheMerge from '../../../content/cards/amd/amd-the-merge.json'
import amdAdrenalin from '../../../content/cards/amd/amd-adrenalin.json'
import amdXianyu from '../../../content/cards/amd/amd-xianyu.json'
import amdAfmf from '../../../content/cards/amd/amd-afmf.json'
import amdChill from '../../../content/cards/amd/amd-chill.json'
import amdRiser from '../../../content/cards/amd/amd-riser.json'
import amdDualBios from '../../../content/cards/amd/amd-dual-bios.json'

/** 本批 15 张卡（JSON 导入按结构收窄为 CardDefinition；结构合法性由 initGame 校验兜底） */
const AMD_CARDS = [
  amdRx550,
  amdRx470,
  amdRx480,
  amdRx580,
  amdR9290,
  amdRx6400,
  amdRx7900Xtx,
  amdRadeonProDuo,
  amdTheMerge,
  amdAdrenalin,
  amdXianyu,
  amdAfmf,
  amdChill,
  amdRiser,
  amdDualBios,
] as unknown as readonly CardDefinition[]

const IDS = AMD_CARDS.map((def) => def.id)
registerCardDefinitions(AMD_CARDS)

/** 固定种子（§11：同 seed + 动作序列可复现；脚本全部走合法动作，无随机分支依赖） */
const SEED = 20261003

// —— 脚手架 ——

type EventType = GameEvent['type']
type EventOf<T extends EventType> = Extract<GameEvent, { type: T }>

function ev<T extends EventType>(log: readonly GameEvent[], type: T): EventOf<T>[] {
  return log.filter((e): e is EventOf<T> => e.type === type)
}

interface Ctx {
  engine: Engine
  state: GameState
  log: GameEvent[]
}

/** 卡组规格（张数闸门：总数必须为 DECK_SIZE=30，写错即测试脚手架 bug） */
function deck30(...entries: Array<readonly [string, number]>): DeckSpec {
  const cards = entries.map(([cardId, count]) => ({ cardId, count }))
  const total = cards.reduce((sum, card) => sum + card.count, 0)
  if (total !== 30) throw new Error(`deck30: 卡组总数必须为 30，实际 ${total}`)
  return { cards }
}

/** 双方 amd 派系（内置技能 ray_tracing_try 随 engine/factions.ts 加载自动注册） */
function newGame(p1Deck: DeckSpec, p2Deck: DeckSpec): Ctx {
  const engine = createEngine()
  const state = engine.initGame({
    seed: SEED,
    players: [
      { id: 'P1', faction: 'amd', heroName: '红队矿主', deck: p1Deck },
      { id: 'P2', faction: 'amd', heroName: '蓝队矿主', deck: p2Deck },
    ],
  })
  return { engine, state, log: [] }
}

function act(ctx: Ctx, action: Action): readonly GameEvent[] {
  const { state, events } = ctx.engine.applyAction(ctx.state, action)
  ctx.state = state
  ctx.log.push(...events)
  return events
}

/** 终局判定（独立函数形态，避免属性收窄跨动作调用漂移） */
function isEnded(state: GameState): boolean {
  return state.phase === 'ended'
}

const heroRef = (playerId: PlayerId): TargetRef => ({ kind: 'hero', playerId })

function handCardOf(state: GameState, playerId: PlayerId, cardId: string): HandCard | undefined {
  return state.players[playerId].hand.find((card) => card.cardId === cardId)
}

function ownUnitOf(state: GameState, playerId: PlayerId, cardId: string): BoardUnit | undefined {
  return state.board.find((unit) => unit.ownerId === playerId && unit.cardId === cardId)
}

/**
 * 对手（P2）脚本：每回合出一张最便宜的可出单位（RX 550），aggro 模式下再用全部
 * 可攻击单位进攻 P1 场上单位（永不打脸，避免测试局提前终局）。
 */
function opponentScript(ctx: Ctx, mode: 'passive' | 'aggro'): void {
  const plays = ctx.engine
    .getLegalActions(ctx.state, 'P2')
    .filter((action): action is Extract<Action, { type: 'PLAY_CARD' }> => action.type === 'PLAY_CARD')
  const cheapest = plays
    .map((action) => ({ action, card: ctx.state.players.P2.hand.find((c) => c.uid === action.uid) }))
    .filter((entry): entry is { action: Extract<Action, { type: 'PLAY_CARD' }>; card: HandCard } => entry.card !== undefined)
    .sort((a, b) => a.card.cost - b.card.cost)[0]
  if (cheapest) act(ctx, cheapest.action)
  if (mode === 'aggro') {
    for (;;) {
      const attack = ctx.engine
        .getLegalActions(ctx.state, 'P2')
        .find((action) => action.type === 'ATTACK' && action.target.kind === 'unit')
      if (!attack) break
      act(ctx, attack)
    }
  }
  act(ctx, { type: 'END_TURN', playerId: 'P2' })
}

/**
 * 等到 cardId 可出（在手牌且功耗足够）即打出；target 由调用方按当前 state 提供。
 * 超过 maxOwnTurns 个己方回合仍未满足 → 脚手架失败（卡组构成/脚本错误信号）。
 */
function playWhenReady(
  ctx: Ctx,
  cardId: string,
  opts: {
    target?: (state: GameState) => TargetRef | undefined
    opponent?: 'passive' | 'aggro'
    maxOwnTurns?: number
  } = {},
): readonly GameEvent[] {
  const maxOwnTurns = opts.maxOwnTurns ?? 12
  for (let i = 0; i < maxOwnTurns; i++) {
    if (isEnded(ctx.state)) {
      throw new Error(`playWhenReady(${cardId}): 对局提前结束，脚本卡组构成有误`)
    }
    const player = ctx.state.activePlayer
    const card = handCardOf(ctx.state, player, cardId)
    if (card && card.cost <= ctx.state.players[player].mana) {
      const target = opts.target?.(ctx.state)
      return act(ctx, { type: 'PLAY_CARD', playerId: player, uid: card.uid, target })
    }
    act(ctx, { type: 'END_TURN', playerId: player })
    if (!isEnded(ctx.state)) opponentScript(ctx, opts.opponent ?? 'passive')
  }
  throw new Error(`playWhenReady(${cardId}): ${maxOwnTurns} 个回合内未满足出牌条件`)
}

/** 推进一个完整轮次（P1 结束回合 → P2 脚本回合 → 回到 P1） */
function advanceRound(ctx: Ctx, mode: 'passive' | 'aggro' = 'passive'): void {
  act(ctx, { type: 'END_TURN', playerId: 'P1' })
  if (!isEnded(ctx.state)) opponentScript(ctx, mode)
}

/** 等待谓词满足（每轮推进一回合）；超限失败 */
function waitFor(ctx: Ctx, predicate: (ctx: Ctx) => boolean, maxRounds = 10, mode: 'passive' | 'aggro' = 'aggro'): void {
  for (let i = 0; i < maxRounds; i++) {
    if (predicate(ctx)) return
    if (isEnded(ctx.state)) break
    advanceRound(ctx, mode)
  }
  throw new Error('waitFor: 谓词在回合上限内未满足')
}

/** 断言动作抛出指定错误码（非法操作拒绝） */
function expectRuleError(run: () => unknown, code: RuleErrorCode): void {
  try {
    run()
    expect.unreachable(`应当抛出 [${code}]`)
  } catch (error) {
    expect(error).toBeInstanceOf(RuleError)
    expect((error as RuleError).code).toBe(code)
  }
}

// —— 批次总闸：15 张定义全部可入组 ——

describe('AMD 矿卡批次 · 批次总闸', () => {
  it('15 张卡定义齐全且全部通过 initGame 结构校验（各 2 张组满 30 张卡组）', () => {
    expect(IDS).toHaveLength(15)
    expect(new Set(IDS).size).toBe(15)
    expect(() =>
      newGame(deck30(...IDS.map((id) => [id, 2] as const)), deck30(...IDS.map((id) => [id, 2] as const))),
    ).not.toThrow()
  })
})

// —— 显卡（gpu）——

describe('AMD 矿卡批次 · 显卡', () => {
  it('RX 550：50W 亮机卡正常入场（2/2）', () => {
    const ctx = newGame(deck30(['amd-rx-550', 30]), deck30(['amd-rx-550', 30]))
    const events = playWhenReady(ctx, 'amd-rx-550')
    const summoned = ev(events, 'MINION_SUMMONED')
    expect(summoned).toHaveLength(1)
    expect(summoned[0]?.source).toBe('play')
    expect(summoned[0]?.unit.cardId).toBe('amd-rx-550')
    expect(summoned[0]?.unit.attack).toBe(2)
    expect(summoned[0]?.unit.health).toBe(2)
    expect(ownUnitOf(ctx.state, 'P1', 'amd-rx-550')).toBeDefined()
  })

  it('RX 470：矿卡阵亡触发传家宝亡语，召唤 RX 550 继位', () => {
    const ctx = newGame(deck30(['amd-rx-470', 15], ['amd-rx-550', 15]), deck30(['amd-rx-550', 30]))
    playWhenReady(ctx, 'amd-rx-470')
    waitFor(ctx, (c) => ev(c.log, 'MINION_SUMMONED').some((s) => s.source === 'effect' && s.unit.cardId === 'amd-rx-550'))
    const died = ev(ctx.log, 'MINION_DIED').filter((e) => e.unit.cardId === 'amd-rx-470' && e.unit.ownerId === 'P1')
    expect(died).toHaveLength(1)
    const deadId = died[0]?.unit.instanceId
    // 亡语事件序：MINION_DIED → KEYWORD_TRIGGERED(deathrattle) → MINION_SUMMONED(effect)
    const deathIndex = ctx.log.findIndex((e) => e.type === 'MINION_DIED' && e.unit.instanceId === deadId)
    const drIndex = ctx.log.findIndex(
      (e) => e.type === 'KEYWORD_TRIGGERED' && e.keyword === 'deathrattle' && e.instanceId === deadId,
    )
    const summonIndex = ctx.log.findIndex(
      (e) => e.type === 'MINION_SUMMONED' && e.source === 'effect' && e.unit.cardId === 'amd-rx-550',
    )
    expect(drIndex).toBeGreaterThan(deathIndex)
    expect(summonIndex).toBeGreaterThan(drIndex)
    // 新 550 归 P1 所有，阵亡矿卡入墓
    const revived = ownUnitOf(ctx.state, 'P1', 'amd-rx-550')
    expect(revived).toBeDefined()
    expect(ctx.state.players.P1.graveyard.some((entry) => entry.cardId === 'amd-rx-470')).toBe(true)
  })

  it('RX 480：矿卡信仰充值（taunt）3/4 入场', () => {
    const ctx = newGame(deck30(['amd-rx-480', 15], ['amd-rx-550', 15]), deck30(['amd-rx-550', 30]))
    const events = playWhenReady(ctx, 'amd-rx-480')
    expect(ev(events, 'MINION_SUMMONED')).toHaveLength(1)
    const unit = ownUnitOf(ctx.state, 'P1', 'amd-rx-480')
    expect(unit?.attack).toBe(3)
    expect(unit?.health).toBe(4)
    expect(unit?.keywords).toContain('taunt')
  })

  it('RX 580：敌方 RX 580 被「以太坊合并」带走时亡语召唤两只 RX 550', () => {
    const ctx = newGame(
      deck30(['amd-the-merge', 12], ['amd-rx-550', 18]),
      deck30(['amd-rx-580', 30]),
    )
    // 先推两轮让 P2 在 T2 上一只 RX 580（185W），再等 P1 打出合并
    advanceRound(ctx)
    advanceRound(ctx)
    const events = playWhenReady(ctx, 'amd-the-merge')
    // 合并只烧对面矿卡：P2 场上的 RX 580（3/2 → 1/-1）阵亡
    const died = ev(events, 'MINION_DIED').filter((e) => e.unit.cardId === 'amd-rx-580' && e.unit.ownerId === 'P2')
    expect(died).toHaveLength(1)
    const deadId = died[0]?.unit.instanceId
    expect(ev(events, 'KEYWORD_TRIGGERED').some((e) => e.keyword === 'deathrattle' && e.instanceId === deadId)).toBe(true)
    // 亡语召唤两只 RX 550（归 P2 所有）；P1 没有单位被波及
    const inherited = ev(events, 'MINION_SUMMONED').filter((e) => e.source === 'effect' && e.unit.cardId === 'amd-rx-550')
    expect(inherited).toHaveLength(2)
    for (const summon of inherited) expect(summon.unit.ownerId).toBe('P2')
    expect(ctx.state.players.P2.graveyard.some((entry) => entry.cardId === 'amd-rx-580')).toBe(true)
    expect(ctx.state.players.P1.graveyard).toHaveLength(0)
  })

  it('R9 290：战吼指定直伤 2 + 跳闸锁定下回合 100W（BURN_OUT）', () => {
    const ctx = newGame(deck30(['amd-r9-290', 15], ['amd-rx-550', 15]), deck30(['amd-rx-550', 30]))
    const events = playWhenReady(ctx, 'amd-r9-290', { target: () => heroRef('P2') })
    const dealt = ev(events, 'DAMAGE_DEALT').filter((e) => e.target.kind === 'hero' && e.target.playerId === 'P2')
    expect(dealt).toHaveLength(1)
    expect(dealt[0]?.amount).toBe(2)
    expect(ctx.state.players.P2.health).toBe(28)
    expect(ev(events, 'KEYWORD_TRIGGERED').some((e) => e.keyword === 'overload')).toBe(true)
    // 下一回合开始：跳闸结算（BURN_OUT 100W），可用功耗 = 供电上限 - 100
    advanceRound(ctx)
    const burnOut = ev(ctx.log, 'BURN_OUT').find((e) => e.playerId === 'P1')
    expect(burnOut?.lockedMana).toBe(100)
    expect(ctx.state.players.P1.lockedMana).toBe(0)
    expect(ctx.state.players.P1.mana).toBe(ctx.state.players.P1.maxMana - 100)
  })

  it('RX 6400：无输出亮机（stealth）入场', () => {
    const ctx = newGame(deck30(['amd-rx-6400', 30]), deck30(['amd-rx-550', 30]))
    const events = playWhenReady(ctx, 'amd-rx-6400')
    expect(ev(events, 'MINION_SUMMONED')).toHaveLength(1)
    const unit = ownUnitOf(ctx.state, 'P1', 'amd-rx-6400')
    expect(unit?.keywords).toContain('stealth')
    expect(unit?.attack).toBe(2)
    expect(unit?.health).toBe(2)
  })

  it('RX 7900 XTX：战吼对敌方 CPU 直伤 3', () => {
    const ctx = newGame(deck30(['amd-rx-7900-xtx', 30]), deck30(['amd-rx-550', 30]))
    const events = playWhenReady(ctx, 'amd-rx-7900-xtx', { target: () => heroRef('P2') })
    const dealt = ev(events, 'DAMAGE_DEALT').filter((e) => e.target.kind === 'hero' && e.target.playerId === 'P2')
    expect(dealt).toHaveLength(1)
    expect(dealt[0]?.amount).toBe(3)
    expect(ctx.state.players.P2.health).toBe(27)
    expect(ownUnitOf(ctx.state, 'P1', 'amd-rx-7900-xtx')).toBeDefined()
  })

  it('Radeon Pro Duo：传说双芯，windfury 一回合两次攻击', () => {
    const ctx = newGame(deck30(['amd-radeon-pro-duo', 15], ['amd-rx-550', 15]), deck30(['amd-rx-550', 30]))
    playWhenReady(ctx, 'amd-radeon-pro-duo')
    const duo = ownUnitOf(ctx.state, 'P1', 'amd-radeon-pro-duo')
    expect(duo?.keywords).toContain('windfury')
    advanceRound(ctx) // 入场当回合召唤失调，次回合风怒预算 = 2
    let attacks = 0
    for (;;) {
      const attack = ctx.engine.getLegalActions(ctx.state, 'P1').find(
        (action): action is Extract<Action, { type: 'ATTACK' }> =>
          action.type === 'ATTACK' &&
          action.target.kind === 'hero' &&
          ownUnitOf(ctx.state, 'P1', 'amd-radeon-pro-duo')?.instanceId === action.attackerId,
      )
      if (!attack) break
      act(ctx, attack)
      attacks++
    }
    expect(attacks).toBe(2)
    expect(ctx.state.players.P2.health).toBe(20)
  })
})

// —— 驱动（driver）——

describe('AMD 矿卡批次 · 驱动', () => {
  it('以太坊合并：敌方矿卡 -2/-3（tag 过滤、只烧对面），己方矿卡与无 tag 的 RX 550 幸存', () => {
    const ctx = newGame(
      deck30(['amd-the-merge', 12], ['amd-rx-470', 10], ['amd-rx-550', 8]),
      deck30(['amd-rx-470', 30]),
    )
    playWhenReady(ctx, 'amd-rx-550')
    playWhenReady(ctx, 'amd-rx-470')
    const own470Before = ownUnitOf(ctx.state, 'P1', 'amd-rx-470')
    const survivorBefore = ownUnitOf(ctx.state, 'P1', 'amd-rx-550')
    expect(survivorBefore).toBeDefined()
    const events = playWhenReady(ctx, 'amd-the-merge')
    // 敌方矿卡（P2 场上的 RX 470）-2/-3 阵亡并触发亡语（召唤归 P2）
    const died = ev(events, 'MINION_DIED').filter((e) => e.unit.ownerId === 'P2')
    expect(died.length).toBeGreaterThan(0)
    for (const entry of died) {
      expect(entry.unit.cardId).toBe('amd-rx-470')
      expect(
        ev(events, 'KEYWORD_TRIGGERED').some(
          (e) => e.keyword === 'deathrattle' && e.instanceId === entry.unit.instanceId,
        ),
      ).toBe(true)
    }
    expect(
      ev(events, 'MINION_SUMMONED').some(
        (e) => e.source === 'effect' && e.unit.ownerId === 'P2' && e.unit.cardId === 'amd-rx-550',
      ),
    ).toBe(true)
    // 己方 RX 470（同样带 miner tag）不受「只烧对面」的合并波及
    const own470 = ownUnitOf(ctx.state, 'P1', 'amd-rx-470')
    expect(own470?.instanceId).toBe(own470Before?.instanceId)
    expect(own470?.attack).toBe(2)
    expect(own470?.health).toBe(3)
    // 无 miner tag 的 RX 550 不受矿难波及
    const survivor = ownUnitOf(ctx.state, 'P1', 'amd-rx-550')
    expect(survivor?.instanceId).toBe(survivorBefore?.instanceId)
    expect(survivor?.health).toBe(2)
    expect(survivor?.attack).toBe(2)
  })

  it('Adrenalin 战未来：指定己方显卡攻击翻倍（2/3 → 4/3）', () => {
    const ctx = newGame(
      deck30(['amd-adrenalin', 12], ['amd-rx-470', 10], ['amd-rx-550', 8]),
      deck30(['amd-rx-550', 30]),
    )
    playWhenReady(ctx, 'amd-rx-470')
    const target = ownUnitOf(ctx.state, 'P1', 'amd-rx-470')
    expect(target).toBeDefined()
    playWhenReady(ctx, 'amd-adrenalin', { target: () => ({ kind: 'unit', instanceId: target?.instanceId ?? '' }) })
    const buffed = ownUnitOf(ctx.state, 'P1', 'amd-rx-470')
    expect(buffed?.attack).toBe(4)
    expect(buffed?.health).toBe(3)
    expect(ev(ctx.log, 'CARD_PLAYED').some((e) => e.cardId === 'amd-adrenalin')).toBe(true)
  })

  it('闲鱼捡漏：从墓地捞回最近阵亡的显卡（复活为新实例、离墓）', () => {
    const ctx = newGame(deck30(['amd-xianyu', 12], ['amd-rx-550', 18]), deck30(['amd-rx-550', 30]))
    playWhenReady(ctx, 'amd-rx-550')
    waitFor(ctx, (c) => c.state.players.P1.graveyard.length > 0)
    const died = ev(ctx.log, 'MINION_DIED').filter((e) => e.unit.ownerId === 'P1' && e.unit.cardId === 'amd-rx-550')
    expect(died.length).toBeGreaterThan(0)
    const deadId = died[0]?.unit.instanceId
    const events = playWhenReady(ctx, 'amd-xianyu')
    const revived = ev(events, 'MINION_SUMMONED')
    expect(revived).toHaveLength(1)
    expect(revived[0]?.source).toBe('effect')
    expect(revived[0]?.unit.cardId).toBe('amd-rx-550')
    expect(revived[0]?.unit.instanceId).not.toBe(deadId) // 复活 ≠ 原实例
    expect(ctx.state.players.P1.graveyard).toHaveLength(0) // 复活即离墓
  })

  it('AFMF 流体补帧：抽 2 张牌', () => {
    const ctx = newGame(deck30(['amd-afmf', 15], ['amd-rx-550', 15]), deck30(['amd-rx-550', 30]))
    let handSizeAtPlay = -1
    const events = playWhenReady(ctx, 'amd-afmf', {
      // 无 chosen 步骤的牌 target 会被宽容忽略（play.ts）——借回调在出牌瞬间捕获手牌数
      target: (state) => {
        handSizeAtPlay = state.players.P1.hand.length
        return undefined
      },
    })
    const drawn = ev(events, 'CARD_DRAWN').filter((e) => e.playerId === 'P1' && e.source === 'deck')
    expect(drawn).toHaveLength(2)
    expect(handSizeAtPlay).toBeGreaterThan(0)
    // 手牌净变化 = −1（AFMF 自身离手）+ 2（补帧抽牌）
    expect(ctx.state.players.P1.hand.length).toBe(handSizeAtPlay + 1)
  })

  it('Radeon Chill：先自烧 2 点（R9 290 指向自家 CPU）再治疗回满', () => {
    const ctx = newGame(deck30(['amd-chill', 12], ['amd-r9-290', 10], ['amd-rx-550', 8]), deck30(['amd-rx-550', 30]))
    playWhenReady(ctx, 'amd-r9-290', { target: () => heroRef('P1') })
    expect(ctx.state.players.P1.health).toBe(28)
    playWhenReady(ctx, 'amd-chill', { target: () => heroRef('P1') })
    const healed = ev(ctx.log, 'HEALING').filter((e) => e.target.kind === 'hero' && e.target.playerId === 'P1')
    expect(healed.length).toBeGreaterThan(0)
    expect(healed.at(-1)?.amount).toBe(6)
    expect(healed.at(-1)?.resultingHealth).toBe(30)
    expect(ctx.state.players.P1.health).toBe(30)
  })
})

// —— 配件（accessory）——

describe('AMD 矿卡批次 · 配件', () => {
  it('PCIe Riser：0/1 入场，己方显卡攻击光环 +1', () => {
    const ctx = newGame(deck30(['amd-riser', 12], ['amd-rx-470', 10], ['amd-rx-550', 8]), deck30(['amd-rx-550', 30]))
    playWhenReady(ctx, 'amd-rx-470')
    const events = playWhenReady(ctx, 'amd-riser')
    expect(ev(events, 'MINION_SUMMONED')).toHaveLength(1)
    const riser = ownUnitOf(ctx.state, 'P1', 'amd-riser')
    expect(riser?.attack).toBe(1) // 配件 0 攻 + 光环 1
    expect(riser?.health).toBe(1)
    const miner = ownUnitOf(ctx.state, 'P1', 'amd-rx-470')
    expect(miner?.attack).toBe(3) // 2 基础 + 1 光环
    expect(miner?.health).toBe(3)
  })

  it('双 BIOS 静音开关：己方手牌功耗 -100W（scope 限源拥有者，对手不受影响）', () => {
    const ctx = newGame(
      deck30(['amd-dual-bios', 12], ['amd-rx-580', 10], ['amd-rx-550', 8]),
      deck30(['amd-rx-550', 30]),
    )
    playWhenReady(ctx, 'amd-dual-bios')
    const discounted = (playerId: PlayerId): boolean =>
      ctx.state.players[playerId].hand.every((card) => {
        const defCost = getCardDefinition(card.cardId)?.cost ?? 0
        return card.cost === Math.max(0, defCost - (playerId === 'P1' ? 100 : 0))
      })
    expect(discounted('P1')).toBe(true)
    expect(discounted('P2')).toBe(true) // P2 全部 50W 原价
    expect(ev(ctx.log, 'MINION_SUMMONED').some((e) => e.unit.cardId === 'amd-dual-bios')).toBe(true)
  })
})

// —— 非法操作拒绝（§3 错误码） ——

describe('AMD 矿卡批次 · 非法操作拒绝', () => {
  it('功耗不足出 RX 7900 XTX → INSUFFICIENT_MANA，且状态不被改动', () => {
    const ctx = newGame(deck30(['amd-rx-7900-xtx', 30]), deck30(['amd-rx-550', 30]))
    const uid = ctx.state.players.P1.hand[0]?.uid
    expect(uid).toBeDefined()
    if (!uid) return
    const before = ctx.state
    expectRuleError(() => act(ctx, { type: 'PLAY_CARD', playerId: 'P1', uid }), 'INSUFFICIENT_MANA')
    expect(ctx.state).toBe(before) // applyAction 抛错时原状态原样返回
    expect(ctx.log).toHaveLength(0)
  })

  it('RX 7900 XTX 指定己方 CPU（pool=enemyHero）→ INVALID_TARGET', () => {
    const ctx = newGame(deck30(['amd-rx-7900-xtx', 30]), deck30(['amd-rx-550', 30]))
    // 推进 3 轮到 P1 第 4 回合（400W ≥ 355W），排除功耗因素的干扰
    advanceRound(ctx)
    advanceRound(ctx)
    advanceRound(ctx)
    const card = handCardOf(ctx.state, 'P1', 'amd-rx-7900-xtx')
    expect(card).toBeDefined()
    if (!card) return
    expectRuleError(
      () => act(ctx, { type: 'PLAY_CARD', playerId: 'P1', uid: card.uid, target: heroRef('P1') }),
      'INVALID_TARGET',
    )
  })

  it('对手回合出牌 → NOT_YOUR_TURN', () => {
    const ctx = newGame(deck30(['amd-rx-550', 30]), deck30(['amd-rx-550', 30]))
    act(ctx, { type: 'END_TURN', playerId: 'P1' })
    expect(ctx.state.activePlayer).toBe('P2')
    const uid = ctx.state.players.P1.hand[0]?.uid
    expect(uid).toBeDefined()
    if (!uid) return
    expectRuleError(() => act(ctx, { type: 'PLAY_CARD', playerId: 'P1', uid }), 'NOT_YOUR_TURN')
  })
})
