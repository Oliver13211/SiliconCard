/**
 * M4-CNT5（Apple Silicon 批次）卡池验收 —— packages/content/cards/apple/ 的 10 张卡。
 *
 * 验收口径（WF-CARD 三件套之「单测」，与 nvidia 批次同款四段，效果一律声明式
 * EffectSpec 原语组合，零新 handler）：
 * 1. schema 闸门：10 张定义全部通过 findCardDefinitionIssues（引擎消费字段结构校验），
 *    cardId 统一 apple- 前缀、cost ∈ [100, 1000]（对齐真实功耗：M1 Ultra=Mac Studio
 *    370W 整机最大持续功耗、MBP16 M1 Max=140W 快充适配器、垃圾桶=450W 电源）、
 *    稀有度含传说；整派系 ≤450W 的低费特性断言（能效比是派系身份）；
 * 2. 实打覆盖：registerCardDefinitions 注册后经 createEngine 真实开局
 *    （10 张 ×3 = 30 张卡组，apple vs amd 内置技能，apple「能效比」+2 甲由引擎侧
 *    builtin 注册），seed 驱动的合法动作扫描把每张卡至少打出一次
 *    （CARD_PLAYED 事件全覆盖断言）；
 * 3. 关键事件：每张卡在受控局面下经 engine.applyAction 实打，断言效果原语的关键
 *    事件与状态增量（双芯 windfury / 垃圾桶 taunt / 生产力战吼抽牌 / 无风扇潜行 /
 *    Rosetta 转译复活 / AppleCare 三年质保 / 统一内存 buff+护甲双份分发 /
 *    T2 序列化配对摧毁 / 隔空投送群发直伤 / 天才吧治疗+换新抽牌 / 低费曲线）；
 * 4. 非法操作：INSUFFICIENT_MANA / INVALID_TARGET（池外目标）/ NOT_YOUR_TURN 三类拒绝
 *    （潜行目标的 stealth_hidden 拒绝另见 MacBook Air 用例）。
 *
 * 本文件只读 content JSON；不修改 packages/core 任何既有文件。
 */

import { describe, expect, it } from 'vitest'
import { DECK_SIZE, MAX_MANA } from '../constants'
import type { Action, PlayerId, TargetRef } from '../types/actions'
import type { CardDefinition } from '../types/cards'
import type { BoardUnit, DeckEntry, DeckSpec, GameSetup, GameState, HandCard } from '../types/state'
import { createEngine } from '../engine/index'
import { registerCardDefinitions, findCardDefinitionIssues } from '../engine/registry'
import { catchRuleError, makeGameState, makePlayer, makeUnit } from '../testing/state'
import defM1Ultra from '../../../content/cards/apple/apple-m1-ultra.json'
import defMacPro2013 from '../../../content/cards/apple/apple-mac-pro-2013.json'
import defMacbookPro16 from '../../../content/cards/apple/apple-macbook-pro-16-m1-max.json'
import defMacbookAirM2 from '../../../content/cards/apple/apple-macbook-air-m2.json'
import defRosetta2 from '../../../content/cards/apple/apple-rosetta-2.json'
import defApplecarePlus from '../../../content/cards/apple/apple-applecare-plus.json'
import defUnifiedMemory from '../../../content/cards/apple/apple-unified-memory.json'
import defT2Security from '../../../content/cards/apple/apple-t2-security.json'
import defAirdrop from '../../../content/cards/apple/apple-airdrop.json'
import defGeniusBar from '../../../content/cards/apple/apple-genius-bar.json'

/** JSON → CardDefinition：结构合法性由 findCardDefinitionIssues 运行期闸门把关 */
const DEFS: readonly CardDefinition[] = [
  defM1Ultra,
  defMacPro2013,
  defMacbookPro16,
  defMacbookAirM2,
  defRosetta2,
  defApplecarePlus,
  defUnifiedMemory,
  defT2Security,
  defAirdrop,
  defGeniusBar,
] as unknown as readonly CardDefinition[]

registerCardDefinitions(DEFS)

const DEFS_BY_ID = new Map(DEFS.map((def) => [def.id, def]))
const ALL_IDS = DEFS.map((def) => def.id)

const engine = createEngine()

const unitRef = (instanceId: string): TargetRef => ({ kind: 'unit', instanceId })
const heroRef = (playerId: PlayerId): TargetRef => ({ kind: 'hero', playerId })

