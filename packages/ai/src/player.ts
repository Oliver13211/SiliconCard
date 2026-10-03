/**
 * 内置人机决策体（M1-AI1）——工厂 createAiPlayer。
 *
 * 硬约束（预设铁律）：
 * - 只经 engine.getLegalActions(state, playerId) 与 engine.viewFor(state, playerId)
 *   观察局面；传入的 state 一律先 revealState 解封再整体交给引擎四函数，
 *   决策代码绝不直接读取 GameState 的任何原始字段（sealState 运行时闸门守护）；
 * - 决策随机（噪声 / dropout）走注入 seed 的包内 RNG，同 seed + 同局面 → 同决策。
 *
 * 决策流程（每次调用产出「下一个动作」，由调用方结算后再取下一个）：
 * 1. 斩杀线检测：本回合可用打脸伤害 ≥ 对方（血量+护甲）→ 只走直伤打脸，尽快收束；
 * 2. 逐合法动作一次模拟评估（Normal 深度 = 1，不做全宽度搜索）：
 *    engine.applyAction 在引擎内部对副本结算（真状态 RNG 不被消费），
 *    以 evaluateView 给每个候选打分——出牌/攻击/技能的价值差异全部由引擎
 *    真实结算结果说话，不自行复刻效果语义；
 * 3. 加成项：打脸攻击 +faceAttackBonus（无嘲讽阻拦时的进攻倾向）、
 *    派系技能 +heroPowerBias（功耗富余时用技能）；CONCEDE 永不入选；
 * 4. 难度分级（评估精度 × 噪声）：Easy 高噪声 + 概率放弃斩杀 + top-K 抖动；
 *    Normal 低噪声贪心；Hard 零噪声 + 攻击候选附加「对手最佳攻击反制」两步预演。
 *
 * 调用方集成（client bot.ts 替换 / server 虚拟玩家 / 自对弈 harness 同构）：
 * ```ts
 * const bot = createAiPlayer({ playerId: 'P2', difficulty: 'normal', seed })
 * // 引擎 state 更新且轮到 P2 时循环：
 * const action = bot.decideNextAction(engine, state)   // 返回 null 表示非其回合/对局已结束
 * if (action) state = engine.applyAction(state, action).state
 * ```
 */

import {
  RuleError,
  type Action,
  type Engine,
  type GameState,
  type PlayerId,
  type PlayerView,
} from '@siliconcard/core'
import { evaluateView } from './evaluate'
import { actionFaceDamage, isLethalAvailable, lethalCandidateActions } from './lethal'
import { createAiRng, deriveAiSeed } from './rng'
import { revealState } from './sealed'

/** 难度分级：评估精度 / 噪声比例 / 收束倾向（M1 只承诺 Normal 达标，Easy/Hard 同构给出） */
export type Difficulty = 'easy' | 'normal' | 'hard'

export interface DifficultyProfile {
  /** 评估噪声振幅（±分）：Easy 高噪声漏最优，Hard 零噪声 */
  noiseAmplitude: number
  /** 每次决策以该概率放弃贪心最优、从前 topK 抖动取一（Easy 专属手感） */
  dropoutRate: number
  /** dropout 时的候选宽度 */
  topK: number
  /** 攻击打脸加成：无嘲讽阻拦时的进攻倾向（分） */
  faceAttackBonus: number
  /** 派系技能使用加成（分）：功耗富余时倾向用掉 */
  heroPowerBias: number
  /** 每次决策以该概率跳过斩杀检测（Easy 专属失误） */
  lethalSkipRate: number
  /** Hard：打脸攻击候选附加对手最佳攻击反制的两步预演（换血交换的报复已在 1 层模拟内含） */
  replyLookahead: boolean
  /** 反制预演的候选上限（性能护栏） */
  replyCap: number
  /** 反制预演损失的折扣系数 */
  replyDiscount: number
}

export const DIFFICULTY_PROFILES: Readonly<Record<Difficulty, DifficultyProfile>> = {
  easy: {
    noiseAmplitude: 4,
    dropoutRate: 0.25,
    topK: 3,
    faceAttackBonus: 2,
    heroPowerBias: 0.6,
    lethalSkipRate: 0.4,
    replyLookahead: false,
    replyCap: 0,
    replyDiscount: 0,
  },
  normal: {
    noiseAmplitude: 1.2,
    dropoutRate: 0,
    topK: 1,
    faceAttackBonus: 2,
    heroPowerBias: 0.8,
    lethalSkipRate: 0,
    replyLookahead: false,
    replyCap: 0,
    replyDiscount: 0,
  },
  hard: {
    noiseAmplitude: 0,
    dropoutRate: 0,
    topK: 1,
    faceAttackBonus: 1,
    heroPowerBias: 0.8,
    lethalSkipRate: 0,
    replyLookahead: true,
    replyCap: 24,
    replyDiscount: 0.5,
  },
}

export interface CreateAiPlayerOptions {
  /** 执方玩家 id（'P1' | 'P2'） */
  playerId: PlayerId
  /** 难度，缺省 'normal' */
  difficulty?: Difficulty
  /**
   * 决策 RNG 种子（缺省 0 派生）——同 seed + 同局面 → 同决策，可复现调试。
   * 自对弈/服务端建议传由对局 seed 派生的值（见 deriveAiSeed）。
   */
  seed?: number
}

