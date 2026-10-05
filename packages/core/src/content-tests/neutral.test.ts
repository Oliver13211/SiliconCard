/**
 * M1-CNT 卡池批次「卡牌内容·中立硬件批次」内容验收测试（neutral-*，恰好 15 张）。
 *
 * 数据源：packages/content/cards/neutral/*.json（相对路径 JSON import，resolveJsonModule），
 * 效果全部为声明式 EffectSpec 原语组合（§5），不含任何命名 handler。
 *
 * 验收口径（对应派发要求）：
 *  1. schema 闸门：15 张定义逐一通过引擎 findCardDefinitionIssues，id/cost/稀有度合规；
 *  2. 逐卡实打：每张卡经 createEngine().applyAction 至少打出一次并断言关键事件；
 *  3. 派系配合面：B650M 攻击光环 × nvidia DLSS 加法叠加（§5 光环与 buff 叠加）；
 *  4. 全局对局：initGame 真实卡组（30 张）贪心驱动，三张 driver 全部打出，
 *     GX-850 跳闸（overload）在下回合结算 BURN_OUT；双跑事件流与状态哈希逐字节一致（§11）；
 *  5. 非法操作拒绝 ×3：INSUFFICIENT_MANA / INVALID_TARGET / TAUNT_BLOCKING（§3）。
 */

import { describe, expect, it } from 'vitest'
import { createEngine, MAX_MANA, RuleError, stableHash } from '../index'
import type { Action, TargetRef } from '../types/actions'
import type { CardDefinition } from '../types/cards'
import type { GameEvent } from '../types/events'
import type {
  BoardUnit,
  DeckEntry,
  DeckSpec,
  GameState,
  HandCard,
  PlayerId,
} from '../types/state'
import { findCardDefinitionIssues, registerCardDefinitions } from '../engine/registry'
import {
  catchRuleError,
  makeDeckSpec,
  makeGameState,
  makePlayer,
  makeUnit,
} from '../testing/state'

// —— 本批 15 张卡（packages/content/cards/neutral/，相对路径 JSON 导入）——
import gt1030Json from '../../../content/cards/neutral/neutral-gt-1030.json'
import p106Json from '../../../content/cards/neutral/neutral-p106-100.json'
import furmarkJson from '../../../content/cards/neutral/neutral-furmark.json'
import n990ProJson from '../../../content/cards/neutral/neutral-990-pro.json'
import barracudaJson from '../../../content/cards/neutral/neutral-barracuda-2tb.json'
import tridentJson from '../../../content/cards/neutral/neutral-trident-z5-ddr5.json'
import nhD15Json from '../../../content/cards/neutral/neutral-nh-d15.json'
import h150iJson from '../../../content/cards/neutral/neutral-h150i-lcd.json'
import x870eJson from '../../../content/cards/neutral/neutral-x870e-hero.json'
import b650mJson from '../../../content/cards/neutral/neutral-b650m-plus.json'
import gx850Json from '../../../content/cards/neutral/neutral-focus-gx-850.json'
import thorJson from '../../../content/cards/neutral/neutral-rog-thor-1600t.json'
import dxracerJson from '../../../content/cards/neutral/neutral-dxracer-king.json'
import cherryJson from '../../../content/cards/neutral/neutral-cherry-mx-8-0.json'
import g502Json from '../../../content/cards/neutral/neutral-g502-hero.json'

/** JSON → CardDefinition：先过引擎 schema 闸门，定义不合法直接让测试响亮失败 */
function loadCard(json: unknown, file: string): CardDefinition {
  const def = json as CardDefinition
  const issue = findCardDefinitionIssues(def)
  if (issue) throw new Error(`卡牌定义不合法（content/cards/neutral/${file}）：${issue}`)
  return def
}