function handOf(cardId: string, uid = `hand-${cardId}`): HandCard {
  const def = DEFS_BY_ID.get(cardId)
  if (!def) throw new Error(`测试引用了本批未收录的卡 ${cardId}`)
  return { uid, cardId, cost: def.cost }
}

function deckOf(cardIds: readonly string[]): DeckEntry[] {
  return cardIds.map((cardId) => ({ cardId }))
}

/** 抽牌测试的填充牌库（smoke-gpu 由 testing/state 预注册，防止空库触发疲劳干扰断言） */
const FILLER_DECK = deckOf(['smoke-gpu', 'smoke-gpu', 'smoke-gpu', 'smoke-gpu', 'smoke-gpu'])

interface CtlOptions {
  hand?: HandCard[]
  board?: BoardUnit[]
  deckP1?: readonly string[]
  manaP1?: number
  activePlayer?: PlayerId
}

/** 受控局面：跳过 initGame 卡组/派系闸门，直接构造 P1 回合的最小合法状态（P2 满供电待命） */
function ctlState(opts: CtlOptions = {}): GameState {
  return makeGameState({
    activePlayer: opts.activePlayer ?? 'P1',
    players: {
      P1: {
        ...makePlayer('P1'),
        mana: opts.manaP1 ?? MAX_MANA,
        maxMana: MAX_MANA,
        hand: opts.hand ?? [],
        deck: opts.deckP1 ? deckOf(opts.deckP1) : FILLER_DECK,
      },
      P2: { ...makePlayer('P2'), mana: MAX_MANA, maxMana: MAX_MANA, deck: FILLER_DECK },
    },
    board: opts.board ?? [],
  })
}

function playP1(state: GameState, uid: string, target?: TargetRef) {
  return engine.applyAction(state, {
    type: 'PLAY_CARD',
    playerId: 'P1',
    uid,
    ...(target ? { target } : {}),
  })
}

/** 真实开局配置：10 张 ×3 = DECK_SIZE，apple vs amd（双方技能均随引擎加载自动注册） */
function appleSetup(): GameSetup {
  const deck: DeckSpec = { cards: ALL_IDS.map((cardId) => ({ cardId, count: 3 })) }
  return {
    seed: 20261004,
    players: [
      { id: 'P1', faction: 'apple', deck },
      { id: 'P2', faction: 'amd', deck },
    ],
  }
}

describe('M4-CNT5 apple 批次：schema 闸门', () => {
  it('10 张定义全部合法：cardId 前缀、cost 区间、稀有度梯度（含传说）、真实功耗对齐抽查', () => {
    expect(DEFS).toHaveLength(10)
    expect(new Set(ALL_IDS).size).toBe(10)
    for (const def of DEFS) {
      expect(def.id).toMatch(/^apple-/)
      expect(findCardDefinitionIssues(def)).toBeNull()
      expect(def.cost).toBeGreaterThanOrEqual(100)
      expect(def.cost).toBeLessThanOrEqual(MAX_MANA)
    }
    expect(new Set(DEFS.map((def) => def.rarity)).size).toBeGreaterThanOrEqual(3)
    expect(DEFS.some((def) => def.rarity === 'legendary')).toBe(true)
    // 真实功耗对齐抽查（§4：M1 Ultra=Mac Studio 370W 整机、MBP16=140W 适配器、垃圾桶=450W 电源）
    expect(DEFS_BY_ID.get('apple-m1-ultra')?.cost).toBe(370)
    expect(DEFS_BY_ID.get('apple-macbook-pro-16-m1-max')?.cost).toBe(140)
    expect(DEFS_BY_ID.get('apple-macbook-air-m2')?.cost).toBe(100)
    expect(DEFS_BY_ID.get('apple-mac-pro-2013')?.cost).toBe(450)
    // 派系身份：全系 ≤450W（垃圾桶是派系电老虎，也是历史事实），与 575W 的 5090 拉开能效差
    expect(Math.max(...DEFS.map((def) => def.cost))).toBeLessThanOrEqual(450)
    // 双芯旗舰（M1 Ultra）自带 windfury；配件不带攻血（schema 违例由闸门拦截，此处抽查结构）
    expect(DEFS_BY_ID.get('apple-m1-ultra')?.keywords).toContain('windfury')
    for (const def of DEFS.filter((d) => d.type === 'accessory')) {
      expect(def.attack).toBeUndefined()
      expect(def.health).toBeUndefined()
    }
  })

  it('10 张 ×3 组成 30 张卡组，经 initGame 真实开局（apple「能效比」vs amd 内置技能）', () => {
    const state = engine.initGame(appleSetup())
    expect(state.players.P1.hand).toHaveLength(3)
    expect(state.players.P2.hand).toHaveLength(3)
    expect(state.players.P1.deck).toHaveLength(DECK_SIZE - 3)
    expect(state.turn).toBe(1)
    expect(state.activePlayer).toBe('P1')
    // apple 派系技能随引擎 builtin 注册，英雄技能可正常结算（200W +2 甲，不发热=散热好）
    state.players.P1.mana = 200 // 首回合供电 100W 不足以开技能，先补足
    const powered = engine.applyAction(state, { type: 'USE_HERO_POWER', playerId: 'P1' })
    expect(powered.state.players.P1.armor).toBe(2)
    expect(powered.events.find((event) => event.type === 'ARMOR_GAINED')).toMatchObject({
      playerId: 'P1',
      amount: 2,
      totalArmor: 2,
    })
  })
})

