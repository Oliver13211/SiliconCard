/**
 * M4-CNT5（ARM Mali 批次）卡池验收 —— packages/content/cards/arm/ 的 10 张卡
 * （含 1 张 token：arm-mali-reference「公版亮机卡」，英雄技能「公版方案」的召唤物）。
 *
 * 验收口径（照 M1-CNT nvidia 批次四段，效果一律声明式 EffectSpec 原语组合，零新 handler）：
 * 1. schema 闸门：10 张定义全部通过 findCardDefinitionIssues（引擎消费字段结构校验），
 *    cardId 统一 arm- 前缀、cost ∈ [100, 1000]（手机 SoC 真实功耗贴地板 → 极低费快攻曲线）、
 *    稀有度含传说；token 卡按 M4-CNT5 拍板规格逐字段核对（无 effect、不入任何卡组）；
 * 2. 实打覆盖：registerCardDefinitions 注册后经 createEngine 四函数真实开局
 *    （arm vs arm 内置技能「公版方案」，卡组直接采用预组 arm-reference-swarm.json），
 *    seed 驱动的合法动作扫描把 9 张可收集卡至少打出一次（CARD_PLAYED 全覆盖断言；
 *    token 不入组，由第 3 段英雄技能用例单独覆盖）；
 * 3. 关键事件：每张卡在受控局面下经 engine.applyAction 实打，断言效果原语的关键事件
 *    与状态增量（潜行现身 / 亡语召唤 token / 战吼治疗 / MP20 双芯 + 跳闸 /
 *    全大核超频 / 硬件光追指定直伤 + 全场掉帧 / 小核海召唤 / 刷机复活 /
 *    云手机集群 4 连召 / 英雄技能召唤 1/1 token / 低费曲线联合出牌）；
 * 4. 非法操作：INSUFFICIENT_MANA / INVALID_TARGET（池外目标）/ NOT_YOUR_TURN 三类拒绝
 *    （潜行目标的 stealth_hidden 拒绝见 Mali-400 用例）。
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
import defMaliReference from '../../../content/cards/arm/arm-mali-reference.json'
import defMali400 from '../../../content/cards/arm/arm-mali-400.json'
import defHelioG99 from '../../../content/cards/arm/arm-helio-g99.json'
import defCortexA55 from '../../../content/cards/arm/arm-cortex-a55.json'
import defMaliG710 from '../../../content/cards/arm/arm-mali-g710.json'
import defExynos8895 from '../../../content/cards/arm/arm-exynos-8895.json'
import defDimensity9300 from '../../../content/cards/arm/arm-dimensity-9300.json'
import defImmortalisG925 from '../../../content/cards/arm/arm-immortalis-g925.json'
import defLineageos from '../../../content/cards/arm/arm-lineageos.json'
import defNeoverse from '../../../content/cards/arm/arm-neoverse.json'
// 预组卡组引用的其他派系已注册卡（deck 合法性闸门需要其定义在场）
import defNeutralGt1030 from '../../../content/cards/neutral/neutral-gt-1030.json'
import defIntelUhd770 from '../../../content/cards/intel/intel-uhd-770.json'
import defNeutralP106 from '../../../content/cards/neutral/neutral-p106-100.json'
import defIntelA380 from '../../../content/cards/intel/intel-arc-a380.json'
import defIntelHotfix from '../../../content/cards/intel/intel-driver-hotfix.json'
import defNeutralFurmark from '../../../content/cards/neutral/neutral-furmark.json'
import defNeutralG502 from '../../../content/cards/neutral/neutral-g502-hero.json'
import defIntelIgpuRescue from '../../../content/cards/intel/intel-igpu-rescue.json'
import armDeckJson from '../../../content/decks/arm-reference-swarm.json'

/** JSON → CardDefinition：结构合法性由 findCardDefinitionIssues 运行期闸门把关 */
const DEFS: readonly CardDefinition[] = [
  defMaliReference,
  defMali400,
  defHelioG99,
  defCortexA55,
  defMaliG710,
  defExynos8895,
  defDimensity9300,
  defImmortalisG925,
  defLineageos,
  defNeoverse,
] as unknown as readonly CardDefinition[]

/** 预组卡组的跨派系填充卡（nvidia/amd/intel 批次已注册，此处仅为 deck 闸门补注册） */
const FILLER_DEFS: readonly CardDefinition[] = [
  defNeutralGt1030,
  defIntelUhd770,
  defNeutralP106,
  defIntelA380,
  defIntelHotfix,
  defNeutralFurmark,
  defNeutralG502,
  defIntelIgpuRescue,
] as unknown as readonly CardDefinition[]