const NEUTRAL_CARDS: CardDefinition[] = [
  loadCard(gt1030Json, 'neutral-gt-1030.json'),
  loadCard(p106Json, 'neutral-p106-100.json'),
  loadCard(furmarkJson, 'neutral-furmark.json'),
  loadCard(n990ProJson, 'neutral-990-pro.json'),
  loadCard(barracudaJson, 'neutral-barracuda-2tb.json'),
  loadCard(tridentJson, 'neutral-trident-z5-ddr5.json'),
  loadCard(nhD15Json, 'neutral-nh-d15.json'),
  loadCard(h150iJson, 'neutral-h150i-lcd.json'),
  loadCard(x870eJson, 'neutral-x870e-hero.json'),
  loadCard(b650mJson, 'neutral-b650m-plus.json'),
  loadCard(gx850Json, 'neutral-focus-gx-850.json'),
  loadCard(thorJson, 'neutral-rog-thor-1600t.json'),
  loadCard(dxracerJson, 'neutral-dxracer-king.json'),
  loadCard(cherryJson, 'neutral-cherry-mx-8-0.json'),
  loadCard(g502Json, 'neutral-g502-hero.json'),
]
registerCardDefinitions(NEUTRAL_CARDS)

const CARD_BY_ID = new Map(NEUTRAL_CARDS.map((def) => [def.id, def]))
const costOf = (cardId: string): number => CARD_BY_ID.get(cardId)?.cost ?? 0

const engine = createEngine()

// —— 测试装配工具（沿用 core 内部测试惯例：直接构造 GameState，再经引擎四函数实打）——

const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })

const isPlayCard = (action: Action): action is Extract<Action, { type: 'PLAY_CARD' }> =>
  action.type === 'PLAY_CARD'

/** 事件流按类型窄化抽取（保留目录事件的确切 payload 类型） */
function ofType<T extends GameEvent['type']>(
  events: readonly GameEvent[],
  type: T,
): Extract<GameEvent, { type: T }>[] {
  return events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type)
}

interface CraftedOptions {
  hand?: HandCard[]
  handP2?: HandCard[]
  board?: BoardUnit[]
  deckP1?: readonly DeckEntry[]
  mana?: number
  activePlayer?: PlayerId
  factionP1?: string
  turn?: number
}

function craftedState(opts: CraftedOptions = {}): GameState {
  return makeGameState({
    turn: opts.turn ?? 1,
    activePlayer: opts.activePlayer ?? 'P1',
    players: {
      P1: {
        ...makePlayer('P1', { faction: opts.factionP1 ?? 'neutral' }),
        mana: opts.mana ?? MAX_MANA,
        maxMana: MAX_MANA,
        hand: opts.hand ?? [],
        deck: opts.deckP1 ?? [],
      },
      P2: { ...makePlayer('P2'), mana: 0, maxMana: 0, hand: opts.handP2 ?? [] },
    },
    board: opts.board ?? [],
  })
}

function handCard(cardId: string, uid = `h-${cardId}`): HandCard {
  return { uid, cardId, cost: costOf(cardId) }
}

/** 以 P1 名义打出指定 cardId 的手牌（测试装配错误时响亮失败，不静默跳过） */
function playP1(state: GameState, cardId: string, target?: TargetRef) {
  const card = state.players.P1.hand.find((c) => c.cardId === cardId)
  if (!card) throw new Error(`测试装配错误：P1 手牌中没有 ${cardId}`)
  return engine.applyAction(state, {
    type: 'PLAY_CARD',
    playerId: 'P1',
    uid: card.uid,
    ...(target ? { target } : {}),
  })
}

/**
 * 推进一整个回合（P1 结束 → P2 结束 → 回到 P1），P2 全程只挂机。
 * 返回回到 P1 手上时的状态，以及这两次 END_TURN 产生的全部事件
 * （BURN_OUT 发生在 P2 的 END_TURN 内部的 beginTurn(P1) 中）。
 */
function advanceToNextP1Turn(state: GameState): { state: GameState; events: GameEvent[] } {
  const p1End = engine.applyAction(state, { type: 'END_TURN', playerId: 'P1' })
  const p2End = engine.applyAction(p1End.state, { type: 'END_TURN', playerId: 'P2' })
  return { state: p2End.state, events: [...p1End.events, ...p2End.events] }
}

