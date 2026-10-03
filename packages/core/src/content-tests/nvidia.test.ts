/**
 * M1-CNT（NVIDIA 批次）卡池验收 —— packages/content/cards/nvidia/ 的 15 张卡。
 *
 * 验收口径（WF-CARD 三件套之「单测」，效果一律声明式 EffectSpec 原语组合，零新 handler）：
 * 1. schema 闸门：15 张定义全部通过 findCardDefinitionIssues（引擎消费字段结构校验），
 *    cardId 统一 nvidia- 前缀、cost ∈ [100, 1000]（对齐真实 TDP，如 5090=575W）、稀有度含传说；
 * 2. 实打覆盖：registerCardDefinitions 注册后经 createEngine 四函数真实开局
 *    （15 张 ×2 = 30 张卡组，nvidia vs amd 内置技能），seed 驱动的合法动作扫描
 *    把每张卡至少打出一次（CARD_PLAYED 事件全覆盖断言）；
 * 3. 关键事件：每张卡在受控局面下经 engine.applyAction 实打，断言效果原语的关键事件
 *    与状态增量（战吼直伤 / 自伤 + 跳闸锁定 / 双芯 windfury / 信仰充值拦截 /
 *    矿卡亡语增益 / 无输出亮机潜行 / 帧生成 grantKeyword / 烧蚀摧毁 + 自伤 /
 *    DLSS 增益 / 负优化抽牌 + 随机伤害 / RGB 光环）；
 * 4. 非法操作：INSUFFICIENT_MANA / INVALID_TARGET（池外目标）/ NOT_YOUR_TURN 三类拒绝
 *    （潜行目标的 stealth_hidden 拒绝另见 GT 1030 用例）。
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
import defRtx5090 from '../../../content/cards/nvidia/nvidia-rtx-5090.json'
import defRtx5090d from '../../../content/cards/nvidia/nvidia-rtx-5090d.json'
import defRtx4090 from '../../../content/cards/nvidia/nvidia-rtx-4090.json'
import defTitanZ from '../../../content/cards/nvidia/nvidia-titan-z.json'
import defRtx5080 from '../../../content/cards/nvidia/nvidia-rtx-5080.json'
import defGtx480 from '../../../content/cards/nvidia/nvidia-gtx-480.json'
import defRtx5070 from '../../../content/cards/nvidia/nvidia-rtx-5070.json'
import defCmp170hx from '../../../content/cards/nvidia/nvidia-cmp-170hx.json'
import defRtx5060 from '../../../content/cards/nvidia/nvidia-rtx-5060.json'
import defGt1030 from '../../../content/cards/nvidia/nvidia-gt-1030.json'
import defMultiFrameGen from '../../../content/cards/nvidia/nvidia-multi-frame-gen.json'
import def12v2x6 from '../../../content/cards/nvidia/nvidia-12v-2x6.json'
import defDlssUpscale from '../../../content/cards/nvidia/nvidia-dlss-upscale.json'
import defGameReady from '../../../content/cards/nvidia/nvidia-game-ready-driver.json'
import defRgbGlow from '../../../content/cards/nvidia/nvidia-rgb-glow.json'

/** JSON → CardDefinition：结构合法性由 findCardDefinitionIssues 运行期闸门把关 */
const DEFS: readonly CardDefinition[] = [
  defRtx5090,
  defRtx5090d,
  defRtx4090,
  defTitanZ,
  defRtx5080,
  defGtx480,
  defRtx5070,
  defCmp170hx,
  defRtx5060,
  defGt1030,
  defMultiFrameGen,
  def12v2x6,
  defDlssUpscale,
  defGameReady,
  defRgbGlow,
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

/** 真实开局配置：15 张 ×2 = DECK_SIZE，nvidia vs amd（内置派系技能随引擎加载自动注册） */
function nvidiaSetup(): GameSetup {
  const deck: DeckSpec = { cards: ALL_IDS.map((cardId) => ({ cardId, count: 2 })) }
  return {
    seed: 20261003,
    players: [
      { id: 'P1', faction: 'nvidia', deck },
      { id: 'P2', faction: 'amd', deck },
    ],
  }
}

describe('M1-CNT nvidia 批次：schema 闸门', () => {
  it('15 张定义全部合法：cardId 前缀、cost 区间、稀有度梯度（含传说）、TDP 对齐抽查', () => {
    expect(DEFS).toHaveLength(15)
    expect(new Set(ALL_IDS).size).toBe(15)
    for (const def of DEFS) {
      expect(def.id).toMatch(/^nvidia-/)
      expect(findCardDefinitionIssues(def)).toBeNull()
      expect(def.cost).toBeGreaterThanOrEqual(100)
      expect(def.cost).toBeLessThanOrEqual(MAX_MANA)
    }
    expect(new Set(DEFS.map((def) => def.rarity)).size).toBeGreaterThanOrEqual(3)
    expect(DEFS.some((def) => def.rarity === 'legendary')).toBe(true)
    // TDP 对齐抽查（§4：费用曲线天然携带梗味）
    expect(DEFS_BY_ID.get('nvidia-rtx-5090')?.cost).toBe(575)
    expect(DEFS_BY_ID.get('nvidia-rtx-4090')?.cost).toBe(450)
    expect(DEFS_BY_ID.get('nvidia-titan-z')?.cost).toBe(375)
    // 矿卡子类标记（供「矿难」类 tag 过滤效果筛选）
    expect(DEFS_BY_ID.get('nvidia-cmp-170hx')?.tags).toContain('miner')
  })

  it('15 张 ×2 组成 30 张卡组，经 initGame 真实开局（nvidia vs amd 内置技能）', () => {
    const state = engine.initGame(nvidiaSetup())
    expect(state.players.P1.hand).toHaveLength(3)
    expect(state.players.P2.hand).toHaveLength(3)
    expect(state.players.P1.deck).toHaveLength(DECK_SIZE - 3)
    expect(state.turn).toBe(1)
    expect(state.activePlayer).toBe('P1')
  })
})

describe('M1-CNT nvidia 批次：实打覆盖扫描', () => {
  it('seed 对局实打：15 张卡全部至少被打出一次（CARD_PLAYED 事件覆盖）', () => {
    let state = engine.initGame(nvidiaSetup())
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

describe('M1-CNT nvidia 批次：关键事件断言（旗舰信仰线）', () => {
  it('RTX 5090：战吼 anyCharacter 3 伤 + 超频当回合即可攻击（传说位）', () => {
    const state = ctlState({ hand: [handOf('nvidia-rtx-5090')] })
    const played = playP1(state, 'hand-nvidia-rtx-5090', heroRef('P2'))
    const summoned = played.state.board.find((unit) => unit.cardId === 'nvidia-rtx-5090')
    expect(summoned).toMatchObject({ attack: 9, health: 7, keywords: ['charge'] })
    expect(played.events.find((event) => event.type === 'DAMAGE_DEALT')).toMatchObject({
      source: { kind: 'effect', ref: 'nvidia-rtx-5090' },
      target: { kind: 'hero', playerId: 'P2' },
      amount: 3,
      remainingHealth: 27,
    })
    // 超频：入场当回合即可攻击（charge 攻击预算在首次攻击结算时授予）
    const attacked = engine.applyAction(played.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: summoned!.instanceId,
      target: heroRef('P2'),
    })
    expect(attacked.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(attacked.state.players.P2.health).toBe(18) // 30 − 3（战吼）− 9（攻击）
  })

  it('RTX 5090D：战吼抽 1（特供版：性能砍了，售后服务补一张牌）', () => {
    const state = ctlState({ hand: [handOf('nvidia-rtx-5090d')], deckP1: ['smoke-gpu'] })
    const played = playP1(state, 'hand-nvidia-rtx-5090d')
    expect(played.state.board.find((unit) => unit.cardId === 'nvidia-rtx-5090d')).toMatchObject({
      attack: 8,
      health: 7,
    })
    expect(played.events.find((event) => event.type === 'CARD_DRAWN')).toMatchObject({
      playerId: 'P1',
      cardId: 'smoke-gpu',
      source: 'deck',
    })
    expect(played.state.players.P1.hand.map((card) => card.cardId)).toEqual(['smoke-gpu'])
  })

  it('RTX 4090：烧接口自伤 2 + 跳闸锁定 100W + 超频（高风险高回报）', () => {
    const state = ctlState({ hand: [handOf('nvidia-rtx-4090')] })
    const played = playP1(state, 'hand-nvidia-rtx-4090')
    expect(played.state.players.P1.health).toBe(28) // 瞬时功耗：自伤 2
    expect(played.state.players.P1.lockedMana).toBe(100) // lockMana 步骤（overload 的 N 来源）
    expect(played.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'overload',
    })
    expect(played.state.board.find((unit) => unit.cardId === 'nvidia-rtx-4090')).toMatchObject({
      attack: 8,
      health: 6,
      keywords: ['charge', 'overload'],
    })
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

  it('GTX Titan Z：双芯 GPU（windfury）——下回合起每回合两次攻击', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'nvidia-rtx-5060',
      attack: 3,
      health: 6,
      maxHealth: 6,
    })
    const state = ctlState({ hand: [handOf('nvidia-titan-z')], board: [foe] })
    const played = playP1(state, 'hand-nvidia-titan-z')
    const titanId = played.state.board.find((unit) => unit.cardId === 'nvidia-titan-z')!.instanceId
    const nextOwn = engine.applyAction(
      engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' }).state,
      { type: 'END_TURN', playerId: 'P2' },
    )
    expect(nextOwn.state.board.find((unit) => unit.instanceId === titanId)?.attacksRemaining).toBe(2)
    // 连打两次：先换掉 3/6，再打 CPU
    const swing1 = engine.applyAction(nextOwn.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: titanId,
      target: unitRef('u-foe'),
    })
    expect(swing1.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(swing1.state.board.find((unit) => unit.instanceId === 'u-foe')).toBeUndefined()
    const swing2 = engine.applyAction(swing1.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: titanId,
      target: heroRef('P2'),
    })
    expect(swing2.events.filter((event) => event.type === 'ATTACK_DECLARED')).toHaveLength(1)
    expect(swing2.state.players.P2.health).toBe(24) // 30 − 6
    expect(swing2.state.board.find((unit) => unit.instanceId === titanId)).toMatchObject({
      health: 3, // 6 − 3（反伤）
      attacksRemaining: 0,
    })
  })
})

describe('M1-CNT nvidia 批次：关键事件断言（信仰充值 / 传家宝 / 亮机卡）', () => {
  it('GTX 480：信仰充值（taunt）拦截敌方攻击——公版涡轮暖风机，先打我', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'nvidia-rtx-5060',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'nvidia-rtx-5060',
      attack: 3,
      health: 5,
      maxHealth: 5,
    })
    const state = ctlState({ hand: [handOf('nvidia-gtx-480')], board: [ally, foe] })
    const played = playP1(state, 'hand-nvidia-gtx-480')
    const heaterId = played.state.board.find((unit) => unit.cardId === 'nvidia-gtx-480')!.instanceId
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
    const hitHeater = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef(heaterId),
    })
    expect(hitHeater.state.board.find((unit) => unit.instanceId === heaterId)).toMatchObject({
      health: 3, // 6 − 3
    })
    expect(hitHeater.state.board.find((unit) => unit.instanceId === 'u-foe')).toBeUndefined() // 反伤 5 → 阵亡
  })

  it('CMP 170HX：矿卡蓝屏/传家宝亡语——死亡时给己方剩余显卡 +1 攻', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'nvidia-rtx-5070',
      attack: 5,
      health: 4,
      maxHealth: 4,
    })
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'nvidia-rtx-5060',
      attack: 6,
      health: 5,
      maxHealth: 5,
    })
    const state = ctlState({ hand: [handOf('nvidia-cmp-170hx')], board: [ally, foe] })
    const played = playP1(state, 'hand-nvidia-cmp-170hx')
    const cmpId = played.state.board.find((unit) => unit.cardId === 'nvidia-cmp-170hx')!.instanceId
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const killed = engine.applyAction(p2Turn.state, {
      type: 'ATTACK',
      playerId: 'P2',
      attackerId: 'u-foe',
      target: unitRef(cmpId),
    })
    expect(killed.state.board.find((unit) => unit.instanceId === cmpId)).toBeUndefined()
    expect(killed.state.players.P1.graveyard).toContainEqual({
      instanceId: cmpId,
      cardId: 'nvidia-cmp-170hx',
    })
    expect(killed.events.find((event) => event.type === 'MINION_DIED')).toMatchObject({ cause: 'damage' })
    expect(killed.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'deathrattle',
    })
    expect(killed.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({
      attack: 6, // 5 + 1（亡语传家宝）
      health: 4,
    })
  })

  it('GT 1030：无输出亮机（stealth）——现身前不可被攻击，攻击后现身', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'nvidia-rtx-5060',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('nvidia-gt-1030')], board: [foe] })
    const played = playP1(state, 'hand-nvidia-gt-1030')
    const gtId = played.state.board.find((unit) => unit.cardId === 'nvidia-gt-1030')!.instanceId
    const p2Turn = engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' })
    const hidden = catchRuleError(() =>
      engine.applyAction(p2Turn.state, {
        type: 'ATTACK',
        playerId: 'P2',
        attackerId: 'u-foe',
        target: unitRef(gtId),
      }),
    )
    expect(hidden.code).toBe('INVALID_TARGET')
    expect(hidden.detail).toMatchObject({ reason: 'stealth_hidden' })
    const nextOwn = engine.applyAction(p2Turn.state, { type: 'END_TURN', playerId: 'P2' })
    const revealed = engine.applyAction(nextOwn.state, {
      type: 'ATTACK',
      playerId: 'P1',
      attackerId: gtId,
      target: heroRef('P2'),
    })
    expect(revealed.state.players.P2.health).toBe(29) // 30 − 1（亮机卡的卑微输出）
    expect(revealed.state.board.find((unit) => unit.instanceId === gtId)?.keywords).toEqual([])
    expect(revealed.events.find((event) => event.type === 'KEYWORD_TRIGGERED')).toMatchObject({
      keyword: 'stealth',
    })
  })
})