registerCardDefinitions(DEFS)
registerCardDefinitions(FILLER_DEFS)

const DEFS_BY_ID = new Map([...DEFS, ...FILLER_DEFS].map((def) => [def.id, def]))
const ALL_IDS = DEFS.map((def) => def.id)
/** 可收集卡（token 不入组、不可从手牌打出，由英雄技能用例单独覆盖） */
const COLLECTIBLE_IDS = ALL_IDS.filter((id) => id !== 'arm-mali-reference')

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

/** 真实开局配置：双方 arm（内置技能「公版方案」随引擎加载自动注册），卡组 = 预组 arm-reference-swarm */
function armSetup(): GameSetup {
  const deck: DeckSpec = { cards: armDeckJson.cards as DeckSpec['cards'] }
  return {
    seed: 20261004,
    players: [
      { id: 'P1', faction: 'arm', deck },
      { id: 'P2', faction: 'arm', deck },
    ],
  }
}

/**
 * 覆盖扫描专用配置：9 张可收集卡 ×2 + smoke-gpu ×12 = 30。
 * 不直接用预组卡组——预组以 token 召唤卡为主，会把己方扩展槽灌满，
 * 高费 SoC（150-200W）在 ownUnits≥5 的门槛下整局难以上手，扫描覆盖会饿死。
 */
function scanSetup(): GameSetup {
  const deck: DeckSpec = {
    cards: [
      ...COLLECTIBLE_IDS.map((cardId) => ({ cardId, count: 2 })),
      { cardId: 'smoke-gpu', count: DECK_SIZE - COLLECTIBLE_IDS.length * 2 },
    ],
  }
  return {
    seed: 20261004,
    players: [
      { id: 'P1', faction: 'arm', deck },
      { id: 'P2', faction: 'arm', deck },
    ],
  }
}

describe('M4-CNT5 arm 批次：schema 闸门', () => {
  it('10 张定义全部合法：cardId 前缀、cost 区间、稀有度梯度（含传说）、低费曲线抽查', () => {
    expect(DEFS).toHaveLength(10)
    expect(new Set(ALL_IDS).size).toBe(10)
    for (const def of DEFS) {
      expect(def.id).toMatch(/^arm-/)
      expect(findCardDefinitionIssues(def)).toBeNull()
      expect(def.cost).toBeGreaterThanOrEqual(100)
      expect(def.cost).toBeLessThanOrEqual(MAX_MANA)
    }
    expect(new Set(DEFS.map((def) => def.rarity)).size).toBeGreaterThanOrEqual(3)
    expect(DEFS.some((def) => def.rarity === 'legendary')).toBe(true)
    // 低费快攻曲线抽查：手机 SoC 真实功耗贴地板（W→W 直译，5-15W 全部落 100-150）
    expect(DEFS_BY_ID.get('arm-mali-400')?.cost).toBe(100)
    expect(DEFS_BY_ID.get('arm-dimensity-9300')?.cost).toBe(150)
    expect(DEFS_BY_ID.get('arm-immortalis-g925')?.cost).toBe(200)
    expect(DEFS_BY_ID.get('arm-neoverse')?.cost).toBe(300)
  })

  it('token 卡按 M4-CNT5 拍板规格落盘：公版亮机卡 100W 1/1，无 effect，不入任何卡组', () => {
    const token = DEFS_BY_ID.get('arm-mali-reference')
    expect(token).toBeDefined()
    expect(token).toMatchObject({
      id: 'arm-mali-reference',
      name: '公版亮机卡',
      faction: 'arm',
      type: 'gpu',
      cost: 100,
      attack: 1,
      health: 1,
      rarity: 'common',
    })
    expect(token?.effect).toBeUndefined() // 英雄技能召唤物，无自有效果
    expect(token?.keywords ?? []).toEqual([])
    // 预组卡组不含 token（英雄技能专属，不占卡组名额）
    expect(armDeckJson.cards.some((entry) => entry.cardId === 'arm-mali-reference')).toBe(false)
  })

  it('预组 arm-reference-swarm：总数恰 30、同名 ≤2、全部 cardId 已注册，initGame arm vs arm 可开局', () => {
    const total = armDeckJson.cards.reduce((sum, entry) => sum + entry.count, 0)
    expect(total).toBe(DECK_SIZE)
    for (const entry of armDeckJson.cards) {
      expect(entry.count).toBeGreaterThanOrEqual(1)
      expect(entry.count).toBeLessThanOrEqual(2)
      expect(DEFS_BY_ID.has(entry.cardId)).toBe(true)
    }
    const state = engine.initGame(armSetup())
    expect(state.players.P1.hand).toHaveLength(3)
    expect(state.players.P2.hand).toHaveLength(3)
    expect(state.players.P1.deck).toHaveLength(DECK_SIZE - 3)
    expect(state.turn).toBe(1)
    expect(state.activePlayer).toBe('P1')
  })
})