// —— 1. schema 与批次约束 ——

describe('neutral 批次 schema 闸门（15 张）', () => {
  it('15 张定义全部通过 findCardDefinitionIssues，批次约束（前缀/派系/功耗区间/唯一性/稀有度梯度）成立', () => {
    expect(NEUTRAL_CARDS).toHaveLength(15)
    for (const def of NEUTRAL_CARDS) {
      expect(findCardDefinitionIssues(def)).toBeNull()
      expect(def.id.startsWith('neutral-')).toBe(true)
      expect(def.faction).toBe('neutral')
      expect(def.cost).toBeGreaterThanOrEqual(50)
      expect(def.cost).toBeLessThanOrEqual(1000)
    }
    expect(new Set(NEUTRAL_CARDS.map((d) => d.id)).size).toBe(15)
    const rarities = new Set(NEUTRAL_CARDS.map((d) => d.rarity))
    expect(rarities.has('legendary')).toBe(true) // 每批至少一张传说
    expect(rarities.size).toBeGreaterThanOrEqual(3) // 稀有度有梯度
    // gpu 必须带身板；driver/accessory 必须不带（§4 schema 违例即闸门拒绝，双保险断言）
    for (const def of NEUTRAL_CARDS) {
      if (def.type === 'gpu') {
        expect(def.attack).toBeDefined()
        expect(def.health).toBeDefined()
      } else {
        expect(def.attack).toBeUndefined()
        expect(def.health).toBeUndefined()
      }
    }
  })
})

// —— 2. 逐卡实打（每张卡至少被打出一次，断言关键事件）——

