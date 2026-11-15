/**
 * AI 复盘评分引擎（P2-QA1）—— 对回放录制体的 viewer 决策逐步打分。
 *
 * 契约与边界（任务书交付 1）：
 * - 入参用 core 的 `ReplayRecording`（seed + 双方卡组 + 动作序列，黄金回放契约）。
 *   client 侧 ui/replay 的录制体本就是该 core 类型（ui/replay/types.ts 亦从 core
 *   import），故 ai 直接消费 core 类型即可——无需结构同构副本，也天然满足
 *   「ai 包不得 import client」；viewer（复盘视角）单独传参。
 * - 只经引擎公开四函数重建时间线：initGame → 逐步 applyAction；决策观察只用
 *   getLegalActions + viewFor；Hard AI 决策体拿到的是 sealState 封印快照
 *   （防作弊闸门在复盘链路同样在线，见 sealed.ts）。
 * - 本模块自身不读 GameState 原始字段：胜负/阶段/行动方一律经 viewFor 视图判定。
 *
 * 评分口径（每个 viewer 决策点 = viewer 是 activePlayer 且对局未结束的动作步）：
 * 1. 取实际动作；用 Hard 难度 createAiPlayer 在同一局面求 AI 的选择
 *    （注入 seed = deriveAiSeed(recording.seed, viewerId) 保证确定性；Hard 档
 *    零噪声零 dropout，决策本身是局面的纯函数）；
 * 2. 与 AI 完全一致 → S；不一致 → 用既有 evaluateView 对「实际动作后局面」与
 *    「AI 选择后局面」各评分一次，按**带符号**分差 Δ = 实际 − AI 分档：
 *      Δ ≥ -0.5 → A（与 Hard AI 同档或几乎无损的替代选择；比 AI 更优不惩罚，
 *                  这是与任务书示例 |Δ| 分档的有意偏差——打得更好比照 AI 更该得高分）
 *      Δ >  -2  → B（小亏）
 *      Δ ≤ -2  → C（明显亏模）
 *    两点口径修正（均有实测依据，见 review.test.ts）：
 *    a. 分差用带符号 Δ 而非 |Δ|——normal 视角对 Hard 基准存在 Δ>0 的样本
 *       （12 局实测 2/683 步），|Δ| 会把打得更好误判成亏模；
 *    b. 终局分支做未耗功耗归一化（evalBranch）——evaluateView 的曲线填充惩罚
 *       在「对局已结束」的分支是纯噪声，会把漏斩步的分差抬高近一档；
 *    阈值实测：normal/normal 12 局 683 步，C 档占 1.3%、A 档占 6.1%（分差集中在
 *    ±1.5 内）；easy/easy 648 步 C 档占 14.7%——-2 的 C 阈与人工构造的亏模动作、
 *    easy 深亏样本对齐，normal 自身失误极少落入 C；
 *    另：漏斩步（存在一击致胜线路而实际未走）直接定 C——赢在桌面上的最差决策，
 *    不受 -2 阈值对小残局的覆盖盲区影响（如对方剩 1 血漏斩 Δ≈-1.4 仍应标 C）。
 *    evalDelta 字段始终如实记录带符号分差，不受档位覆盖影响。
 * 3. 漏斩检测（plan 授权的模拟深度 = 一步）：枚举 viewer 合法动作逐个模拟，
 *    若存在使对局立即进入「viewer 胜利」的动作（终态 view.phase === 'ended' 且
 *    view.winner === viewerId）而实际未走 → lethalMissed 标记该步。判定走
 *    引擎真实结算 + 官方视图，不用伤害估计（宁慢勿错，且天然零误报）；
 * 4. 尽力解释：B/C 步把分差粗分解为「对面 CPU 少打 X 点 / 己方场面亏 X 分 /
 *    少留 X 张手牌 / 己方 CPU 多亏 X 点」；解释不了只给分差（topMisses 的
 *    reason 兜底），不硬编故事。抵扣券（P2-ENG1）单独提醒：券在手且能解锁
 *    高费卡而实际没用 → 附「券将作废」note（单步评估看不到下回合收益，
 *    分数不虚高惩罚，只解释）。
 *
 * 性能红线（30 步对局 < 10s）：Hard 每步含对手反制两步预演，实测见
 * review.test.ts；动作数超过 REVIEW_ADAPTIVE_ACTION_LIMIT 自动降档 normal
 * （options.depth 显式指定则覆盖自适应）。
 */