describe('M4-CNT5 arm 批次：实打覆盖扫描', () => {
  it('seed 对局实打：9 张可收集卡全部至少被打出一次（CARD_PLAYED 事件覆盖）', () => {
    let state = engine.initGame(scanSetup())
    const played = new Set<string>()
    const cardIdOfUid = (s: GameState, uid: string): string | undefined =>
      [...s.players.P1.hand, ...s.players.P2.hand].find((card) => card.uid === uid)?.cardId
    const typeOfUid = (s: GameState, uid: string): string | undefined => {
      const cardId = cardIdOfUid(s, uid)
      return cardId ? DEFS_BY_ID.get(cardId)?.type : undefined
    }

    // 循环闸门按「可收集卡覆盖数」计——smoke-gpu 等填充牌不计入，防止提前收工
    const uncovered = (): number => COLLECTIBLE_IDS.filter((id) => !played.has(id)).length
    for (let i = 0; i < 400 && uncovered() > 0; i += 1) {
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
      // 优先打出未见过的牌：driver 不占槽先行；单位牌只留一个槽位余量（本批以
      // token 召唤卡为主，5 槽门槛会让 150-200W 的 SoC 整局卡在手里，覆盖饿死）
      const pick =
        fresh.find((action) => typeOfUid(state, action.uid) === 'driver') ??
        (ownUnits < 6 ? fresh.find((action) => typeOfUid(state, action.uid) !== 'driver') : undefined) ??
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

    expect(COLLECTIBLE_IDS.filter((id) => !played.has(id))).toEqual([])
  })
})

describe('M4-CNT5 arm 批次：关键事件断言（小核海 token 线）', () => {
  it('英雄技能「公版方案」：召唤 1/1 公版亮机卡上场（召唤失调，当回合不可攻击）', () => {
    const state = makeGameState({
      activePlayer: 'P1',
      players: {
        P1: {
          ...makePlayer('P1', { faction: 'arm' }),
          mana: 200,
          maxMana: 200,
          deck: FILLER_DECK,
        },
        P2: { ...makePlayer('P2'), deck: FILLER_DECK },
      },
    })
    const result = engine.applyAction(state, { type: 'USE_HERO_POWER', playerId: 'P1' })
    expect(result.events[0]).toMatchObject({
      type: 'HERO_POWER_USED',
      playerId: 'P1',
      skillId: 'reference_design',
    })
    const token = result.state.board.find((unit) => unit.cardId === 'arm-mali-reference')
    expect(token).toMatchObject({
      ownerId: 'P1',
      attack: 1,
      health: 1,
      maxHealth: 1,
      keywords: [],
      attacksRemaining: 0, // 召唤失调
    })
    expect(result.events.find((event) => event.type === 'MINION_SUMMONED')).toMatchObject({ source: 'effect' })
    expect(result.state.players.P1.mana).toBe(0) // 200W 供出「公版方案」
  })

  it('Helio G99：钉子户亡语——阵亡时召唤 1/1 公版亮机卡继位', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 6,
      health: 5,
      maxHealth: 5,
    })
    const state = ctlState({ hand: [handOf('arm-helio-g99')], board: [foe] })
    const played = playP1(state, 'hand-arm-helio-g99')
    const g99Id = played.state.board.find((unit) => unit.cardId === 'arm-helio-g99')!.instanceId
    expect(played.state.board.find((unit) => unit.instanceId === g99Id)).toMatchObject({
      attack: 2,
      health: 2,
      keywords: ['deathrattle'],
    })
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const killed = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef(g99Id),
    })
    expect(killed.state.board.find((unit) => unit.instanceId === g99Id)).toBeUndefined()
    expect(killed.state.players.P1.graveyard).toContainEqual({
      instanceId: g99Id,
      cardId: 'arm-helio-g99',
    })
    expect(killed.events.find((event) => event.type === 'MINION_DIED')).toMatchObject({ cause: 'damage' })
    expect(killed.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'deathrattle',
    })
    const heir = killed.state.board.find((unit) => unit.cardId === 'arm-mali-reference')
    expect(heir).toMatchObject({ ownerId: 'P1', attack: 1, health: 1, maxHealth: 1 })
    expect(killed.events.find((event) => event.type === 'MINION_SUMMONED')).toMatchObject({
      source: 'effect',
      unit: { cardId: 'arm-mali-reference' },
    })
  })

  it('Cortex-A55 四小核：小核海开工——打出即召唤 2 只 1/1 公版亮机卡', () => {
    const state = ctlState({ hand: [handOf('arm-cortex-a55')] })
    const played = playP1(state, 'hand-arm-cortex-a55')
    const summons = played.events.filter((event) => event.type === 'MINION_SUMMONED')
    expect(summons).toHaveLength(2)
    for (const summon of summons) {
      expect(summon).toMatchObject({
        source: 'effect',
        unit: { cardId: 'arm-mali-reference', ownerId: 'P1', attack: 1, health: 1 },
      })
    }
    expect(played.state.board).toHaveLength(2)
    expect(played.state.players.P1.mana).toBe(MAX_MANA - 100)
  })

  it('Neoverse 云手机集群：一台物理机切四份——300W 召唤 4 只 1/1 token', () => {
    const state = ctlState({ hand: [handOf('arm-neoverse')] })
    const played = playP1(state, 'hand-arm-neoverse')
    const summons = played.events.filter((event) => event.type === 'MINION_SUMMONED')
    expect(summons).toHaveLength(4)
    for (const summon of summons) {
      expect(summon).toMatchObject({ source: 'effect', unit: { cardId: 'arm-mali-reference', ownerId: 'P1' } })
    }
    expect(played.state.board).toHaveLength(4)
    expect(played.state.players.P1.mana).toBe(MAX_MANA - 300)
  })

  it('LineageOS 刷机包：EOL 设备续命——从墓地捞回最近阵亡的显卡（新实例、离墓）', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 6,
      health: 5,
      maxHealth: 5,
    })
    // 殉爆品用 Helio G99（非潜行；Mali-400 隐身状态下不可被指定，换不死）
    const state = ctlState({
      hand: [handOf('arm-helio-g99'), handOf('arm-lineageos')],
      board: [foe],
    })
    // 第一回合：Helio G99 上场
    const played = playP1(state, 'hand-arm-helio-g99')
    const g99Id = played.state.board.find((unit) => unit.cardId === 'arm-helio-g99')!.instanceId
    // P2 回合：G99 被换死，进墓地（亡语 token 上场不进墓，不影响候选）
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const traded = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef(g99Id),
    })
    expect(traded.state.board.find((unit) => unit.instanceId === g99Id)).toBeUndefined()
    expect(traded.state.players.P1.graveyard).toContainEqual({ instanceId: g99Id, cardId: 'arm-helio-g99' })
    // 第二回合：刷机包复活最近阵亡的显卡
    const nextOwn = engine.applyAction(traded.state, { type: 'END_TURN', playerId: 'P2' })
    const revived = playP1(nextOwn.state, 'hand-arm-lineageos')
    const summoned = revived.events.find((event) => event.type === 'MINION_SUMMONED')
    expect(summoned).toMatchObject({ source: 'effect', unit: { cardId: 'arm-helio-g99', ownerId: 'P1' } })
    expect(summoned?.unit.instanceId).not.toBe(g99Id) // 复活 ≠ 原实例
    expect(revived.state.players.P1.graveyard).toHaveLength(0) // 复活即离墓
  })
})