describe('neutral 批次逐卡实打（createEngine 实战路径）', () => {
  it('GT 1030：入场即潜行（无输出亮机），2/3 白板入场', () => {
    const result = playP1(craftedState({ hand: [handCard('neutral-gt-1030')] }), 'neutral-gt-1030')
    expect(ofType(result.events, 'CARD_PLAYED')).toHaveLength(1)
    const summoned = result.events.find((e) => e.type === 'MINION_SUMMONED')
    expect(summoned).toMatchObject({
      source: 'play',
      unit: { cardId: 'neutral-gt-1030', ownerId: 'P1', attack: 2, health: 3, keywords: ['stealth'] },
    })
    expect(result.state.board).toHaveLength(1)
  })

  it('P106-100：矿卡战死触发亡语抽 1（蓝屏/传家宝），矿区遗产落袋', () => {
    const state = craftedState({
      hand: [handCard('neutral-p106-100')],
      deckP1: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-enemy', attack: 3, health: 4, maxHealth: 4 })],
    })
    const played = playP1(state, 'neutral-p106-100')
    const p106 = played.state.board.find((u) => u.cardId === 'neutral-p106-100')
    expect(p106).toBeDefined()
    // 跨一回合消除召唤失调，再对撞：P106 3/3 撞 3/4，矿卡阵亡触发亡语
    const nextTurn = advanceToNextP1Turn(played.state)
    const combat = engine.applyAction(nextTurn.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: p106!.instanceId,
      target: unitRef('u-enemy'),
    })
    expect(combat.state.board.find((u) => u.cardId === 'neutral-p106-100')).toBeUndefined()
    expect(combat.state.players.P1.graveyard).toContainEqual({
      instanceId: p106!.instanceId,
      cardId: 'neutral-p106-100',
    })
    expect(combat.events.find((e) => e.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'deathrattle',
    })
    // 亡语抽 1：turn-start 抽 1（上一段 applyAction）+ 亡语抽 1（战斗 applyAction），均来自牌库
    const draws = [...ofType(nextTurn.events, 'CARD_DRAWN'), ...ofType(combat.events, 'CARD_DRAWN')].filter(
      (e) => e.playerId === 'P1',
    )
    expect(draws).toHaveLength(2)
    expect(draws.every((e) => e.source === 'deck')).toBe(true)
  })

  it('FurMark 烤机：对面显卡全体掉 1 血（甜甜圈只烤对面），1 血单位直接烤死', () => {
    const state = craftedState({
      hand: [handCard('neutral-furmark')],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-mine', attack: 1, health: 1, maxHealth: 1 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-theirs', attack: 1, health: 1, maxHealth: 1 }),
      ],
    })
    const result = playP1(state, 'neutral-furmark')
    const damages = ofType(result.events, 'DAMAGE_DEALT')
    expect(damages).toHaveLength(1)
    expect(damages[0]).toMatchObject({
      amount: 1,
      source: { kind: 'effect', ref: 'neutral-furmark' },
      target: { kind: 'unit', instanceId: 'u-theirs' },
    })
    expect(result.state.board).toHaveLength(1) // 己方 1 血单位不被自家烤机波及
    expect(result.state.board[0]?.instanceId).toBe('u-mine')
    expect(ofType(result.events, 'MINION_DIED')).toHaveLength(1)
  })

  it('990 PRO：出牌即检索 2 张（7450MB/s 顺序读）', () => {
    const state = craftedState({
      hand: [handCard('neutral-990-pro')],
      deckP1: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
    })
    const result = playP1(state, 'neutral-990-pro')
    const draws = ofType(result.events, 'CARD_DRAWN').filter((e) => e.playerId === 'P1')
    expect(draws).toHaveLength(2)
    expect(draws.every((e) => e.source === 'deck')).toBe(true)
    expect(result.state.players.P1.hand).toHaveLength(2)
  })

  it('Barracuda 2TB：抽 1 但 SMR 卡顿——下回合锁定 50W，BURN_OUT 如约而至', () => {
    const state = craftedState({
      hand: [handCard('neutral-barracuda-2tb')],
      deckP1: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
      mana: 100,
    })
    const result = playP1(state, 'neutral-barracuda-2tb')
    expect(result.state.players.P1.mana).toBe(50) // 100 − 50（SMR 盘低价，但卡顿照旧）
    expect(result.state.players.P1.lockedMana).toBe(50)
    expect(ofType(result.events, 'CARD_DRAWN').filter((e) => e.playerId === 'P1')).toHaveLength(1)
    expect(result.events.some((e) => e.type === 'KEYWORD_TRIGGERED')).toBe(false) // 非 overload 牌：lockMana 静默结算

    const nextTurn = advanceToNextP1Turn(result.state)
    expect(nextTurn.state.players.P1.maxMana).toBe(200)
    expect(nextTurn.state.players.P1.mana).toBe(150) // 200 - 50 锁定
    expect(nextTurn.state.players.P1.lockedMana).toBe(0)
    expect(nextTurn.events.find((e) => e.type === 'BURN_OUT')).toMatchObject({
      playerId: 'P1',
      lockedMana: 50,
    })
  })

  it('芝奇幻锋戟 DDR5-8000：配件入场 + 战吼检索 2 张（RGB 就是战斗力）', () => {
    const state = craftedState({
      hand: [handCard('neutral-trident-z5-ddr5')],
      deckP1: [{ cardId: 'smoke-gpu' }, { cardId: 'smoke-gpu' }],
    })
    const result = playP1(state, 'neutral-trident-z5-ddr5')
    expect(result.events.find((e) => e.type === 'MINION_SUMMONED')).toMatchObject({
      source: 'play',
      unit: { cardId: 'neutral-trident-z5-ddr5', ownerId: 'P1', attack: 0, health: 1 },
    })
    expect(ofType(result.events, 'CARD_DRAWN').filter((e) => e.playerId === 'P1')).toHaveLength(2)
    expect(result.state.board).toHaveLength(1)
    expect(result.state.players.P1.hand).toHaveLength(2)
  })

  it('猫头鹰 NH-D15：战吼给己方显卡续三年质保；质保真实抵挡一次攻击', () => {
    const state = craftedState({
      hand: [handCard('neutral-nh-d15')],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-van', attack: 1, health: 1, maxHealth: 1 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-foe', attack: 2, health: 2, maxHealth: 2 }),
      ],
    })
    const result = playP1(state, 'neutral-nh-d15', unitRef('u-van'))
    expect(result.state.board.find((u) => u.instanceId === 'u-van')?.keywords).toContain('divine_shield')

    // P2 回合攻击验证质保抵挡：伤害被完全消耗，单位无伤
    const p2Turn = engine.applyAction(result.state, { type: 'END_TURN', playerId: 'P1' })
    const attacked = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef('u-van'),
    })
    expect(attacked.events.find((e) => e.type === 'DAMAGE_DEALT')).toMatchObject({ shieldConsumed: true })
    const van = attacked.state.board.find((u) => u.instanceId === 'u-van')
    expect(van?.keywords).not.toContain('divine_shield') // 质保用掉了
    expect(van?.health).toBe(1)
  })

  it('H150i LCD 水冷：己方全体 +1 血光环；水冷阵亡后光环回收', () => {
    const state = craftedState({
      hand: [handCard('neutral-h150i-lcd')],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-ally', attack: 3, health: 3, maxHealth: 3 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-foe', attack: 2, health: 4, maxHealth: 4 }),
      ],
    })
    const mounted = playP1(state, 'neutral-h150i-lcd')
    // 光环投影：3/3 → 3/4（水冷自身 0/1 → 0/2）
    expect(mounted.state.board.find((u) => u.instanceId === 'u-ally')).toMatchObject({ health: 4, maxHealth: 4 })
    expect(mounted.state.board.find((u) => u.cardId === 'neutral-h150i-lcd')).toMatchObject({ health: 2, maxHealth: 2 })

    const coolerId = mounted.state.board.find((u) => u.cardId === 'neutral-h150i-lcd')!.instanceId
    const p2Turn = engine.applyAction(mounted.state, { type: 'END_TURN', playerId: 'P1' })
    const killed = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef(coolerId),
    })
    // 0/2 水冷被 2 攻击者带走（health 归零阵亡），光环随之剥离 → 队友回落 3/3
    expect(killed.state.board.find((u) => u.cardId === 'neutral-h150i-lcd')).toBeUndefined()
    expect(killed.state.board.find((u) => u.instanceId === 'u-ally')).toMatchObject({ health: 3, maxHealth: 3 })
    expect(killed.state.players.P1.graveyard).toContainEqual({
      instanceId: coolerId,
      cardId: 'neutral-h150i-lcd',
    })
  })

  it('X870E HERO：插座光环让己方手牌全体 -50W，对手手牌不享折扣', () => {
    const state = craftedState({
      hand: [handCard('neutral-x870e-hero'), handCard('neutral-990-pro')],
      handP2: [handCard('neutral-990-pro', 'p2-990')],
    })
    expect(state.players.P1.hand.find((c) => c.cardId === 'neutral-990-pro')?.cost).toBe(200)
    const result = playP1(state, 'neutral-x870e-hero')
    expect(result.state.players.P1.hand.find((c) => c.cardId === 'neutral-990-pro')?.cost).toBe(150)
    expect(result.state.players.P2.hand.find((c) => c.cardId === 'neutral-990-pro')?.cost).toBe(200)
  })

  it('B650M 重炮手：M-ATX 也能给全队 +1 攻（攻击光环）', () => {
    const state = craftedState({
      hand: [handCard('neutral-b650m-plus')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-ally', attack: 2, health: 2, maxHealth: 2 })],
    })
    const result = playP1(state, 'neutral-b650m-plus')
    expect(result.state.board.find((u) => u.instanceId === 'u-ally')).toMatchObject({ attack: 3, health: 2 })
  })

  it('FOCUS GX-850：电涌全场打 3 + 跳闸锁 100W，下回合 BURN_OUT 结算并清零', () => {
    const state = craftedState({
      hand: [handCard('neutral-focus-gx-850')],
      board: [
        makeUnit({ ownerId: 'P1', instanceId: 'u-mine', attack: 2, health: 3, maxHealth: 3 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-theirs', attack: 1, health: 3, maxHealth: 3 }),
      ],
    })
    const result = playP1(state, 'neutral-focus-gx-850')
    expect(result.events.find((e) => e.type === 'KEYWORD_TRIGGERED')).toMatchObject({ keyword: 'overload' })
    expect(result.state.players.P1.lockedMana).toBe(100)
    // 电涌无差别：全场 3 血单位全部阵亡
    expect(result.state.board).toHaveLength(0)
    expect(result.state.players.P1.graveyard).toContainEqual({ instanceId: 'u-mine', cardId: expect.any(String) })
    expect(result.state.players.P2.graveyard).toContainEqual({ instanceId: 'u-theirs', cardId: expect.any(String) })

    const nextTurn = advanceToNextP1Turn(result.state)
    expect(nextTurn.events.find((e) => e.type === 'BURN_OUT')).toMatchObject({
      playerId: 'P1',
      lockedMana: 100,
    })
    expect(nextTurn.state.players.P1.lockedMana).toBe(0)
    expect(nextTurn.state.players.P1.maxMana).toBe(200)
    expect(nextTurn.state.players.P1.mana).toBe(100) // 200 − 100 锁定
  })

  it('ROG THOR 1600T：千瓦信仰入场即 +20 护甲（供能余量即防御）', () => {
    const result = playP1(
      craftedState({ hand: [handCard('neutral-rog-thor-1600t')] }),
      'neutral-rog-thor-1600t',
    )
    expect(result.events.find((e) => e.type === 'ARMOR_GAINED')).toMatchObject({
      playerId: 'P1',
      amount: 20,
      totalArmor: 20,
    })
    expect(result.state.players.P1.armor).toBe(20)
    expect(ofType(result.events, 'CARD_PLAYED')[0]).toMatchObject({ cost: 1000 })
    expect(result.state.board).toHaveLength(1) // 配件在场上（OLED 小电视）
  })

  it('迪锐克斯 KING 电竞椅：4/7 信仰充值（taunt）实体入场', () => {
    const result = playP1(
      craftedState({ hand: [handCard('neutral-dxracer-king')] }),
      'neutral-dxracer-king',
    )
    expect(result.events.find((e) => e.type === 'MINION_SUMMONED')).toMatchObject({
      unit: { cardId: 'neutral-dxracer-king', attack: 4, health: 7, keywords: ['taunt'] },
    })
  })

  it('CHERRY MX 8.0：被攻击受伤存活后青轴反击（onDamaged 对随机敌方单位打 2）', () => {
    const state = craftedState({
      turn: 2,
      activePlayer: 'P2',
      board: [
        makeUnit({
          ownerId: 'P1',
          instanceId: 'u-cherry',
          cardId: 'neutral-cherry-mx-8-0',
          attack: 2,
          health: 3,
          maxHealth: 3,
        }),
        // 攻击者 2/5：扛得住键盘 2 攻的战斗反击，留在场上继续吃 onDamaged 的 1 点
        makeUnit({ ownerId: 'P2', instanceId: 'u-foe', attack: 2, health: 5, maxHealth: 5 }),
      ],
    })
    const result = engine.applyAction(state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef('u-cherry'),
    })
    // 键盘战士扛下 2 点伤害存活，反手对唯一敌方单位（攻击者）敲出 2 点
    expect(result.state.board.find((u) => u.instanceId === 'u-cherry')).toMatchObject({ health: 1 })
    expect(result.state.board.find((u) => u.instanceId === 'u-foe')).toMatchObject({ health: 1 })
    expect(
      ofType(result.events, 'DAMAGE_DEALT').find(
        (e) => e.source.kind === 'effect' && e.source.ref === 'neutral-cherry-mx-8-0',
      ),
    ).toMatchObject({ target: { kind: 'unit', instanceId: 'u-foe' }, amount: 2 })
  })

  it('罗技 G502 HERO：charge（超频）入场当回合即可冲锋，4/2 换掉 2/2 双双阵亡', () => {
    const state = craftedState({
      hand: [handCard('neutral-g502-hero')],
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-fodder', attack: 2, health: 2, maxHealth: 2 })],
    })
    const played = playP1(state, 'neutral-g502-hero')
    const g502 = played.state.board.find((u) => u.cardId === 'neutral-g502-hero')
    expect(g502).toBeDefined()
    const combat = engine.applyAction(played.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: g502!.instanceId,
      target: unitRef('u-fodder'),
    })
    expect(ofType(combat.events, 'ATTACK_DECLARED')).toHaveLength(1)
    expect(combat.state.board.find((u) => u.instanceId === 'u-fodder')).toBeUndefined()
    // 4/2 换 2/2：防守方反击快照照常结算，G502 2 血归零阵亡（§2.4 同时结算语义）
    expect(combat.state.board.find((u) => u.cardId === 'neutral-g502-hero')).toBeUndefined()
    expect(combat.state.players.P2.graveyard).toContainEqual({ instanceId: 'u-fodder', cardId: expect.any(String) })
    expect(combat.state.players.P1.graveyard).toContainEqual({
      instanceId: g502!.instanceId,
      cardId: 'neutral-g502-hero',
    })
  })
})