describe('M1-CNT nvidia 批次：关键事件断言（驱动事件牌 / 配件）', () => {
  it('多帧生成：grantKeyword windfury——帧生成让一台显卡打出两帧输出', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'nvidia-rtx-5070',
      attack: 5,
      health: 4,
      maxHealth: 4,
    })
    const state = ctlState({ hand: [handOf('nvidia-multi-frame-gen')], board: [ally] })
    const played = playP1(state, 'hand-nvidia-multi-frame-gen', unitRef('u-ally'))
    expect(played.state.board.find((unit) => unit.instanceId === 'u-ally')?.keywords).toEqual(['windfury'])
    const nextOwn = engine.applyAction(
      engine.applyAction(played.state, { type: 'END_TURN', playerId: 'P1' }).state,
      { type: 'END_TURN', playerId: 'P2' },
    )
    expect(nextOwn.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({
      attacksRemaining: 2,
    })
  })

  it('12V-2×6 烧蚀：摧毁任一显卡，自己的 CPU 也被波及（高风险高回报）', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'nvidia-rtx-5060',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('nvidia-12v-2x6')], board: [foe] })
    const played = playP1(state, 'hand-nvidia-12v-2x6', unitRef('u-foe'))
    expect(played.state.board).toEqual([])
    expect(played.events.find((event) => event.type === 'MINION_DIED')).toMatchObject({
      cause: 'destroy',
      unit: { cardId: 'nvidia-rtx-5060' },
    })
    expect(played.state.players.P2.graveyard).toContainEqual({
      instanceId: 'u-foe',
      cardId: 'nvidia-rtx-5060',
    })
    expect(played.state.players.P1.health).toBe(27) // 自伤 3：烧，是转接头的宿命
    expect(
      played.events.find(
        (event) =>
          event.type === 'DAMAGE_DEALT' && event.target.kind === 'hero' && event.target.playerId === 'P1',
      ),
    ).toMatchObject({ amount: 3 })
  })

  it('DLSS 超分辨率：指定己方显卡 +1/+1（画质补偿）', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'nvidia-rtx-5070',
      attack: 5,
      health: 4,
      maxHealth: 4,
    })
    const state = ctlState({ hand: [handOf('nvidia-dlss-upscale')], board: [ally] })
    const played = playP1(state, 'hand-nvidia-dlss-upscale', unitRef('u-ally'))
    expect(played.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({
      attack: 6,
      health: 5,
      maxHealth: 5,
    })
  })

  it('Game Ready 驱动：抽 1 张 + 新驱动负优化，随机一台显卡吃 1 点', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'nvidia-rtx-5060',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({
      hand: [handOf('nvidia-game-ready-driver')],
      board: [ally],
      deckP1: ['smoke-gpu'],
    })
    const played = playP1(state, 'hand-nvidia-game-ready-driver')
    expect(played.events.find((event) => event.type === 'CARD_DRAWN')).toMatchObject({
      playerId: 'P1',
      cardId: 'smoke-gpu',
      source: 'deck',
    })
    // 唯一在场单位即随机池唯一候选：u-ally 3 → 2 血（确定性断言，同 seed 可复现）
    expect(played.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({ health: 2 })
  })

  it('RGB 信仰灯效：配件 0/1 入场占扩展槽且不可攻击，光环为全体己方显卡 +1 攻', () => {
    const ally = makeUnit({
      ownerId: 'P1',
      instanceId: 'u-ally',
      cardId: 'nvidia-rtx-5070',
      attack: 5,
      health: 4,
      maxHealth: 4,
    })
    const state = ctlState({ hand: [handOf('nvidia-rgb-glow')], board: [ally] })
    const played = playP1(state, 'hand-nvidia-rgb-glow')
    expect(played.state.board.find((unit) => unit.cardId === 'nvidia-rgb-glow')).toMatchObject({
      attack: 1, // 0/1 入场 + 自身光环投影
      health: 1,
      attacksRemaining: 0, // 配件不可攻击（§4）
    })
    expect(played.state.board.find((unit) => unit.instanceId === 'u-ally')).toMatchObject({
      attack: 6, // 5 + 1（RGB 玄学增益）
    })
    expect(played.events.find((event) => event.type === 'MINION_SUMMONED')).toMatchObject({
      source: 'play',
    })
  })

  it('RTX 5080 / 5070 / 5060：按真实 TDP 定价的白板主力曲线', () => {
    const state = ctlState({
      hand: [handOf('nvidia-rtx-5080'), handOf('nvidia-rtx-5070'), handOf('nvidia-rtx-5060')],
    })
    let cursor = playP1(state, 'hand-nvidia-rtx-5080').state
    cursor = playP1(cursor, 'hand-nvidia-rtx-5070').state
    const played = playP1(cursor, 'hand-nvidia-rtx-5060')
    const byCardId = (cardId: string) => played.state.board.find((unit) => unit.cardId === cardId)
    expect(byCardId('nvidia-rtx-5080')).toMatchObject({ attack: 7, health: 5 })
    expect(byCardId('nvidia-rtx-5070')).toMatchObject({ attack: 5, health: 4 })
    expect(byCardId('nvidia-rtx-5060')).toMatchObject({ attack: 4, health: 3 })
    expect(played.state.players.P1.mana).toBe(MAX_MANA - 360 - 250 - 145)
  })
})