import {
  RuleError,
  VOUCHER_BONUS,
  VOUCHER_CARD_ID,
  createEngine,
  type Action,
  type EngineResult,
  type GameSetup,
  type PlayerId,
  type PlayerView,
  type ReplayRecording,
} from '@siliconcard/core'
import { evaluateView, unitScore, UNSPENT_MANA_WEIGHT_PER_100 } from './evaluate'
import { findImmediateWinActions } from './lethal'
import { createAiPlayer } from './player'
import { deriveAiSeed } from './rng'
import { sealState } from './sealed'

// ———— 评分档位与阈值 ————

export type ReviewGrade = 'S' | 'A' | 'B' | 'C'

/** 总分加权（0-100）：S=满分、A=接近基准、B=小亏、C=明显亏模 */
export const REVIEW_GRADE_WEIGHTS: Readonly<Record<ReviewGrade, number>> = {
  S: 100,
  A: 85,
  B: 55,
  C: 20,
}

/** A 档下限：带符号分差 ≥ -0.5 视为「与 Hard AI 同档」的替代选择 */
export const REVIEW_DELTA_A = -0.5

/** C 档下限：带符号分差 ≤ -2 视为「明显亏模」 */
export const REVIEW_DELTA_C = -2

/** 纯函数：分差 → 档位（S 由「与 AI 完全一致」单独判定，不进本函数） */
export function gradeForDelta(delta: number): Exclude<ReviewGrade, 'S'> {
  if (delta >= REVIEW_DELTA_A) return 'A'
  if (delta > REVIEW_DELTA_C) return 'B'
  return 'C'
}

/** 自适应降档阈值：录制动作数超过该值时 Hard 全模拟过重，降为 normal 评估 */
export const REVIEW_ADAPTIVE_ACTION_LIMIT = 160

export interface MatchReviewOptions {
  /**
   * 评估深度：'hard'（默认）/ 'normal'。缺省（undefined）时按动作数自适应：
   * 超过 REVIEW_ADAPTIVE_ACTION_LIMIT 自动用 normal，否则 hard。
   */
  depth?: 'hard' | 'normal'
}

// ———— 产出结构 ————

export interface ReviewStep {
  /** 录制动作下标（0 起）；UI 侧经回放时间轴的批次映射对齐到事件索引 */
  actionIndex: number
  score: ReviewGrade
  /** 该决策点的实际动作（录制体原文） */
  actual: Action
  /** Hard AI 在同一局面的选择（合法集成员；与 actual 同一动作即 S） */
  aiChoice: Action
  /** 带符号分差 = evaluateView(实际后局面) − evaluateView(AI 选择后局面)；S 步为 0 */
  evalDelta: number
  note?: string
}

export interface MatchReview {
  viewerId: PlayerId
  steps: ReviewStep[]
  /** 四档计数（Σ = steps.length） */
  scores: Record<ReviewGrade, number>
  /** 0-100 加权总分（无决策点时为 100——无可扣分之处） */
  overall: number
  /** 最差 ≤3 步（C 优先、同档按分差深浅），reason = 尽力解释或裸分差 */
  topMisses: { actionIndex: number; reason: string }[]
  /** 漏斩步（存在一击致胜线路而实际未走的动作下标） */
  lethalMissedSteps: number[]
  /** 非 null = 录制体重驱在动作 k 处截断（卡池漂移/终局后残余动作），复盘只覆盖此前决策点 */
  notice: string | null
}

// ———— 漏斩检测 ————

function actionKey(action: Action): string {
  return JSON.stringify(action)
}

/**
 * 一击致胜线路枚举（纯函数，review 与单测共用）：枚举 viewer 全部合法动作逐个
 * 模拟一步，返回「模拟后对局立即终局且胜者 = viewer」的动作。
 * 模拟失败（理论不发生：枚举来自 getLegalActions）跳过不误报；CONCEDE 跳过
 * （认输只会输）。胜负判定经 viewFor 官方视图，不读完整 state。
 */
// ———— 解释器（尽力解释，解释不了不给） ————
// findImmediateWinActions 已下沉至 lethal.ts（player/review 共用防成环），此处转出口保持既有导入面
export { findImmediateWinActions } from './lethal'

