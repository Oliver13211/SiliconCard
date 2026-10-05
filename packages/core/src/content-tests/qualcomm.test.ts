/**
 * M4-CNT5（Qualcomm / Adreno 批次）卡池验收 —— packages/content/cards/qualcomm/ 的 10 张卡
 * + 预组卡组 packages/content/decks/qualcomm-ai-everything.json（万物皆 AI）。
 *
 * 验收口径照抄 nvidia.test.ts 四段（WF-CARD 三件套之「单测」，效果一律声明式
 * EffectSpec 原语组合，零新 handler）：
 * 1. schema 闸门：10 张定义全部通过 findCardDefinitionIssues（引擎消费字段结构校验），
 *    cardId 统一 qualcomm- 前缀、cost ∈ [100,1000]（引擎 cost=瓦数：手机/笔电 SoC 属
 *    低功耗档，按「进牌组最低消费 100W」曲线折算，中低费曲线 100–200W）、稀有度含传说
 *    （骁龙 X Elite）；accessory 不携带攻血；Windows on ARM 的 overload 关键词与
 *    lockMana 步骤自洽（§7 N 来源）；
 * 2. 实打覆盖：registerCardDefinitions 注册后经 createEngine 四函数真实开局
 *    （预组卡组 30 张 = 本批 10×2 + 中立填充 10×1，qualcomm vs intel 内置技能），
 *    seed 驱动的合法动作扫描把每张卡至少打出一次（CARD_PLAYED 事件全覆盖断言）；
 * 3. 关键事件：每张卡在受控局面下经 engine.applyAction 实打，断言效果原语的关键事件
 *    与状态增量（火龙战吼双向烧伤 / 45 TOPS 随机双份 AI 加成（种子确定性）/
 *    发布会数学自增益 / Always Connected 抽牌 + 潜行 / 清凉本治疗 / 掌机护甲 +
 *    信仰充值 / 外挂基带抽牌发热 / Adreno 月更抽二 + 随机负优化 / 兼容层跳闸 /
 *    Copilot+ 光环）；
 * 4. 非法操作：INSUFFICIENT_MANA / INVALID_TARGET（池外目标）/ NOT_YOUR_TURN 三类拒绝
 *    （8cx 潜行目标的 stealth_hidden 拒绝在关键事件段一并覆盖）。
 *
 * 本文件只读 content JSON；不修改 packages/core 任何既有文件。
 * qualcomm「TOPS 营销」英雄技能（buff random ownUnits +1/+1）由引擎 builtin 注册，
 * 语义与边界（空场可用但无事发生）已由 engine/factionsM4.test.ts 单独覆盖，本文件不重复。
 */

import { describe, expect, it } from 'vitest'
import { DECK_SIZE, MAX_MANA } from '../constants'
import type { Action, PlayerId, TargetRef } from '../types/actions'
import type { CardDefinition } from '../types/cards'
import type { BoardUnit, DeckEntry, DeckSpec, GameSetup, GameState, HandCard } from '../types/state'
import { createEngine } from '../engine/index'
import { registerCardDefinitions, findCardDefinitionIssues } from '../engine/registry'
import { createRng } from '../engine/prng'
import { catchRuleError, makeGameState, makePlayer, makeUnit, TEST_SEED } from '../testing/state'
import def888 from '../../../content/cards/qualcomm/qualcomm-snapdragon-888.json'
import defXElite from '../../../content/cards/qualcomm/qualcomm-snapdragon-x-elite.json'
import def8Gen3 from '../../../content/cards/qualcomm/qualcomm-snapdragon-8-gen-3.json'
import def8cx from '../../../content/cards/qualcomm/qualcomm-snapdragon-8cx.json'
import defXPlus from '../../../content/cards/qualcomm/qualcomm-snapdragon-x-plus.json'
import defG3x from '../../../content/cards/qualcomm/qualcomm-g3x-gen-2.json'
import defX55 from '../../../content/cards/qualcomm/qualcomm-x55-modem.json'
import defAdreno from '../../../content/cards/qualcomm/qualcomm-adreno-driver.json'
import defWinOnArm from '../../../content/cards/qualcomm/qualcomm-windows-on-arm.json'
import defCopilot from '../../../content/cards/qualcomm/qualcomm-copilot-plus-pc.json'
// —— 预组卡组的中立填充（只注册以支撑 initGame 卡组校验，验收对象仍是本批 10 张）——
import defNeutralGt1030 from '../../../content/cards/neutral/neutral-gt-1030.json'
import defNeutralFurmark from '../../../content/cards/neutral/neutral-furmark.json'
import defNeutralBarracuda from '../../../content/cards/neutral/neutral-barracuda-2tb.json'
import defNeutralP106 from '../../../content/cards/neutral/neutral-p106-100.json'
import defNeutralG502 from '../../../content/cards/neutral/neutral-g502-hero.json'
import defNeutralB650m from '../../../content/cards/neutral/neutral-b650m-plus.json'
import defNeutralNhd15 from '../../../content/cards/neutral/neutral-nh-d15.json'
import defNeutral990Pro from '../../../content/cards/neutral/neutral-990-pro.json'
import defNeutralCherry from '../../../content/cards/neutral/neutral-cherry-mx-8-0.json'
import defNeutralDxracer from '../../../content/cards/neutral/neutral-dxracer-king.json'
import deckJson from '../../../content/decks/qualcomm-ai-everything.json'