// —— 3. 派系配合面 ——

describe('neutral 批次与四派系技能的配合面', () => {
  it('B650M 攻击光环 + nvidia DLSS：光环与技能 buff 加法叠加（2+1+1=4），事件流携带 HERO_POWER_USED', () => {
    const state = craftedState({
      factionP1: 'nvidia',
      hand: [handCard('neutral-b650m-plus')],
      board: [makeUnit({ ownerId: 'P1', instanceId: 'u-ally', attack: 2, health: 2, maxHealth: 2 })],
    })
    const mounted = playP1(state, 'neutral-b650m-plus')
    expect(mounted.state.board.find((u) => u.instanceId === 'u-ally')).toMatchObject({ attack: 3 })
    const powered = engine.applyAction(mounted.state, {
      type: 'USE_HERO_POWER',
      playerId: 'P1',
      target: unitRef('u-ally'),
    })
    expect(powered.events.find((e) => e.type === 'HERO_POWER_USED')).toMatchObject({ skillId: 'dlss' })
    expect(powered.state.board.find((u) => u.instanceId === 'u-ally')).toMatchObject({ attack: 4 })
  })
})

// —— 4. 非法操作拒绝 ×3（§3）——

describe('neutral 批次非法操作拒绝', () => {
  it('功耗不足：300W 想点亮 1000W 的 ROG THOR 1600T → INSUFFICIENT_MANA', () => {
    const state = craftedState({
      hand: [handCard('neutral-rog-thor-1600t')],
      mana: 300,
    })
    const error = catchRuleError(() => playP1(state, 'neutral-rog-thor-1600t'))
    expect(error).toBeInstanceOf(RuleError)
    expect(error.code).toBe('INSUFFICIENT_MANA')
  })

  it('目标不在池内：NH-D15 的质保只能给己方单位，指向敌方 → INVALID_TARGET', () => {
    const state = craftedState({
      hand: [handCard('neutral-nh-d15')],
      board: [makeUnit({ ownerId: 'P2', instanceId: 'u-foe', attack: 2, health: 2, maxHealth: 2 })],
    })
    const error = catchRuleError(() => playP1(state, 'neutral-nh-d15', unitRef('u-foe')))
    expect(error).toBeInstanceOf(RuleError)
    expect(error.code).toBe('INVALID_TARGET')
  })

  it('信仰充值拦截：电竞椅嘲讽在场时绕过它攻击其他单位 → TAUNT_BLOCKING', () => {
    const state = craftedState({
      turn: 2,
      activePlayer: 'P2',
      board: [
        makeUnit({
          ownerId: 'P1',
          instanceId: 'u-chair',
          cardId: 'neutral-dxracer-king',
          attack: 2,
          health: 6,
          maxHealth: 6,
          keywords: ['taunt'],
        }),
        makeUnit({ ownerId: 'P1', instanceId: 'u-van', attack: 3, health: 3, maxHealth: 3 }),
        makeUnit({ ownerId: 'P2', instanceId: 'u-foe', attack: 2, health: 2, maxHealth: 2 }),
      ],
    })
    const error = catchRuleError(() =>
      engine.applyAction(state, {
        type: 'ATTACK',
        playerId: 'P2',
        attackerId: 'u-foe',
        target: unitRef('u-van'),
      }),
    )
    expect(error).toBeInstanceOf(RuleError)
    expect(error.code).toBe('TAUNT_BLOCKING')
  })
})