/** viewer 视角的场面净值（己方单位价值 − 敌方单位价值，与 evaluateView 同权重） */
function boardValueOf(view: PlayerView): number {
  let value = 0
  for (const unit of view.board) {
    const score = unitScore(unit)
    value += unit.ownerId === view.you.id ? score : -score
  }
  return value
}

/** 分差粗分解：能解释的维度拼人话，一个都解释不了返回 undefined（不硬编故事） */
function buildDeltaNote(actualView: PlayerView, aiView: PlayerView): string | undefined {
  const parts: string[] = []
  const faceGap =
    actualView.opponent.health + actualView.opponent.armor - (aiView.opponent.health + aiView.opponent.armor)
  if (faceGap >= 2) parts.push(`对面 CPU 少打 ${faceGap} 点`)
  const boardGap = Math.round(boardValueOf(aiView) - boardValueOf(actualView))
  if (boardGap >= 2) parts.push(`己方场面亏 ${boardGap} 分`)
  const handGap = aiView.you.hand.length - actualView.you.hand.length
  if (handGap >= 1) parts.push(`少留 ${handGap} 张手牌`)
  const heroGap =
    actualView.you.health + actualView.you.armor - (aiView.you.health + aiView.you.armor)
  if (heroGap >= 2) parts.push(`己方 CPU 多亏 ${heroGap} 点`)
  return parts.length > 0 ? `AI 选择更优：${parts.join(' / ')}` : undefined
}

/**
 * 抵扣券提醒（P2-ENG1）：券在手、且存在「当前供电打不出、+VOUCHER_BONUS 内打得出」的卡、
 * 而实际动作不是打券 → 本回合结束券作废，附解释性 note（分数照分差口径走，
 * 不虚高惩罚——单步评估看不到被解锁卡的收益）。
 */
function voucherWasteNote(view: PlayerView, actual: Action): string | undefined {
  const voucher = view.you.hand.find((card) => card.cardId === VOUCHER_CARD_ID)
  if (!voucher) return undefined
  const enables = view.you.hand.some(
    (card) => card.uid !== voucher.uid && card.cost > view.you.mana && card.cost <= view.you.mana + VOUCHER_BONUS,
  )
  if (!enables) return undefined
  const playedVoucher = actual.type === 'PLAY_CARD' && actual.uid === voucher.uid
  return playedVoucher ? undefined : '抵扣券本回合不用会作废（AI 会先用券解锁高费卡）'
}

function joinNotes(...notes: (string | undefined)[]): string | undefined {
  const kept = notes.filter((note): note is string => note !== undefined)
  return kept.length > 0 ? kept.join('；') : undefined
}

// ———— 主入口 ————

/**
 * 分支评分：evaluateView + 一个复盘口径归一化——对局已终局的分支不存在
 * 「下回合再花」的选项，evaluateView 的未耗功耗惩罚（曲线填充驱动项）在
 * 终局分支是纯噪声（例：AI 分支斩杀收局、实际分支拖回合，前者反被扣
 * 未耗功耗分，漏斩步的带符号分差因此被抬高一档）。归一化只发生在复盘
 * 评分侧（evaluate.ts 本体不动，AI 决策口径不受影响）。
 */
function evalBranch(view: PlayerView): number {
  const raw = evaluateView(view)
  if (view.phase === 'ended' && view.activePlayer === view.you.id) {
    return raw + UNSPENT_MANA_WEIGHT_PER_100 * (view.you.mana / 100)
  }
  return raw
}

function endTurnFallback(legal: readonly Action[], playerId: PlayerId): Action {
  return legal.find((action): action is Extract<Action, { type: 'END_TURN' }> => action.type === 'END_TURN') ?? {
    type: 'END_TURN',
    playerId,
  }
}

/**
 * 复盘主入口：重建录制时间线，对 viewer 的每个决策点评分。
 * 只抛非 RuleError 异常（环境/引擎 bug）；录制动作重放失败（RuleError，卡池
 * 漂移）按 replayDriver 同款语义截断，已覆盖部分照常出报告（notice 说明）。
 */
