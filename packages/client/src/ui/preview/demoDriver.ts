/**
 * 沙箱演示驱动（P2-UI2-2，v3 按 p2-ui22-preview 补齐定稿 + 授权扩展）—— 无头引擎的
 * 杀手级应用：输入 cardId，产出「打出前 → 打出」的确定性迷你对局时间线，供
 * DemoCanvas 循环播放。零逐卡内容成本：一切事实都来自引擎事件流与 viewFor 视角，
 * 改 content JSON 即自动生效。
 *
 * 方案（v3：双方预铺裸 GPU + P2 预铺卡攻击破潜行）：
 * - 演示卡组：目标卡 ×2 + 预铺卡 neutral-gt-1030 ×2 + 中性卡填满 DECK_SIZE=30
 *   （targetId === 预铺卡时该 id 聚合为 4 张；填充循环跳过这两个 id）；
 *   P2 卡组 = 预铺卡 ×2 + 中性卡填满 30；
 * - 确定性种子扫描（均经 viewFor 公开接口）：P1 起手含目标卡 **且** 含预铺卡，
 *   P2 起手含至少一张预铺卡（三条件同 seed 命中即停；命中率 ≈0.51%/seed，
 *   引擎毫秒级，扫描开销可忽略）；
 * - 脚本推进（纯脚本动作，无 AI，确定性；v3 授权扩展：P2 预铺卡攻击一次）：
 *   P1 第 1 回合：先打预铺卡（100W 恰好够）→ 预铺己方裸 GPU；
 *   P2 第 1 回合：打预铺卡 → 预铺敌方裸 GPU；此后 P2 仅在其第 2 个自身回合
 *   （全局 T4）让预铺卡攻击 P1 英雄一次（合法、不受潜行影响；潜行随攻击永久移除，
 *   combat.ts applyAttack）→ 攻击后 P2 全 END_TURN；
 *   P1 打出目标卡的门槛按目标类分档（v3 顺序约束）：结算需要 enemyUnits/allUnits
 *   chosen 目标的卡取「供电 ≥ cost 且 P2 攻击已结算（全局 T4 后，即 T5 起）」的
 *   首个回合——否则 200W 卡会在 T3（潜行解除前）打出而失败；ownUnits/无目标类
 *   维持「供电 ≥ cost」的首个回合（T3 起）。
 *   候选动作取 getLegalActions 中该 uid 的第一个 PLAY_CARD（chosen 目标已按引擎
 *   枚举展开，即第一个合法候选；allUnits 等池取第一个候选即命中预铺单位）。
 *   目标卡即预铺卡（neutral-gt-1030）的特例：P1 第 1 回合的预铺动作本身就是目标打出。
 *   目标卡 cost ≤ 100 的情形：预铺先行扣光 T1 供电，目标卡自然落到第 2 个自身回合
 *   （实现取「预铺先手必打」的简单序，无同回合双打分支）。
 * - 产出：开局事件（GAME_START + 首个 TURN_START，§2.1 裁决的合成约定）+
 *   预铺演出事件（preludeEvents：P1/P2 预铺落场、P2 预铺卡攻击 P1 英雄的演出子集，
 *   含 TURN_START 供画布推进供电显示）+ 打出该卡批次的完整事件流 + 打出前/后
 *   关键状态快照 + 开局快照（满血空场，画布轨迹起点）。快照一律取自
 *   viewFor(state, 'P1') 视角——完整 state 只在本模块内流转，对外只暴露事件与
 *   快照（架构铁律 3）。
 * - 结果缓存：同 cardId 幂等（模块级 Map；clearDemoCache 供测试重置）。
 *
 * 前置：引擎注册表须已注入 content 卡池（main.tsx 启动时 ensureContentRegistered
 * 已完成；测试可用 registerCardDefinitions 注入 mock）。
 */

import {
  createEngine,
  DECK_SIZE,
  getCardDefinition,
  type Action,
  type CardDefinition,
  type CardId,
  type DeckSpec,
  type GameEvent,
  type GameState,
  type PlayerId,
  type PlayerSetup,
  type PlayerView,
} from '@siliconcard/core'
import { loadCodexCards } from '../codex/cardPool'

/** 预铺用裸 GPU（100W，双方卡组各 ×2；定稿指定 neutral-gt-1030） */
export const DEMO_PRELAY_CARD_ID: CardId = 'neutral-gt-1030'

// —— 对外契约 ——