// —— 5. 全局对局：真实卡组 + 贪心驱动 + 确定性双跑 ——

/** 30 张纯 driver 卡组：不占扩展槽，贪心驱动可打穿全牌库（不含 chosen 目标牌） */
const DRIVER_DECK: DeckSpec = {
  cards: [
    { cardId: 'neutral-furmark', count: 10 },
    { cardId: 'neutral-990-pro', count: 10 },
    { cardId: 'neutral-focus-gx-850', count: 10 },
  ],
}

interface FullGameRun {
  state: GameState
  events: GameEvent[]
  played: ReadonlySet<string>
}

/** P1 贪心打牌（能打就打），P2 全程挂机过回合；收口于三张 driver 全部打出且 BURN_OUT 已结算 */
function runFullGame(): FullGameRun {
  let state = engine.initGame({
    seed: 20261003,
    players: [
      { id: 'P1', faction: 'neutral', deck: DRIVER_DECK },
      { id: 'P2', faction: 'neutral', deck: makeDeckSpec() }, // smoke-gpu ×30 填充
    ],
  })
  const events: GameEvent[] = []
  const played = new Set<string>()
  for (let step = 0; step < 400; step += 1) {
    if (state.phase === 'ended') break
    const legal = engine.getLegalActions(state, state.activePlayer)
    if (state.activePlayer === 'P1') {
      const play = legal.find(isPlayCard)
      if (play) {
        const result = engine.applyAction(state, play)
        state = result.state
        events.push(...result.events)
        for (const e of result.events) if (e.type === 'CARD_PLAYED') played.add(e.cardId)
        continue
      }
    }
    const end = legal.find((a) => a.type === 'END_TURN')
    if (!end) break
    const result = engine.applyAction(state, end)
    state = result.state
    events.push(...result.events)
    if (played.size >= 3 && events.some((e) => e.type === 'BURN_OUT')) break
  }
  return { state, events, played }
}