/** JSON → CardDefinition：结构合法性由 findCardDefinitionIssues 运行期闸门把关 */
const DEFS: readonly CardDefinition[] = [
  def888,
  defXElite,
  def8Gen3,
  def8cx,
  defXPlus,
  defG3x,
  defX55,
  defAdreno,
  defWinOnArm,
  defCopilot,
] as unknown as readonly CardDefinition[]

const NEUTRAL_DEFS = [
  defNeutralGt1030,
  defNeutralFurmark,
  defNeutralBarracuda,
  defNeutralP106,
  defNeutralG502,
  defNeutralB650m,
  defNeutralNhd15,
  defNeutral990Pro,
  defNeutralCherry,
  defNeutralDxracer,
] as unknown as readonly CardDefinition[]

registerCardDefinitions([...DEFS, ...NEUTRAL_DEFS])

const DEFS_BY_ID = new Map(DEFS.map((def) => [def.id, def]))
const ALL_IDS = DEFS.map((def) => def.id)
const NEUTRAL_IDS = NEUTRAL_DEFS.map((def) => def.id)

/** 预组卡组 JSON（交付物 3）：结构校验见 schema 闸门段，组成即实打扫描的对局卡组 */
const DECK = deckJson as unknown as {
  id: string
  name: string
  faction: string
  cards: ReadonlyArray<{ cardId: string; count: number }>
}

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
  healthP1?: number
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
        ...(opts.healthP1 !== undefined ? { health: opts.healthP1 } : {}),
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

/** 真实开局配置：预组卡组 30 张，qualcomm vs intel（内置派系技能随引擎加载自动注册） */
function aiEverythingSetup(seed = 20261004): GameSetup {
  const deck: DeckSpec = { cards: DECK.cards.map((entry) => ({ cardId: entry.cardId, count: entry.count })) }
  return {
    seed,
    players: [
      { id: 'P1', faction: 'qualcomm', deck },
      { id: 'P2', faction: 'intel', deck },
    ],
  }
}