export interface AiPlayer {
  readonly playerId: PlayerId
  readonly difficulty: Difficulty
  /**
   * 决策一次：返回当前应执行的动作（必为本次内部 getLegalActions 枚举的成员）；
   * 轮不到该玩家或对局已结束时返回 null。返回的动作里含 END_TURN（收尾动作）。
   */
  decideNextAction(engine: Engine, state: Readonly<GameState>): Action | null
}

interface ScoredCandidate {
  action: Action
  score: number
}

export function createAiPlayer(options: CreateAiPlayerOptions): AiPlayer {
  const { playerId } = options
  const difficulty: Difficulty = options.difficulty ?? 'normal'
  const profile = DIFFICULTY_PROFILES[difficulty]
  const rng = createAiRng(options.seed ?? deriveAiSeed(0, playerId))

  /** 模拟一个候选动作并从本方视角打分；被引擎拒绝的候选（理论不发生）记为 -Infinity */
  const scoreCandidate = (engine: Engine, state: GameState, action: Action): number | null => {
    let result
    try {
      result = engine.applyAction(state, action)
    } catch (error) {
      if (error instanceof RuleError) return null // 枚举无幽灵动作是引擎不变量，命中即记最差
      throw error
    }
    const afterView = engine.viewFor(result.state, playerId)
    let score = evaluateView(afterView)
    if (action.type === 'ATTACK' && action.target.kind === 'hero') {
      score += profile.faceAttackBonus
      // Hard 两步预演：对手最佳攻击反制会让这波打脸/交换付出多少代价
      if (profile.replyLookahead) {
        score -= bestAttackReplyLoss(engine, result.state, afterView, profile)
      }
    }
    if (action.type === 'USE_HERO_POWER') score += profile.heroPowerBias
    score += (rng.nextFloat() * 2 - 1) * profile.noiseAmplitude
    return score
  }

  const decideNextAction = (engine: Engine, state: Readonly<GameState>): Action | null => {
    // state 唯一用法：解封后整体交给引擎四函数（防作弊闸门见 sealed.ts）
    const raw = revealState(state)
    const view = engine.viewFor(raw, playerId)
    if (view.phase !== 'main' || view.activePlayer !== playerId) return null
    const legal = engine.getLegalActions(raw, playerId)
    const endTurn = legal.find((a): a is Extract<Action, { type: 'END_TURN' }> => a.type === 'END_TURN')
    if (!endTurn) return null
    if (legal.length === 1) return endTurn

    // 1) 斩杀线检测（Easy 按概率漏检；Normal/Hard 必检）
    const skipLethal = profile.lethalSkipRate > 0 && rng.nextFloat() < profile.lethalSkipRate
    if (!skipLethal && isLethalAvailable(view, legal)) {
      let best: Action | undefined
      let bestDamage = -Infinity
      for (const candidate of lethalCandidateActions(view, legal)) {
        const damage = actionFaceDamage(candidate, view)
        if (damage > bestDamage) {
          bestDamage = damage
          best = candidate
        }
      }
      if (best) return best
    }

    // 2) 逐合法动作一次模拟评估（CONCEDE 永不评估、永不入选）
    const scored: ScoredCandidate[] = []
    for (const action of legal) {
      if (action.type === 'CONCEDE') continue
      const score = scoreCandidate(engine, raw, action)
      if (score !== null) scored.push({ action, score })
    }
    if (scored.length === 0) return endTurn
    const sorted = [...scored].sort((a, b) => b.score - a.score) // 稳定排序：同分保枚举序（END_TURN 优先）
    if (profile.dropoutRate > 0 && rng.nextFloat() < profile.dropoutRate) {
      const width = Math.min(profile.topK, sorted.length)
      const picked = sorted[rng.nextInt(width)] ?? sorted[0]
      if (picked) return picked.action
    }
    const best = sorted[0]
    return best ? best.action : endTurn
  }

  return { playerId, difficulty, decideNextAction }
}

/**
 * Hard 两步预演：模拟后假设对手立刻行动，取其最佳 ATTACK 反制给我方造成的
 * 最大局面损失（× 折扣系数）。只预演攻击类反制（交换是即时报复的主通道），
 * 候选数封顶 replyCap 控制单次决策成本。
 */
function bestAttackReplyLoss(
  engine: Engine,
  simulatedState: GameState,
  mySimulatedView: PlayerView,
  profile: DifficultyProfile,
): number {
  const opponentId = mySimulatedView.opponent.id
  const replies = engine
    .getLegalActions(simulatedState, opponentId)
    .filter((a): a is Extract<Action, { type: 'ATTACK' }> => a.type === 'ATTACK')
    .slice(0, profile.replyCap)
  if (replies.length === 0) return 0
  const before = evaluateView(mySimulatedView)
  let worstLoss = 0
  for (const reply of replies) {
    let result
    try {
      result = engine.applyAction(simulatedState, reply)
    } catch (error) {
      if (error instanceof RuleError) continue
      throw error
    }
    const loss = before - evaluateView(engine.viewFor(result.state, mySimulatedView.you.id))
    if (loss > worstLoss) worstLoss = loss
  }
  return worstLoss * profile.replyDiscount
}