describe('M4-CNT5 apple 批次：实打覆盖扫描', () => {
  it('seed 对局实打：10 张卡全部至少被打出一次（CARD_PLAYED 事件覆盖）', () => {
    let state = engine.initGame(appleSetup())
    const played = new Set<string>()
    const cardIdOfUid = (s: GameState, uid: string): string | undefined =>
      [...s.players.P1.hand, ...s.players.P2.hand].find((card) => card.uid === uid)?.cardId
    const typeOfUid = (s: GameState, uid: string): string | undefined => {
      const cardId = cardIdOfUid(s, uid)
      return cardId ? DEFS_BY_ID.get(cardId)?.type : undefined
    }

    for (let i = 0; i < 400 && played.size < ALL_IDS.length; i += 1) {
      if (state.phase === 'ended') break
      const active = state.activePlayer
      const actions = engine.getLegalActions(state, active)
      const plays = actions.filter(
        (action): action is Extract<Action, { type: 'PLAY_CARD' }> => action.type === 'PLAY_CARD',
      )
      const fresh = plays.filter((action) => {
        const cardId = cardIdOfUid(state, action.uid)
        return cardId !== undefined && !played.has(cardId)
      })
      const ownUnits = state.board.filter((unit) => unit.ownerId === active).length
      // 优先打出未见过的牌：driver 不占槽先行；单位牌留两个槽位余量防 7 槽塞满
      const pick =
        fresh.find((action) => typeOfUid(state, action.uid) === 'driver') ??
        (ownUnits < 5 ? fresh.find((action) => typeOfUid(state, action.uid) !== 'driver') : undefined) ??
        (ownUnits < 3 ? fresh[0] : undefined)
      if (pick) {
        const result = engine.applyAction(state, pick)
        for (const event of result.events) if (event.type === 'CARD_PLAYED') played.add(event.cardId)
        state = result.state
        continue
      }
      // 无牌可下：优先用攻击换掉对方单位（腾槽位），否则过牌
      const attacks = actions.filter(
        (action): action is Extract<Action, { type: 'ATTACK' }> => action.type === 'ATTACK',
      )
      const trade = attacks.find((action) => {
        const target = action.target
        if (target.kind !== 'unit') return false
        const attacker = state.board.find((unit) => unit.instanceId === action.attackerId)
        const victim = state.board.find((unit) => unit.instanceId === target.instanceId)
        return attacker !== undefined && victim !== undefined && attacker.attack >= victim.health
      })
      const result = engine.applyAction(state, trade ?? { type: 'END_TURN', playerId: active })
      for (const event of result.events) if (event.type === 'CARD_PLAYED') played.add(event.cardId)
      state = result.state
    }

    expect(ALL_IDS.filter((id) => !played.has(id))).toEqual([])
  })
})