describe('M4-CNT5 arm 批次：关键事件断言（SoC 主力曲线）', () => {
  it('Mali-400：万年常青无输出亮机（stealth）——现身前不可被攻击，攻击后现身', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('arm-mali-400')], board: [foe] })
    const played = playP1(state, 'hand-arm-mali-400')
    const maliId = played.state.board.find((unit) => unit.cardId === 'arm-mali-400')!.instanceId
    expect(played.state.board.find((unit) => unit.instanceId === maliId)).toMatchObject({
      attack: 1,
      health: 3,
      keywords: ['stealth'],
    })
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const hidden = catchRuleError(() =>
      engine.applyAction(p2Turn.state, {
        type: 'ATTACK',
        playerId: 'P2',
        attackerId: 'u-foe',
        target: unitRef(maliId),
      }),
    )
    expect(hidden.code).toBe('INVALID_TARGET')
    expect(hidden.detail).toMatchObject({ reason: 'stealth_hidden' })
    const nextOwn = engine.applyAction(p2Turn.state, { type: 'END_TURN', playerId: 'P2' })
    const revealed = engine.applyAction(nextOwn.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: maliId,
      target: heroRef('P2'),
    })
    expect(revealed.state.players.P2.health).toBe(29) // 30 − 1（亮机卡的卑微输出）
    expect(revealed.state.board.find((unit) => unit.instanceId === maliId)?.keywords).toEqual([])
    expect(revealed.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'stealth',
    })
  })

  it('Exynos 8895：Mali-G71 MP20 双芯（windfury）+ 跳闸锁定 100W', () => {
    const state = ctlState({ hand: [handOf('arm-exynos-8895')] })
    const played = playP1(state, 'hand-arm-exynos-8895')
    const exynosId = played.state.board.find((unit) => unit.cardId === 'arm-exynos-8895')!.instanceId
    expect(played.state.board.find((unit) => unit.instanceId === exynosId)).toMatchObject({
      attack: 4,
      health: 2,
      keywords: ['windfury', 'overload'],
    })
    expect(played.state.players.P1.lockedMana).toBe(100) // 无显式 lockMana 步骤 → 默认锁定 100W
    // 下个自身回合：BURN_OUT 结算跳闸锁定
    const afterTurns = engine.applyAction(
      engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' }).state,
      { type: 'END_TURN', playerId: 'P2' },
    )
    expect(afterTurns.events.find((event) => event.type === 'BURN_OUT')).toMatchObject({
      playerId: 'P1',
      lockedMana: 100,
    })
    expect(afterTurns.state.players.P1.mana).toBe(100) // maxMana 200 − 锁定 100
    expect(afterTurns.state.players.P1.lockedMana).toBe(0)
    // 20 核火力：每回合两次攻击
    const swing1 = engine.applyAction(afterTurns.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: exynosId,
      target: heroRef('P2'),
    })
    expect(swing1.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(swing1.state.players.P2.health).toBe(26)
    const swing2 = engine.applyAction(swing1.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: exynosId,
      target: heroRef('P2'),
    })
    expect(swing2.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(swing2.state.players.P2.health).toBe(22) // 30 − 4 × 2
    expect(swing2.state.board.find((unit) => unit.instanceId === exynosId)).toMatchObject({
      health: 2, // 打脸无反伤
      attacksRemaining: 0,
    })
  })

  it('天玑 9300：全大核（charge）——入场当回合即可攻击', () => {
    const state = ctlState({ hand: [handOf('arm-dimensity-9300')] })
    const played = playP1(state, 'hand-arm-dimensity-9300')
    const socId = played.state.board.find((unit) => unit.cardId === 'arm-dimensity-9300')!.instanceId
    expect(played.state.board.find((unit) => unit.instanceId === socId)).toMatchObject({
      attack: 4,
      health: 4,
      keywords: ['charge'],
    })
    const attacked = engine.applyAction(played.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: socId,
      target: heroRef('P2'),
    })
    expect(attacked.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(attacked.state.players.P2.health).toBe(26) // 30 − 4
  })

  it('Immortalis-G925：手机硬件光追（传说位）——指定目标直伤 2 + 全场敌方掉帧 1', () => {
    const foe1 = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe1',
      cardId: 'smoke-gpu',
      attack: 3,
      health: 3,
      maxHealth: 3,
    })
    const foe2 = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe2',
      cardId: 'smoke-gpu',
      attack: 2,
      health: 4,
      maxHealth: 4,
    })
    const state = ctlState({ hand: [handOf('arm-immortalis-g925')], board: [foe1, foe2] })
    const played = playP1(state, 'hand-arm-immortalis-g925', unitRef('u-foe1'))
    expect(played.state.board.find((unit) => unit.cardId === 'arm-immortalis-g925')).toMatchObject({
      attack: 5,
      health: 5,
    })
    // 指定光追直伤 2：u-foe1 3 → 1
    const chosen = played.events.find(
      (event) => event.type === 'DAMAGE_DEALT' && event.target.kind === 'unit' && event.target.instanceId === 'u-foe1',
    )
    expect(chosen).toMatchObject({ amount: 2, remainingHealth: 1 })
    // 全场掉帧 1：u-foe1 1 → 0 阵亡；u-foe2 4 → 3
    const aoe1 = played.events.find(
      (event) =>
        event.type === 'DAMAGE_DEALT' &&
        event.target.kind === 'unit' &&
        event.target.instanceId === 'u-foe1' &&
        event.amount === 1,
    )
    expect(aoe1).toMatchObject({ remainingHealth: 0 })
    expect(played.state.board.find((unit) => unit.instanceId === 'u-foe1')).toBeUndefined()
    expect(played.state.board.find((unit) => unit.instanceId === 'u-foe2')).toMatchObject({ health: 3 })
    expect(played.events.find((event) => event.type === 'MINION_DIED')).toMatchObject({
      cause: 'damage',
      unit: { instanceId: 'u-foe1' },
    })
  })

  it('Mali-G710：能效比翻身仗——战吼为自家 CPU 回 2 点体质', () => {
    const state = ctlState({ hand: [handOf('arm-mali-g710')] })
    state.players.P1.health = 25 // 先热身：CPU 已被灼烧
    const played = playP1(state, 'hand-arm-mali-g710')
    expect(played.state.players.P1.health).toBe(27)
    expect(played.events.find((event) => event.type === 'HEALING')).toMatchObject({
      target: { kind: 'hero', playerId: 'P1' },
      amount: 2,
      resultingHealth: 27,
    })
    expect(played.state.board.find((unit) => unit.cardId === 'arm-mali-g710')).toMatchObject({
      attack: 3,
      health: 4,
    })
  })

  it('极低费快攻曲线：Mali-400 + Cortex-A55 + Mali-G710 一回合连出，350W 三件事', () => {
    const state = ctlState({
      hand: [handOf('arm-mali-400'), handOf('arm-cortex-a55'), handOf('arm-mali-g710')],
    })
    let cursor = playP1(state, 'hand-arm-mali-400').state
    cursor = playP1(cursor, 'hand-arm-cortex-a55').state
    const played = playP1(cursor, 'hand-arm-mali-g710')
    expect(played.state.players.P1.mana).toBe(MAX_MANA - 100 - 100 - 150)
    expect(played.state.board.map((unit) => unit.cardId)).toEqual([
      'arm-mali-400',
      'arm-mali-reference',
      'arm-mali-reference',
      'arm-mali-g710',
    ])
  })
})