export function runMatchReview(
  recording: ReplayRecording,
  viewerId: PlayerId,
  options: MatchReviewOptions = {},
): MatchReview {
  const engine = createEngine()
  const depth = options.depth ?? (recording.actions.length > REVIEW_ADAPTIVE_ACTION_LIMIT ? 'normal' : 'hard')
  const bot = createAiPlayer({
    playerId: viewerId,
    difficulty: depth,
    seed: deriveAiSeed(recording.seed, viewerId),
  })

  const setup: GameSetup = { seed: recording.seed, players: recording.players }
  let state = engine.initGame(setup)

  const steps: ReviewStep[] = []
  const lethalMissedSteps: number[] = []
  let notice: string | null = null

  for (let actionIndex = 0; actionIndex < recording.actions.length; actionIndex += 1) {
    const before = engine.viewFor(state, viewerId)
    if (before.phase === 'ended') {
      notice = `对局已在第 ${actionIndex} 个动作前结束，其后 ${recording.actions.length - actionIndex} 个残余动作未复盘`
      break
    }

    const actual = recording.actions[actionIndex] as Action

    // 结算实际动作（推进 + 评分共用这一次真实结算）
    let applied: EngineResult | null = null
    try {
      applied = engine.applyAction(state, actual)
    } catch (error) {
      if (error instanceof RuleError) {
        notice = `第 ${actionIndex + 1} 个动作无法重放（与当前卡池版本不符）：${error.message}，复盘覆盖此前 ${steps.length} 个决策点`
        break
      }
      throw error
    }

    // viewer 决策点：viewer 是行动方且对局未结束
    if (before.activePlayer === viewerId && before.phase === 'main') {
      const legal = engine.getLegalActions(state, viewerId)
      const aiChoice = bot.decideNextAction(engine, sealState(state)) ?? endTurnFallback(legal, viewerId)

      // 漏斩检测（一步模拟，引擎真实结算）
      const winActions = findImmediateWinActions(engine, state, viewerId)
      const actualIsWin = winActions.some((action) => actionKey(action) === actionKey(actual))
      const lethalMissed = winActions.length > 0 && !actualIsWin

      // 分差：实际后局面 vs AI 选择后局面（viewer 视角各评一次，终局分支做口径归一化）
      const actualView = engine.viewFor(applied.state, viewerId)
      const evalActual = evalBranch(actualView)
      let evalDelta = 0
      let aiRejectedNote: string | undefined
      let aiView: PlayerView | undefined
      try {
        aiView = engine.viewFor(engine.applyAction(state, aiChoice).state, viewerId)
      } catch (error) {
        // 引擎不变量告警（合法集成员被拒，理论不发生）：该步退化为零分差保报告可用
        if (!(error instanceof RuleError)) throw error
        aiRejectedNote = 'AI 候选结算异常（引擎不变量告警）'
      }
      if (aiView) evalDelta = evalActual - evalBranch(aiView)

      // 档位：漏斩是定义上的最差决策（赢就在桌面上了）→ 直接 C（delta 仍如实记录）；
      // 其余按「与 AI 一致 = S，否则带符号分差分档」
      const identical = actionKey(actual) === actionKey(aiChoice)
      const score: ReviewGrade = lethalMissed ? 'C' : identical ? 'S' : gradeForDelta(evalDelta)

      const note = joinNotes(
        lethalMissed ? '漏斩：本步存在一击致胜线路未执行' : undefined,
        aiView ? buildDeltaNote(actualView, aiView) : undefined,
        voucherWasteNote(before, actual),
        aiRejectedNote,
      )

      if (lethalMissed) lethalMissedSteps.push(actionIndex)
      steps.push({ actionIndex, score, actual, aiChoice, evalDelta, ...(note ? { note } : {}) })
    }

    state = applied.state
  }

  // 汇总
  const scores: Record<ReviewGrade, number> = { S: 0, A: 0, B: 0, C: 0 }
  for (const step of steps) scores[step.score] += 1
  const overall =
    steps.length === 0
      ? 100
      : Math.round(steps.reduce((sum, step) => sum + REVIEW_GRADE_WEIGHTS[step.score], 0) / steps.length)

  const rank = (step: ReviewStep): number => REVIEW_GRADE_WEIGHTS[step.score] * 1000 + step.evalDelta
  const topMisses = steps
    .filter((step) => step.score !== 'S')
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 3)
    .map((step) => ({
      actionIndex: step.actionIndex,
      reason: step.note ?? `评估分差 ${step.evalDelta >= 0 ? '+' : ''}${step.evalDelta.toFixed(2)}`,
    }))

  return { viewerId, steps, scores, overall, topMisses, lethalMissedSteps, notice }
}