describe('M4-CNT5 apple 批次：关键事件断言（整机线）', () => {
  it('M1 Ultra：双芯 GPU（windfury）——官方胶水粘出每回合两次攻击（传说位）', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 3,
      health: 6,
      maxHealth: 6,
    })
    const state = ctlState({ hand: [handOf('apple-m1-ultra')], board: [foe] })
    const played = playP1(state, 'hand-apple-m1-ultra')
    const ultraId = played.state.board.find((unit) => unit.cardId === 'apple-m1-ultra')!.instanceId
    expect(played.state.board.find((unit) => unit.instanceId === ultraId)).toMatchObject({
      attack: 6,
      health: 8,
      keywords: ['windfury'],
    })
    const nextOwn = engine.applyAction(
      engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' }).state,
      { type: 'END_TURN', playerId: 'P2' },
    )
    expect(nextOwn.state.board.find((unit) => unit.instanceId === ultraId)?.attacksRemaining).toBe(2)
    // 连打两次：先换掉 3/6，再打 CPU
    const swing1 = engine.applyAction(nextOwn.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: ultraId,
      target: unitRef('u-foe'),
    })
    expect(swing1.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(swing1.state.board.find((unit) => unit.instanceId === 'u-foe')).toBeUndefined()
    const swing2 = engine.applyAction(swing1.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: ultraId,
      target: heroRef('P2'),
    })
    expect(swing2.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(swing2.state.players.P2.health).toBe(24) // 30 − 6
    expect(swing2.state.board.find((unit) => unit.instanceId === ultraId)).toMatchObject({
      health: 5, // 8 − 3（反伤）
      attacksRemaining: 0,
    })
  })

  it('Mac Pro 2013：垃圾桶 taunt 拦截敌方攻击——想动别的？先问过这只垃圾桶', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 3,
      health: 5,
      maxHealth: 5,
    })
    const state = ctlState({ hand: [handOf('apple-mac-pro-2013')], board: [ally, foe] })
    const played = playP1(state, 'hand-apple-mac-pro-2013')
    const binId = played.state.board.find((unit) => unit.cardId === 'apple-mac-pro-2013')!.instanceId
    expect(played.state.board.find((unit) => unit.instanceId === binId)).toMatchObject({
      attack: 3,
      health: 10,
      keywords: ['taunt'],
    })
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const blocked = catchRuleError(() =>
      engine.applyAction(p2Turn.state, {
        type: 'ATTACK',
        playerId: 'P2',
        attackerId: 'u-foe',
        target: unitRef('u-ally'),
      }),
    )
    expect(blocked.code).toBe('TAUNT_BLOCKING')
    const hitBin = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef(binId),
    })
    expect(hitBin.state.board.find((unit) => unit.instanceId === binId)).toMatchObject({
      health: 7, // 10 − 3
    })
    // 垃圾桶只有 3 攻：反伤蹭不死对面，但足够宣示主权
    expect(hitBin.state.board.find((unit) => unit.instanceId === 'u-foe')).toMatchObject({ health: 2 })
  })

  it('MacBook Pro 16 M1 Max：战吼抽 1（买前生产力的最后一波生产力）+ 140W 适配器定价', () => {
    const state = ctlState({ hand: [handOf('apple-macbook-pro-16-m1-max')], deckP1: ['smoke-gpu'] })
    const played = playP1(state, 'hand-apple-macbook-pro-16-m1-max')
    expect(played.state.board.find((unit) => unit.cardId === 'apple-macbook-pro-16-m1-max')).toMatchObject({
      attack: 4,
      health: 5,
    })
    expect(played.events.find((event) => event.type === 'CARD_DRAWN')).toMatchObject({
      playerId: 'P1',
      cardId: 'smoke-gpu',
      source: 'deck',
    })
    expect(played.state.players.P1.hand.map((card) => card.cardId)).toEqual(['smoke-gpu'])
    expect(played.state.players.P1.mana).toBe(MAX_MANA - 140)
  })

  it('MacBook Air M2：无风扇静音（stealth）——现身前不可被指定，攻击后现身', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('apple-macbook-air-m2')], board: [foe] })
    const played = playP1(state, 'hand-apple-macbook-air-m2')
    const airId = played.state.board.find((unit) => unit.cardId === 'apple-macbook-air-m2')!.instanceId
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const hidden = catchRuleError(() =>
      engine.applyAction(p2Turn.state, {
        type: 'ATTACK',
        playerId: 'P2',
        attackerId: 'u-foe',
        target: unitRef(airId),
      }),
    )
    expect(hidden.code).toBe('INVALID_TARGET')
    expect(hidden.detail).toMatchObject({ reason: 'stealth_hidden' })
    const nextOwn = engine.applyAction(p2Turn.state, { type: 'END_TURN', playerId: 'P2' })
    const revealed = engine.applyAction(nextOwn.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: airId,
      target: heroRef('P2'),
    })
    expect(revealed.state.players.P2.health).toBe(28) // 30 − 2（安静地咬了一口）
    expect(revealed.state.board.find((unit) => unit.instanceId === airId)?.keywords).toEqual([])
    expect(revealed.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'stealth',
    })
  })

  it('低费曲线：M1 Ultra + MacBook Pro 16 + MacBook Air 一回合全下，仍剩 390W', () => {
    const state = ctlState({
      hand: [handOf('apple-m1-ultra'), handOf('apple-macbook-pro-16-m1-max'), handOf('apple-macbook-air-m2')],
    })
    let cursor = playP1(state, 'hand-apple-m1-ultra').state
    cursor = playP1(cursor, 'hand-apple-macbook-pro-16-m1-max').state
    const played = playP1(cursor, 'hand-apple-macbook-air-m2')
    const byCardId = (cardId: string) => played.state.board.find((unit) => unit.cardId === cardId)
    expect(byCardId('apple-m1-ultra')).toMatchObject({ attack: 6, health: 8 })
    expect(byCardId('apple-macbook-pro-16-m1-max')).toMatchObject({ attack: 4, health: 5 })
    expect(byCardId('apple-macbook-air-m2')).toMatchObject({ attack: 2, health: 3 })
    expect(played.state.players.P1.mana).toBe(MAX_MANA - 370 - 140 - 100)
  })
})