describe('M4-CNT5 qualcomm 批次：schema 闸门', () => {
  it('10 张定义全部合法：cardId 前缀、cost 区间、稀有度梯度（含传说）、类型分布', () => {
    expect(DEFS).toHaveLength(10)
    expect(new Set(ALL_IDS).size).toBe(10)
    for (const def of DEFS) {
      expect(def.id).toMatch(/^qualcomm-/)
      expect(findCardDefinitionIssues(def)).toBeNull()
      expect(def.cost).toBeGreaterThanOrEqual(100)
      expect(def.cost).toBeLessThanOrEqual(MAX_MANA)
    }
    expect(new Set(DEFS.map((def) => def.rarity)).size).toBeGreaterThanOrEqual(3)
    expect(DEFS.some((def) => def.rarity === 'legendary')).toBe(true)
    // 类型分布：gpu ×6 / driver ×2 / accessory ×2；accessory 不携带攻血（闸门已查，双保险）
    const typeOf = (id: string) => DEFS_BY_ID.get(id)?.type
    expect(ALL_IDS.filter((id) => typeOf(id) === 'gpu')).toHaveLength(6)
    expect(ALL_IDS.filter((id) => typeOf(id) === 'driver')).toHaveLength(2)
    expect(ALL_IDS.filter((id) => typeOf(id) === 'accessory')).toHaveLength(2)
    for (const def of DEFS.filter((d) => d.type !== 'gpu')) {
      expect(def.attack).toBeUndefined()
      expect(def.health).toBeUndefined()
    }
  })

  it('中低费曲线（手机/笔电 SoC 折算：100W 起充、顶配 200W）：cost 定档抽查', () => {
    // 100W 最低消费档：8cx / X Plus / X55（真实功耗个位数到几十 W，进牌组按 100W 起充）
    expect(DEFS_BY_ID.get('qualcomm-snapdragon-8cx')?.cost).toBe(100)
    expect(DEFS_BY_ID.get('qualcomm-snapdragon-x-plus')?.cost).toBe(100)
    expect(DEFS_BY_ID.get('qualcomm-x55-modem')?.cost).toBe(100)
    // 150W 档：8 Gen 3 / G3x Gen 2 / Windows on ARM
    expect(DEFS_BY_ID.get('qualcomm-snapdragon-8-gen-3')?.cost).toBe(150)
    expect(DEFS_BY_ID.get('qualcomm-g3x-gen-2')?.cost).toBe(150)
    expect(DEFS_BY_ID.get('qualcomm-windows-on-arm')?.cost).toBe(150)
    // 200W 档：888（火龙加成）/ X Elite（传说位）/ Adreno 驱动 / Copilot+ PC
    expect(DEFS_BY_ID.get('qualcomm-snapdragon-888')?.cost).toBe(200)
    expect(DEFS_BY_ID.get('qualcomm-snapdragon-x-elite')?.cost).toBe(200)
    expect(DEFS_BY_ID.get('qualcomm-adreno-driver')?.cost).toBe(200)
    expect(DEFS_BY_ID.get('qualcomm-copilot-plus-pc')?.cost).toBe(200)
  })

  it('Windows on ARM：overload 关键词与 lockMana 步骤自洽（§7：N 由出牌时点 lockMana 步骤给出）', () => {
    const def = DEFS_BY_ID.get('qualcomm-windows-on-arm')
    expect(def?.keywords).toContain('overload')
    expect(def?.effect?.trigger).toBe('onPlay')
    const lock = def?.effect?.steps?.find((step) => step.op === 'lockMana')
    expect(lock).toMatchObject({ op: 'lockMana', player: 'sourceOwner', amount: 100 })
  })

  it('预组卡组 qualcomm-ai-everything：恰 30 张、同名 ≤2、20 张本批 + 10 张中立填充、全部已注册', () => {
    expect(DECK.faction).toBe('qualcomm')
    const total = DECK.cards.reduce((sum, entry) => sum + entry.count, 0)
    expect(total).toBe(DECK_SIZE)
    const registered = new Set([...ALL_IDS, ...NEUTRAL_IDS])
    let qualcommTotal = 0
    for (const entry of DECK.cards) {
      expect(entry.count).toBeGreaterThanOrEqual(1)
      expect(entry.count).toBeLessThanOrEqual(2)
      expect(registered.has(entry.cardId)).toBe(true)
      if (entry.cardId.startsWith('qualcomm-')) qualcommTotal += entry.count
    }
    expect(qualcommTotal).toBe(20)
  })

  it('预组卡组 30 张经 initGame 真实开局（qualcomm vs intel 内置技能）', () => {
    const state = engine.initGame(aiEverythingSetup())
    expect(state.players.P1.faction).toBe('qualcomm')
    expect(state.players.P2.faction).toBe('intel')
    expect(state.players.P1.hand).toHaveLength(3)
    expect(state.players.P2.hand).toHaveLength(3)
    expect(state.players.P1.deck).toHaveLength(DECK_SIZE - 3)
    expect(state.turn).toBe(1)
    expect(state.activePlayer).toBe('P1')
  })
})