describe('M1-CNT nvidia 批次：非法操作拒绝（§3 错误码）', () => {
  it('供电不足：100W 供不出 575W 的 5090 → INSUFFICIENT_MANA', () => {
    const state = ctlState({ hand: [handOf('nvidia-rtx-5090')], manaP1: 100 })
    const error = catchRuleError(() => playP1(state, 'hand-nvidia-rtx-5090'))
    expect(error.code).toBe('INSUFFICIENT_MANA')
  })

  it('池外目标：DLSS 超分辨率指定敌方显卡 → INVALID_TARGET（not_in_pool）', () => {
    const foe = makeUnit({
      ownerId: 'P2',
      instanceId: 'u-foe',
      cardId: 'nvidia-rtx-5060',
      attack: 4,
      health: 3,
      maxHealth: 3,
    })
    const state = ctlState({ hand: [handOf('nvidia-dlss-upscale')], board: [foe] })
    const error = catchRuleError(() => playP1(state, 'hand-nvidia-dlss-upscale', unitRef('u-foe')))
    expect(error.code).toBe('INVALID_TARGET')
    expect(error.detail).toMatchObject({ reason: 'not_in_pool', pool: 'ownUnits' })
  })

  it('不是你的回合：P2 回合代打 P1 的牌 → NOT_YOUR_TURN', () => {
    const state = ctlState({ hand: [handOf('nvidia-rtx-5070')], activePlayer: 'P2' })
    const error = catchRuleError(() =>
      engine.applyAction(state, { type: 'PLAY_CARD', playerId: 'P1', uid: 'hand-nvidia-rtx-5070' }),
    )
    expect(error.code).toBe('NOT_YOUR_TURN')
  })
})