describe('M4-CNT5 apple 批次：关键事件断言（生态线）', () => {
  it('Rosetta 2：转译复活——从墓地捞回最近死亡的显卡（x86 老卡学会新母语）', () => {
    const state = ctlState({ hand: [handOf('apple-rosetta-2')] })
    state.players.P1.graveyard = [{ instanceId: 'u-old', cardId: 'apple-macbook-air-m2' }]
    const played = playP1(state, 'hand-apple-rosetta-2')
    const revived = played.state.board.find((unit) => unit.cardId === 'apple-macbook-air-m2')
    expect(revived).toBeDefined()
    expect(revived!.instanceId).not.toBe('u-old') // 复活 ≠ 原实例
    expect(revived).toMatchObject({ attack: 2, health: 3, keywords: ['stealth'] })
    expect(played.events.find((event) => event.type === 'MINION_SUMMONED')).toMatchObject({
      source: 'effect',
    })
    expect(played.state.players.P1.graveyard).toEqual([]) // 复活即离墓
  })

  it('Rosetta 2 边界：墓地只有配件（不可复活类型）时静默 no-op', () => {
    const state = ctlState({ hand: [handOf('apple-rosetta-2')] })
    state.players.P1.graveyard = [{ instanceId: 'u-acc', cardId: 'apple-applecare-plus' }]
    const played = playP1(state, 'hand-apple-rosetta-2')
    expect(played.state.board).toEqual([])
    expect(played.state.players.P1.graveyard).toEqual([
      { instanceId: 'u-acc', cardId: 'apple-applecare-plus' },
    ])
  })

  it('AppleCare+：配件 0/1 入场，战吼给己方显卡上三年质保（divine_shield）', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'smoke-gpu',
      attack: 5,
      health: 4,
      maxHealth: 4,
    })
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 2,
      health: 2,
      maxHealth: 2,
    })
    const state = ctlState({ hand: [handOf('apple-applecare-plus')], board: [ally, foe] })
    const played = playP1(state, 'hand-apple-applecare-plus', unitRef('u-ally'))
    expect(played.state.board.find((unit) => unit.cardId === 'apple-applecare-plus')).toMatchObject({
      attack: 0, // 配件 0/1 入场（§4）
      health: 1,
      attacksRemaining: 0, // 配件不可攻击
    })
    expect(played.state.board.find((unit) => unit.instanceId === 'u-ally')?.keywords).toEqual([
      'divine_shield',
    ])
    // P2 攻击上保单位：质保完全抵挡（shieldConsumed）， Ally 无伤
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const blocked = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef('u-ally'),
    })
    expect(blocked.events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({
      target: { kind: 'unit', instanceId: 'u-ally' },
      amount: 2,
      remainingHealth: 4,
      shieldConsumed: true,
    })
    expect(blocked.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({
      health: 4,
      keywords: [],
    })
    expect(blocked.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'divine_shield',
    })
  })

  it('统一内存：指定显卡 buff +1/+1（GPU 那份显存）+ 己方护甲 +2（CPU 那份内存）', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'smoke-gpu',
      attack: 5,
      health: 4,
      maxHealth: 4,
    })
    const state = ctlState({ hand: [handOf('apple-unified-memory')], board: [ally] })
    const played = playP1(state, 'hand-apple-unified-memory', unitRef('u-ally'))
    expect(played.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({
      attack: 6,
      health: 5,
      maxHealth: 5,
    })
    expect(played.events.find((event) => event.type === 'ARMOR_GAINED')).toMatchObject({
      playerId: 'P1',
      amount: 2,
      totalArmor: 2,
    })
    expect(played.state.players.P1.armor).toBe(2)
  })

  it('T2 安全芯片：序列化配对——摧毁一台敌方设备（非原厂零件当场禁用）', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('apple-t2-security')], board: [foe] })
    const played = playP1(state, 'hand-apple-t2-security', unitRef('u-foe'))
    expect(played.state.board).toEqual([])
    expect(played.events.find((event) => event.type === 'MINION_DIED')).toMatchObject({
      cause: 'destroy',
      unit: { cardId: 'smoke-gpu' },
    })
    expect(played.state.players.P2.graveyard).toContainEqual({
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
    })
  })

  it('隔空投送：群发弹窗——对全部敌方显卡结算 2 点直伤', () => {
    const foeA = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe-a',
      cardId: 'smoke-gpu',
      attack: 3,
      health: 3,
      maxHealth: 3,
    })
    const foeB = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe-b',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 4,
      maxHealth: 4,
    })
    const state = ctlState({ hand: [handOf('apple-airdrop')], board: [foeA, foeB] })
    const played = playP1(state, 'hand-apple-airdrop')
    expect(played.state.board.find((unit) => unit.instanceId === 'u-foe-a')).toMatchObject({ health: 1 })
    expect(played.state.board.find((unit) => unit.instanceId === 'u-foe-b')).toMatchObject({ health: 2 })
    const damages = played.events.filter(
      (event) => event.type === 'DAMAGE_DEALT' && event.source.kind === 'effect',
    )
    expect(damages).toHaveLength(2)
    for (const event of damages) expect(event).toMatchObject({ amount: 2 })
    expect(played.state.players.P2.health).toBe(30) // 只糊单位，不上脸
  })

  it('天才吧：配件入场战吼——治疗己方 CPU 3 点 + 换新抽 1 张', () => {
    const state = ctlState({ hand: [handOf('apple-genius-bar')], deckP1: ['smoke-gpu'] })
    state.players.P1.health = 20 // 先把 CPU 磨到需要 Genius Bar
    const played = playP1(state, 'hand-apple-genius-bar')
    expect(played.events.find((event) => event.type === 'HEALING')).toMatchObject({
      target: { kind: 'hero', playerId: 'P1' },
      amount: 3,
      resultingHealth: 23,
    })
    expect(played.state.players.P1.health).toBe(23)
    expect(played.events.find((event) => event.type === 'CARD_DRAWN')).toMatchObject({
      playerId: 'P1',
      cardId: 'smoke-gpu',
      source: 'deck',
    })
    expect(played.state.board.find((unit) => unit.cardId === 'apple-genius-bar')).toMatchObject({
      attack: 0,
      health: 1,
      attacksRemaining: 0,
    })
  })
})

describe('M4-CNT5 apple 批次：非法操作拒绝（§3 错误码）', () => {
  it('供电不足：100W 供不出 370W 的 M1 Ultra → INSUFFICIENT_MANA', () => {
    const state = ctlState({ hand: [handOf('apple-m1-ultra')], manaP1: 100 })
    const error = catchRuleError(() => playP1(state, 'hand-apple-m1-ultra'))
    expect(error.code).toBe('INSUFFICIENT_MANA')
  })

  it('池外目标：T2 安全芯片指定己方显卡 → INVALID_TARGET（not_in_pool）', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('apple-t2-security')], board: [ally] })
    const error = catchRuleError(() => playP1(state, 'hand-apple-t2-security', unitRef('u-ally')))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'not_in_pool', pool: 'enemyUnits' })
  })

  it('不是你的回合：P2 回合代打 P1 的隔空投送 → NOT_YOUR_TURN', () => {
    const state = ctlState({ hand: [handOf('apple-airdrop')], activePlayer: 'P2' })
    const error = catchRuleError(() =>
      engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'hand-apple-airdrop' }),
    )
    expect(error.code).toBe('NOT_YOUR_TURN')
  })
})