describe('M4-CNT5 qualcomm 批次：实打覆盖扫描', () => {
  it('seed 对局实打：10 张卡全部至少被打出一次（CARD_PLAYED 事件覆盖，跨 seed 连局累积）', () => {
    const played = new Set<string>()
    const cardIdOfUid = (s: GameState, uid: string): string | undefined =>
      [...s.players.P1.hand, ...s.players.P2.hand].find((card) => card.uid === uid)?.cardId
    const typeOfUid = (s: GameState, uid: string): string | undefined => {
      const cardId = cardIdOfUid(s, uid)
      return cardId ? DEFS_BY_ID.get(cardId)?.type : undefined
    }

    // 单局对局可能先于抽完整卡组就终局（疲劳/磨血），故同卡组跨 seed 连开多局累积覆盖；
    // 每局内部仍是「seed 驱动的合法动作扫描」，动作序列确定、结果可复现。
    for (let game = 0; game < 8 && played.size < ALL_IDS.length; game += 1) {
      let state = engine.initGame(aiEverythingSetup(20261004 + game))
      for (let i = 0; i < 200 && played.size < ALL_IDS.length; i += 1) {
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
          for (const event of result.events) {
            if (event.type === 'CARD_PLAYED' && DEFS_BY_ID.has(event.cardId)) played.add(event.cardId)
          }
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
        for (const event of result.events) {
          if (event.type === 'CARD_PLAYED' && DEFS_BY_ID.has(event.cardId)) played.add(event.cardId)
        }
        state = result.state
      }
    }

    expect(ALL_IDS.filter((id) => !played.has(id))).toEqual([])
  })
})