/** 英雄（CPU）关键状态快照（viewFor 公开字段投影） */
export interface DemoHeroSnapshot {
  faction: string
  health: number
  maxHealth: number
  armor: number
  mana: number
  maxMana: number
}

/** 场上单位快照（扩展槽实例） */
export interface DemoUnitSnapshot {
  instanceId: string
  cardId: CardId
  ownerId: PlayerId
  attack: number
  health: number
  maxHealth: number
  keywords: readonly string[]
}

/** 关键状态快照：打出前/后各一份（任务书交付 1） */
export interface DemoSnapshot {
  turn: number
  p1: DemoHeroSnapshot
  p2: DemoHeroSnapshot
  board: readonly DemoUnitSnapshot[]
}

/** 沙箱演示时间线：画布播放与无头测试的唯一输入 */
export interface DemoTimeline {
  cardId: CardId
  /** 命中的确定性种子（≥1）；卡牌未注册/卡池异常时为 0 */
  seed: number
  /** 目标卡是否成功打出 */
  playable: boolean
  /** 不可自动演示的原因（playable=false 时非空，UI 明示降级） */
  reason: string | null
  /** 开局事件（GAME_START + 首个 TURN_START，§2.1 裁决的合成约定） */
  openingEvents: readonly GameEvent[]
  /**
   * 预铺演出事件（目标卡打出前的演出子集）：P1/P2 预铺落场、P2 预铺卡攻击 P1 英雄
   * （ATTACK_DECLARED + DAMAGE_DEALT），含 TURN_START 供画布推进供电显示。
   * 不含目标卡批次（那在 playEvents）。
   */
  preludeEvents: readonly GameEvent[]
  /** 打出该卡批次的完整事件流（CARD_PLAYED 及其后续效果事件） */
  playEvents: readonly GameEvent[]
  /** 打出的动作（getLegalActions 候选中该 uid 的第一个 PLAY_CARD） */
  playAction: Action | null
  /** 打出时的全局回合号 */
  playTurn: number | null
  /** 开局快照（扫描命中后的初始状态：满血、空场；画布轨迹起点） */
  openingSnapshot: DemoSnapshot | null
  /** 打出前快照（含双方预铺单位与攻击后的英雄血量） */
  before: DemoSnapshot | null
  /** 打出后快照 */
  after: DemoSnapshot | null
  /** 脚本实际结算的动作序列（测试用：证明 P2 仅预铺一打 + 推进确定性） */
  scriptActions: readonly Action[]
}

export interface DemoDriverOptions {
  /** 填充用卡池（缺省 = content 卡池的中性卡，按 id 排序循环取用） */
  fillers?: readonly CardDefinition[]
}

/** 扫描上限：三条件命中率 ≈0.51%/seed，10000 个 seed 下漏检概率 ~1e-22 */
const MAX_SEED_SCAN = 10000
/** 脚本推进上限：预铺占 2 回合，供电在自身第 10 回合封顶（全局 19/20 回合），余量安全 */
const MAX_SCRIPT_TURNS = 32

// —— 卡组构建 ——

function byIdAscending(a: CardDefinition, b: CardDefinition): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 循环取填充卡直到 total 张（确定性：按 id 排序循环；skip 中的 id 不参与填充） */
function fillWithCycle(
  counts: Map<CardId, number>,
  fillers: readonly CardDefinition[],
  skip: readonly CardId[],
  total: number,
): void {
  const pool = [...fillers].filter((d) => !skip.includes(d.id)).sort(byIdAscending)
  if (pool.length === 0) return
  let filled = [...counts.values()].reduce((n, c) => n + c, 0)
  let index = 0
  while (filled < total) {
    const id = (pool[index % pool.length] as CardDefinition).id
    counts.set(id, (counts.get(id) ?? 0) + 1)
    filled += 1
    index += 1
  }
}

function countsToSpec(counts: Map<CardId, number>): DeckSpec {
  return { cards: [...counts.entries()].map(([cardId, count]) => ({ cardId, count })) }
}

/**
 * 演示卡组（P1）：目标卡 ×2 + 预铺卡 ×2 + 中性卡填满 DECK_SIZE。
 * 目标卡即预铺卡时该 id 聚合为 4 张。最终合法性由引擎 initGame 的 DeckSpec
 * 校验把关（本函数只保证形状与确定性）。
 */