describe('M4-CNT5 arm 批次：非法操作拒绝（§3 错误码）', () => {
  it('供电不足：100W 供不出 200W 的 Immortalis-G925 → INSUFFICIENT_MANA', () => {
    const state = ctlState({ hand: [handOf('arm-immortalis-g925')], manaP1: 100 })
    const error = catchRuleError(() => playP1(state, 'hand-arm-immortalis-g925'))
    expect(error.code).toBe('INSUFFICIENT_MANA')
  })

  it('池外目标：硬件光追指定己方显卡 / 敌方 CPU → INVALID_TARGET（not_in_pool）', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'smoke-gpu',
      attack: 2,
      health: 2,
      maxHealth: 2,
    })
    const state = ctlState({ hand: [handOf('arm-immortalis-g925')], board: [ally] })
    const ownTarget = catchRuleError(() => playP1(state, 'hand-arm-immortalis-g925', unitRef('u-ally')))
    expect(ownTarget.code).toBe('INVALID_TARGET')
    expect(ownTarget.detail).toMatchObject({ reason: 'not_in_pool', pool: 'enemyUnits' })
    const heroTarget = catchRuleError(() =>
      playP1(state, 'hand-arm-immortalis-g925', heroRef('P2')),
    )
    expect(heroTarget.code).toBe('INVALID_TARGET')
    expect(heroTarget.detail).toMatchObject({ reason: 'not_in_pool', pool: 'enemyUnits' })
  })

  it('不是你的回合：P2 回合代打 P1 的牌 → NOT_YOUR_TURN', () => {
    const state = ctlState({ hand: [handOf('arm-mali-400')], activePlayer: 'P2' })
    const error = catchRuleError(() =>
      engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'hand-arm-mali-400' }),
    )
    expect(error.code).toBe('NOT_YOUR_TURN')
  })
})