describe('M4-CNT5 qualcomm 批次：关键事件断言（火龙 / TOPS / 发布会数学）', () => {
  it('骁龙 888：火龙战吼——指定一台显卡烤 2 点，自己主板也烤 2 点（DAMAGE_DEALT ×2）', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 3,
      health: 6,
      maxHealth: 6,
    })
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-888')], board: [foe] })
    const played = playP1(state, 'hand-qualcomm-snapdragon-888', unitRef('u-foe'))
    expect(played.state.board.find((unit) => unit.cardId === 'qualcomm-snapdragon-888')).toMatchObject({
      attack: 3,
      health: 4,
    })
    expect(played.events.map((event) => event.type)).toEqual([
      'CARD_PLAYED',
      'MINION_SUMMONED',
      'DAMAGE_DEALT',
      'DAMAGE_DEALT',
    ])
    const damages = played.events.filter((event) => event.type === 'DAMAGE_DEALT')
    expect(damages[0]).toMatchObject({
      source: { kind: 'effect', ref: 'qualcomm-snapdragon-888' },
      target: { kind: 'unit', instanceId: 'u-foe' },
      amount: 2,
      remainingHealth: 4,
    })
    expect(damages[1]).toMatchObject({
      source: { kind: 'effect', ref: 'qualcomm-snapdragon-888' },
      target: { kind: 'hero', playerId: 'P1' },
      amount: 2,
      remainingHealth: 28,
    })
    expect(played.state.players.P1.health).toBe(28)
    expect(played.state.players.P2.health).toBe(30) // chosen allUnits 不含英雄：火龙只烧设备
  })

  it('骁龙 X Elite（传说位）：45 TOPS 战吼随机一份 +1/+1——种子 RNG 按 board 序候选恰取', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'qualcomm-snapdragon-8cx',
      attack: 2,
      health: 2,
      maxHealth: 2,
    })
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-x-elite')], board: [ally] })
    const played = playP1(state, 'hand-qualcomm-snapdragon-x-elite')
    const elite = played.state.board.find((unit) => unit.cardId === 'qualcomm-snapdragon-x-elite')
    expect(elite).toBeDefined()
    // 候选 = ownUnits 池按 board 序（[u-ally, X Elite]）；一份 AI 加成消耗一次 RNG，
    // 用同一 PRNG 复算期望命中（与 engine/factionsM4.test.ts 的种子契约断言同款）
    const rng = createRng(TEST_SEED)
    const candidates = ['u-ally', elite!.instanceId]
    const pick = candidates[rng.nextInt(2)]
    const allyAfter = played.state.board.find((unit) => unit.instanceId === 'u-ally')
    const allyHits = pick === 'u-ally' ? 1 : 0
    expect(allyAfter).toMatchObject({
      attack: 2 + allyHits,
      health: 2 + allyHits,
      maxHealth: 2 + allyHits, // buff health 同步抬 maxHealth（buffUnit 语义）
    })
    const eliteHits = pick === elite!.instanceId ? 1 : 0
    expect(elite).toMatchObject({
      attack: 4 + eliteHits,
      health: 4 + eliteHits,
      maxHealth: 4 + eliteHits,
    })
    // buff 无目录事件：仅出牌 + 入场演出
    expect(played.events.map((event) => event.type)).toEqual(['CARD_PLAYED', 'MINION_SUMMONED'])
  })

  it('骁龙 8 Gen 3：战吼给自己 +1 攻——「较上一代提升 50%」的发布会数学（2 攻 → 3 攻）', () => {
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-8-gen-3')] })
    const played = playP1(state, 'hand-qualcomm-snapdragon-8-gen-3')
    expect(played.state.board.find((unit) => unit.cardId === 'qualcomm-snapdragon-8-gen-3')).toMatchObject({
      attack: 3, // 2 + 1（self 池 buff，血量不动）
      health: 4,
      maxHealth: 4,
    })
    expect(played.state.players.P1.mana).toBe(MAX_MANA - 150)
  })

  it('骁龙 888 火龙战吼漏烤：无目标可选时整牌不可出（target_required），不烧自己主板', () => {
    // chosen allUnits 在空场无候选：getLegalActions 不产生 888 的动作（与「出牌需指定目标」一致）
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-888')] })
    const plays = engine
      .getLegalActions(state, 'P1')
      .filter((action): action is Extract<Action, { type: 'PLAY_CARD' }> => action.type === 'PLAY_CARD')
    expect(plays).toEqual([])
    const error = catchRuleError(() => playP1(state, 'hand-qualcomm-snapdragon-888'))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'target_required', pools: ['allUnits'] })
  })
})