export function buildDemoDeck(cardId: CardId, fillers: readonly CardDefinition[]): DeckSpec {
  const counts = new Map<CardId, number>([
    [cardId, 2],
    [DEMO_PRELAY_CARD_ID, 2],
  ])
  if (cardId === DEMO_PRELAY_CARD_ID) counts.set(cardId, 4)
  fillWithCycle(counts, fillers, [cardId, DEMO_PRELAY_CARD_ID], DECK_SIZE)
  return countsToSpec(counts)
}

/** 靶机卡组（P2）：预铺卡 ×2 + 中性卡填满 DECK_SIZE */
function buildDummyDeck(fillers: readonly CardDefinition[]): DeckSpec {
  const counts = new Map<CardId, number>([[DEMO_PRELAY_CARD_ID, 2]])
  fillWithCycle(counts, fillers, [DEMO_PRELAY_CARD_ID], DECK_SIZE)
  return countsToSpec(counts)
}

/** 默认填充池：content 卡池的中性卡（cardPool 与对局同源，确定性排序） */
function defaultFillers(): readonly CardDefinition[] {
  return loadCodexCards().filter((d) => d.faction === 'neutral')
}

// —— 快照（viewFor 视角投影，禁读完整 state 对外） ——

function snapshotOf(view: PlayerView): DemoSnapshot {
  const hero = (p: PlayerView['you'] | PlayerView['opponent']) => ({
    faction: p.faction,
    health: p.health,
    maxHealth: p.maxHealth,
    armor: p.armor,
    mana: p.mana,
    maxMana: p.maxMana,
  })
  return {
    turn: view.turn,
    p1: hero(view.viewer === 'P1' ? view.you : view.opponent),
    p2: hero(view.viewer === 'P1' ? view.opponent : view.you),
    board: view.board.map((unit) => ({
      instanceId: unit.instanceId,
      cardId: unit.cardId,
      ownerId: unit.ownerId,
      attack: unit.attack,
      health: unit.health,
      maxHealth: unit.maxHealth,
      keywords: [...unit.keywords],
    })),
  }
}

function emptyTimeline(cardId: CardId, reason: string, openingEvents: readonly GameEvent[] = []): DemoTimeline {
  return {
    cardId,
    seed: 0,
    playable: false,
    reason,
    openingEvents,
    preludeEvents: [],
    playEvents: [],
    playAction: null,
    playTurn: null,
    openingSnapshot: null,
    before: null,
    after: null,
    scriptActions: [],
  }
}

/** 不可自动演示的定位：结算需要 enemyUnits/allUnits chosen 目标（潜行门控类） */
function needsEnemyVisibleOf(def: CardDefinition): boolean {
  for (const step of def.effect?.steps ?? []) {
    if (
      'target' in step &&
      step.target.kind === 'chosen' &&
      (step.target.pool === 'enemyUnits' || step.target.pool === 'allUnits')
    ) {
      return true
    }
  }
  return false
}

/** 不可自动演示的定位：结算需要场上已有单位的 chosen 目标池（供降级文案） */
function chosenUnitPoolsOf(def: CardDefinition): string[] {
  const pools = new Set<string>()
  for (const step of def.effect?.steps ?? []) {
    if ('target' in step && step.target.kind === 'chosen' && step.target.pool.endsWith('Units')) {
      pools.add(step.target.pool)
    }
  }
  return [...pools]
}

/**
 * 预铺演出子集过滤：只保留画布可演的事件（丢 TURN_END/CARD_DRAWN 等噪音，
 * 保留 TURN_START——画布经它推进供电上限显示）。
 */
const PRELUDE_EVENT_TYPES: ReadonlySet<GameEvent['type']> = new Set([
  'TURN_START',
  'CARD_PLAYED',
  'MINION_SUMMONED',
  'ATTACK_DECLARED',
  'DAMAGE_DEALT',
  'HEALING',
  'KEYWORD_TRIGGERED',
  'ARMOR_GAINED',
  'BURN_OUT',
  'FATIGUE',
  'HERO_POWER_USED',
])

function preludeSubsetOf(events: readonly GameEvent[]): GameEvent[] {
  return events.filter((event) => PRELUDE_EVENT_TYPES.has(event.type))
}

/** getLegalActions 中「指定 cardId 手牌」的第一个 PLAY_CARD（含第一个合法 chosen 候选） */
function firstPlayFor(legal: readonly Action[], state: Readonly<GameState>, cardId: CardId): Action | null {
  const uid = state.players[state.activePlayer].hand.find((hand) => hand.cardId === cardId)?.uid
  if (!uid) return null
  const action = legal.find((candidate) => candidate.type === 'PLAY_CARD' && candidate.uid === uid)
  return action ?? null
}