describe('neutral 批次全局对局（initGame → 贪心驱动 → 确定性）', () => {
  it('30 张真实卡组整局：三张 driver 全部打出，GX-850 跳闸次回合结算 BURN_OUT，出牌 cost 与定义一致', () => {
    const run = runFullGame()
    expect([...run.played].sort()).toEqual([
      'neutral-990-pro',
      'neutral-focus-gx-850',
      'neutral-furmark',
    ])
    expect(
      run.events.find((e) => e.type === 'CARD_PLAYED' && e.cardId === 'neutral-focus-gx-850'),
    ).toMatchObject({ playerId: 'P1', cost: 850 })
    expect(
      run.events.find((e) => e.type === 'CARD_PLAYED' && e.cardId === 'neutral-990-pro'),
    ).toMatchObject({ playerId: 'P1', cost: 200 })
    expect(run.events.find((e) => e.type === 'BURN_OUT')).toMatchObject({
      playerId: 'P1',
      lockedMana: 100,
    })
    // GX-850 打出后 lockedMana 立即累加，次回合开始结算并清零（§2.2）
    expect(run.state.players.P1.lockedMana).toBe(0)
  })

  it('确定性（§11）：同 seed 同驱动跑两遍，事件流逐字节一致、终局状态哈希一致', () => {
    const a = runFullGame()
    const b = runFullGame()
    expect(JSON.stringify(a.events)).toEqual(JSON.stringify(b.events))
    expect(stableHash(a.state)).toEqual(stableHash(b.state))
    expect([...a.played].sort()).toEqual([...b.played].sort())
  })
})