describe('M4-CNT5 qualcomm 批次：关键事件断言（Always Connected / 清凉本 / 掌机）', () => {
  it('骁龙 8cx：Always Connected 战吼抽 1 + 无输出亮机（stealth）——现身前不可被攻击', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({
      hand: [handOf('qualcomm-snapdragon-8cx')],
      board: [foe],
      deckP1: ['smoke-gpu'],
    })
    const played = playP1(state, 'hand-qualcomm-snapdragon-8cx')
    const cxId = played.state.board.find((unit) => unit.cardId === 'qualcomm-snapdragon-8cx')!.instanceId
    expect(played.events.map((event) => event.type)).toEqual([
      'CARD_PLAYED',
      'MINION_SUMMONED',
      'CARD_DRAWN',
    ])
    expect(played.events.find((event) => event.type === 'CARD_DRAWN')).toMatchObject({
      playerId: 'P1',
      cardId: 'smoke-gpu',
      source: 'deck',
    })
    expect(played.state.board.find((unit) => unit.instanceId === cxId)?.keywords).toEqual(['stealth'])
    // 敌方潜行拦截：P2 回合攻击 8cx → INVALID_TARGET{stealth_hidden}
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const hidden = catchRuleError(() =>
      engine.applyAction(p2Turn.state, {
        type: 'ATTACK',
        playerId: 'P2',
        attackerId: 'u-foe',
        target: unitRef(cxId),
      }),
    )
    expect(hidden.code).toBe('INVALID_TARGET')
    expect(hidden.detail).toMatchObject({ reason: 'stealth_hidden' })
  })

  it('骁龙 X Plus：手机 SoC 下放笔电——战吼治疗己方 CPU 3 点（HEALING，满血不回）', () => {
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-x-plus')], healthP1: 26 })
    const played = playP1(state, 'hand-qualcomm-snapdragon-x-plus')
    expect(played.events.find((event) => event.type === 'HEALING')).toMatchObject({
      target: { kind: 'hero', playerId: 'P1' },
      amount: 3,
      resultingHealth: 29,
    })
    expect(played.state.players.P1.health).toBe(29)
    expect(played.state.board.find((unit) => unit.cardId === 'qualcomm-snapdragon-x-plus')).toMatchObject({
      attack: 2,
      health: 3,
    })
    // 满血时治疗不白发（无 HEALING 事件）
    const fresh = playP1(ctlState({ hand: [handOf('qualcomm-snapdragon-x-plus')] }), 'hand-qualcomm-snapdragon-x-plus')
    expect(fresh.events.find((event) => event.type === 'HEALING')).toBeUndefined()
    expect(fresh.state.players.P1.health).toBe(30)
  })

  it('骁龙 G3x Gen 2：掌机信仰充值（taunt）+ 风扇背夹护甲 +2（ARMOR_GAINED）', () => {
    const state = ctlState({ hand: [handOf('qualcomm-g3x-gen-2')] })
    const played = playP1(state, 'hand-qualcomm-g3x-gen-2')
    expect(played.state.board.find((unit) => unit.cardId === 'qualcomm-g3x-gen-2')).toMatchObject({
      attack: 2,
      health: 4,
      keywords: ['taunt'],
    })
    expect(played.events.find((event) => event.type === 'ARMOR_GAINED')).toMatchObject({
      playerId: 'P1',
      amount: 2,
      totalArmor: 2,
    })
    expect(played.state.players.P1.armor).toBe(2)
  })
})