// —— 时间线构建（无缓存纯过程，测试直用） ——

export function buildDemoTimeline(cardId: CardId, options: DemoDriverOptions = {}): DemoTimeline {
  const fillers = options.fillers ?? defaultFillers()
  const def = getCardDefinition(cardId) ?? fillers.find((d) => d.id === cardId)
  if (!def) {
    return emptyTimeline(cardId, '卡牌定义未注册：宿主需先 ensureContentRegistered（main.tsx 启动时已完成）')
  }
  if (fillers.length === 0 || !fillers.some((d) => d.id === DEMO_PRELAY_CARD_ID)) {
    return emptyTimeline(cardId, `预铺卡 ${DEMO_PRELAY_CARD_ID} 不在填充池中，无法组装演示卡组`)
  }

  const engine = createEngine()
  const players: [PlayerSetup, PlayerSetup] = [
    { id: 'P1', faction: def.faction, heroName: '演示位', deck: buildDemoDeck(cardId, fillers) },
    { id: 'P2', faction: 'neutral', heroName: '靶机', deck: buildDummyDeck(fillers) },
  ]

  // 确定性种子扫描（均经 viewFor）：P1 起手含目标卡且含预铺卡；P2 起手含预铺卡
  let state: GameState | null = null
  let seed = 0
  for (let candidate = 1; candidate <= MAX_SEED_SCAN; candidate++) {
    const opened = engine.initGame({ seed: candidate, players })
    const view = engine.viewFor(opened, 'P1')
    const p1HasTarget = view.you.hand.some((hand) => hand.cardId === cardId)
    const p1HasPrelay = view.you.hand.some((hand) => hand.cardId === DEMO_PRELAY_CARD_ID)
    const p2HasPrelay = view.opponent.handSize > 0 && viewForHandHasPrelay(engine, opened)
    if (p1HasTarget && p1HasPrelay && p2HasPrelay) {
      state = opened
      seed = candidate
      break
    }
  }
  if (!state) {
    return emptyTimeline(cardId, `扫描 ${MAX_SEED_SCAN} 个种子仍不满足起手条件（目标卡+预铺卡/靶机预铺卡，异常请检查卡池）`)
  }

  const active = state.players[state.activePlayer]
  const openingEvents: GameEvent[] = [
    { type: 'GAME_START', seed, firstPlayer: state.activePlayer },
    { type: 'TURN_START', turn: state.turn, playerId: state.activePlayer, maxMana: active.maxMana, drawCount: 0 },
  ]
  // 开局快照（满血、空场）：画布轨迹起点（后续 prelude 演出在其上推进）
  const openingSnapshot = snapshotOf(engine.viewFor(state, 'P1'))

  // 脚本推进 v3：P1/P2 各预铺一打；延迟类卡等 P2 预铺卡攻击破潜行（全局 T4）；
  // 此后 P2 全 END_TURN；P1 按「供电 ≥ cost（延迟类还须攻击已结算）」的首个回合打目标卡
  const isPrelayTarget = cardId === DEMO_PRELAY_CARD_ID
  const needsEnemyVisible = needsEnemyVisibleOf(def)
  const scriptActions: Action[] = []
  const preludeEvents: GameEvent[] = []
  let p1Prelaid = false
  let p2Prelaid = false
  let p2PrelayUnitId: string | null = null
  let p2AttackDone = false
  let before: DemoSnapshot | null = null
  let after: DemoSnapshot | null = null
  let playEvents: readonly GameEvent[] = []
  let playAction: Action | null = null
  let playTurn: number | null = null

  const applyScriptAction = (action: Action, capture: boolean): void => {
    const current = state as GameState
    if (capture) {
      before = snapshotOf(engine.viewFor(current, 'P1'))
      playTurn = current.turn
    }
    const result = engine.applyAction(current, action)
    scriptActions.push(action)
    if (capture) {
      playAction = action
      playEvents = result.events
      after = snapshotOf(engine.viewFor(result.state, 'P1'))
    } else {
      preludeEvents.push(...preludeSubsetOf(result.events))
    }
    // 记录 P2 预铺单位实例（攻击动作的锚点，测试断言也经 before.board 定位）
    if (!p2PrelayUnitId) {
      for (const event of result.events) {
        if (event.type === 'MINION_SUMMONED' && event.source === 'play' && event.unit.ownerId === 'P2') {
          p2PrelayUnitId = event.unit.instanceId
          break
        }
      }
    }
    state = result.state
  }

  let turns = 0
  while (playAction === null && turns < MAX_SCRIPT_TURNS && state.phase !== 'ended') {
    turns += 1
    const legal = engine.getLegalActions(state, state.activePlayer)

    if (state.activePlayer === 'P1') {
      if (!p1Prelaid) {
        const prelay = firstPlayFor(legal, state, DEMO_PRELAY_CARD_ID)
        if (prelay) {
          if (isPrelayTarget) {
            applyScriptAction(prelay, true) // 预铺动作本身就是目标打出
            break
          }
          applyScriptAction(prelay, false)
          p1Prelaid = true
          continue
        }
        p1Prelaid = true // 扫描已保证起手含预铺卡，理论不至
      }
      // 延迟类（enemyUnits/allUnits chosen）：须等 P2 预铺卡攻击破潜行（v3 顺序约束）
      if (!needsEnemyVisible || p2AttackDone) {
        const target = firstPlayFor(legal, state, cardId)
        if (target) {
          applyScriptAction(target, true)
          break
        }
      }
    } else {
      if (!p2Prelaid) {
        const prelay = firstPlayFor(legal, state, DEMO_PRELAY_CARD_ID)
        if (prelay) {
          applyScriptAction(prelay, false)
          p2Prelaid = true
          continue
        }
        p2Prelaid = true // 扫描已保证靶机起手含预铺卡，理论不至
      }
      if (!p2AttackDone) {
        // P2 预铺卡攻击 P1 英雄一次（其第 2 个自身回合起可用；召唤失调回合无动作自然跳过）
        const attack = p2PrelayUnitId
          ? legal.find(
              (action) =>
                action.type === 'ATTACK' &&
                action.attackerId === p2PrelayUnitId &&
                action.target.kind === 'hero' &&
                action.target.playerId === 'P1',
            )
          : undefined
        if (attack) {
          applyScriptAction(attack, false)
          p2AttackDone = true
          continue
        }
      }
    }

    const endTurn = legal.find((action) => action.type === 'END_TURN')
    if (!endTurn) break
    applyScriptAction(endTurn, false)
  }

  if (!playAction) {
    const pools = chosenUnitPoolsOf(def)
    const reason = needsEnemyVisible && !p2AttackDone
      ? `敌方预铺单位（GT 1030）的破潜行攻击未能在脚本上限内结算——enemyUnits/allUnits 类 chosen 无可见候选，暂不支持自动演示`
      : `该效果的结算需要场上已有对应单位目标（目标池：${pools.join('/') || '未知'}）——沙箱脚本无法自动制造该局面，暂不支持自动演示`
    return {
      ...emptyTimeline(cardId, reason, openingEvents),
      seed,
      preludeEvents,
      openingSnapshot,
      scriptActions,
    }
  }

  return {
    cardId,
    seed,
    playable: true,
    reason: null,
    openingEvents,
    preludeEvents,
    playEvents,
    playAction,
    playTurn,
    openingSnapshot,
    before,
    after,
    scriptActions,
  }
}

/** P2 起手是否含预铺卡（经 viewFor 公开接口，不读完整 state） */
function viewForHandHasPrelay(engine: ReturnType<typeof createEngine>, state: GameState): boolean {
  // viewFor 的对手视角只给 handSize，预铺卡检查需经 P2 视角的 you.hand
  return engine.viewFor(state, 'P2').you.hand.some((hand) => hand.cardId === DEMO_PRELAY_CARD_ID)
}

// —— 缓存（同 cardId 幂等，任务书交付 1） ——

const cache = new Map<CardId, DemoTimeline>()

/**
 * 取演示时间线（同 cardId 幂等命中缓存）。
 * 注意：options 仅在首次构建时生效（缓存键为 cardId）；测试注入不同卡池请直用
 * buildDemoTimeline 或先 clearDemoCache。
 */
export function getDemoTimeline(cardId: CardId, options: DemoDriverOptions = {}): DemoTimeline {
  const hit = cache.get(cardId)
  if (hit) return hit
  const timeline = buildDemoTimeline(cardId, options)
  cache.set(cardId, timeline)
  return timeline
}

/** 清空演示缓存（测试隔离用） */
export function clearDemoCache(): void {
  cache.clear()
}