describe('M4-CNT5 qualcomm 批次：关键事件断言（基带 / 驱动 / 兼容层 / Copilot+）', () => {
  it('骁龙 X55 基带：外挂基带——战吼 5G 全速抽 1 张，掌心发热自伤 1 点（0/1 配件占槽不可攻击）', () => {
    const state = ctlState({ hand: [handOf('qualcomm-x55-modem')], deckP1: ['smoke-gpu'] })
    const played = playP1(state, 'hand-qualcomm-x55-modem')
    expect(played.events.map((event) => event.type)).toEqual([
      'CARD_PLAYED',
      'MINION_SUMMONED',
      'CARD_DRAWN',
      'DAMAGE_DEALT',
    ])
    expect(played.events.find((event) => event.type === 'MINION_SUMMONED')).toMatchObject({ source: 'play' })
    expect(played.events.find((event) => event.type === 'CARD_DRAWN')).toMatchObject({
      playerId: 'P1',
      cardId: 'smoke-gpu',
    })
    expect(played.events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({
      source: { kind: 'effect', ref: 'qualcomm-x55-modem' },
      target: { kind: 'hero', playerId: 'P1' },
      amount: 1,
      remainingHealth: 29,
    })
    expect(played.state.players.P1.health).toBe(29)
    expect(played.state.board.find((unit) => unit.cardId === 'qualcomm-x55-modem')).toMatchObject({
      attack: 0,
      health: 1,
      attacksRemaining: 0, // 配件不可攻击（§4）
    })
  })

  it('Adreno 驱动：月更抽 2 张 + 随机一台己方显卡吃 1 点负优化彩蛋', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({
      hand: [handOf('qualcomm-adreno-driver')],
      board: [ally],
      deckP1: ['smoke-gpu', 'smoke-gpu'],
    })
    const played = playP1(state, 'hand-qualcomm-adreno-driver')
    expect(played.events.map((event) => event.type)).toEqual([
      'CARD_PLAYED',
      'CARD_DRAWN',
      'CARD_DRAWN',
      'DAMAGE_DEALT',
    ])
    expect(played.state.players.P1.hand.map((card) => card.cardId)).toEqual(['smoke-gpu', 'smoke-gpu'])
    // 唯一在场己方单位即随机池唯一候选：u-ally 3 → 2 血（确定性断言，同 seed 可复现）
    expect(played.events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({
      source: { kind: 'effect', ref: 'qualcomm-adreno-driver' },
      target: { kind: 'unit', instanceId: 'u-ally' },
      amount: 1,
      remainingHealth: 2,
    })
    // 空场时随机池为空：抽 2 照常、负优化无事发生且不消耗 RNG（§5 随机语义）
    const empty = playP1(
      ctlState({ hand: [handOf('qualcomm-adreno-driver')], deckP1: ['smoke-gpu', 'smoke-gpu'] }),
      'hand-qualcomm-adreno-driver',
    )
    expect(empty.events.filter((event) => event.type === 'CARD_DRAWN')).toHaveLength(2)
    expect(empty.events.find((event) => event.type === 'DAMAGE_DEALT')).toBeUndefined()
  })

  it('Windows on ARM：兼容层指定任意角色烧 3 点 + 翻译损耗跳闸锁定 100W（下回合 BURN_OUT）', () => {
    const state = ctlState({ hand: [handOf('qualcomm-windows-on-arm')] })
    const played = playP1(state, 'hand-qualcomm-windows-on-arm', heroRef('P2'))
    expect(played.events.map((event) => event.type)).toEqual([
      'CARD_PLAYED',
      'DAMAGE_DEALT',
      'KEYWORD_TRIGGERED',
    ])
    expect(played.events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({
      source: { kind: 'effect', ref: 'qualcomm-windows-on-arm' },
      target: { kind: 'hero', playerId: 'P2' },
      amount: 3,
      remainingHealth: 27,
    })
    expect(played.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'overload',
    })
    expect(played.state.players.P2.health).toBe(27)
    expect(played.state.players.P1.lockedMana).toBe(100)
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
  })

  it('Copilot+ PC：万物皆 AI——配件 0/1 入场占扩展槽，光环为全体己方显卡 +1 血（含自身投影）', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'smoke-gpu',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('qualcomm-copilot-plus-pc')], board: [ally] })
    const played = playP1(state, 'hand-qualcomm-copilot-plus-pc')
    expect(played.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({
      attack: 4,
      health: 4, // 3 + 1（本地大模型兜底）
      maxHealth: 4,
    })
    expect(played.state.board.find((unit) => unit.cardId === 'qualcomm-copilot-plus-pc')).toMatchObject({
      attack: 0,
      health: 2, // 0/1 入场 + 自身光环投影
      maxHealth: 2,
      attacksRemaining: 0,
    })
    expect(played.events.map((event) => event.type)).toEqual(['CARD_PLAYED', 'MINION_SUMMONED'])
  })
})

describe('M4-CNT5 qualcomm 批次：非法操作拒绝（§3 错误码）', () => {
  it('供电不足：100W 供不出 200W 的骁龙 X Elite → INSUFFICIENT_MANA', () => {
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-x-elite')], manaP1: 100 })
    const error = catchRuleError(() => playP1(state, 'hand-qualcomm-snapdragon-x-elite'))
    expect(error.code).toBe('INSUFFICIENT_MANA')
  })

  it('池外目标：骁龙 888 火龙战吼指定对手 CPU → INVALID_TARGET（not_in_pool，allUnits 不含英雄）', () => {
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-888')] })
    const error = catchRuleError(() => playP1(state, 'hand-qualcomm-snapdragon-888', heroRef('P2')))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'not_in_pool', pool: 'allUnits' })
  })

  it('不是你的回合：P2 回合代打 P1 的骁龙 X Plus → NOT_YOUR_TURN', () => {
    const state = ctlState({ hand: [handOf('qualcomm-snapdragon-x-plus')], activePlayer: 'P2' })
    const error = catchRuleError(() =>
      engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'hand-qualcomm-snapdragon-x-plus' }),
    )
    expect(error.code).toBe('NOT_YOUR_TURN')
  })
})
