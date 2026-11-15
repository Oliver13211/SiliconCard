/**
 * AI 复盘评分引擎单测（P2-QA1）—— 无头，全部经 core 公开四函数与录制体（脚本/自对弈）构造。
 *
 * 验收对照（docs/phase2-plan.md §P2-QA1）：
 * - 正常跟 AI = S：Hard-vs-Hard 自对弈录制全档 S（Hard 决策 = 局面纯函数，零噪声零 dropout）；
 * - 明显亏模 = C：脚本构造「攥着兵不打的收工动作」被标 C；
 * - 漏斩检测 100% 检出、无非漏斩误报：构造局面级（findImmediateWinActions）+ 整局级
 *   （火花脚本：漏斩回合被标、无漏斩对照局零标记）；
 * - 券在手时的决策：后手券局 AI 同样先打券 → S；
 * - 确定性：同输入两次 runMatchReview 全量相等；
 * - 30 步对局 < 10s：实测远低于红线（见 perf 用例输出）；
 * - 防作弊闸门不回归：复盘的 AI 决策走 sealState 封印快照（全部用例经该路径，封印
 *   状态下读取原始字段即抛错——player.test.ts 既有闸门测试语义在复盘链路继续生效）。
 */

import { beforeAll, describe, expect, test } from 'vitest'
import {
  createEngine,
  VOUCHER_BONUS,
  VOUCHER_UID,
  type Action,
  type BoardUnit,
  type DeckSpec,
  type Engine,
  type GameSetup,
  type GameState,
  type PlayerId,
  type PlayerView,
  type ReplayRecording,
} from '@siliconcard/core'
import { makeAiDeckSpec, registerAiCardPool } from './cardPool'
import {
  findImmediateWinActions,
  gradeForDelta,
  REVIEW_DELTA_A,
  REVIEW_DELTA_C,
  REVIEW_GRADE_WEIGHTS,
  runMatchReview,
} from './review'
import { runSelfPlayGame } from './selfplay'

beforeAll(() => registerAiCardPool())
const engine = createEngine()

function deckOf(cardId: string): DeckSpec {
  return { cards: [{ cardId, count: 30 }] }
}

const SPARK_SETUP: GameSetup = {
  seed: 20261115,
  players: [
    { id: 'P1', faction: 'nvidia', deck: deckOf('ai-spark') },
    { id: 'P2', faction: 'amd', deck: deckOf('ai-zap') },
  ],
}

/** 自对弈录制体（与 selfplay harness 同款确定性装配：种子 + 合成卡组 + 动作序列） */
function recordingFromSelfplay(seed: number, difficulty: 'normal' | 'hard' | 'easy'): ReplayRecording {
  const result = runSelfPlayGame(engine, {
    seed,
    sides: { P1: { difficulty }, P2: { difficulty } },
  })
  expect(result.anomalies).toEqual([]) // 录制体本身零异常（零崩溃零非法的前置）
  return {
    seed,
    players: [
      { id: 'P1', faction: 'nvidia', deck: makeAiDeckSpec() },
      { id: 'P2', faction: 'amd', deck: makeAiDeckSpec() },
    ],
    actions: result.actionLog.map((line) => JSON.parse(line) as Action),
  }
}

// ———— 脚本录制体构建（harness 级：与 selfplay 同层读视图推进，非 AI 决策代码） ————

interface ScriptCtx {
  engine: Engine
  state: GameState
  turn: number
  actionsThisTurn: number
  attacksThisTurn: number
}

type Picker = (legal: readonly Action[], view: PlayerView, ctx: ScriptCtx) => Action | null

function endTurnOf(legal: readonly Action[], who: PlayerId): Action {
  const end = legal.find((a): a is Extract<Action, { type: 'END_TURN' }> => a.type === 'END_TURN')
  if (!end) throw new Error(`脚本构建：${who} 无 END_TURN`)
  return end
}

function buildScriptedActions(setup: GameSetup, pickers: Record<PlayerId, Picker>, maxActions = 80): Action[] {
  let state = engine.initGame(setup)
  const actions: Action[] = []
  let lastTurn = -1
  let actionsThisTurn = 0
  let attacksThisTurn = 0
  while (state.phase === 'main' && actions.length < maxActions) {
    const who = state.activePlayer
    const view = engine.viewFor(state, who)
    if (view.turn !== lastTurn) {
      lastTurn = view.turn
      actionsThisTurn = 0
      attacksThisTurn = 0
    }
    const legal = engine.getLegalActions(state, who)
    const action = pickers[who](legal, view, { engine, state, turn: view.turn, actionsThisTurn, attacksThisTurn })
    if (!action) break
    actions.push(action)
    if (action.type === 'ATTACK') attacksThisTurn += 1
    actionsThisTurn += 1
    state = engine.applyAction(state, action).state
  }
  return actions
}

/** P1：全 spark，铺场优先 + 全员打脸 */
const sparkPicker: Picker = (legal, view) => {
  const faceAttack = legal.find(
    (a): a is Extract<Action, { type: 'ATTACK' }> =>
      a.type === 'ATTACK' && a.target.kind === 'hero' && a.target.playerId === view.opponent.id,
  )
  const play = legal.find((a): a is Extract<Action, { type: 'PLAY_CARD' }> => a.type === 'PLAY_CARD')
  if (play) return play
  if (faceAttack) return faceAttack
  return endTurnOf(legal, 'P1')
}

/**
 * P1 漏斩样本：第一次出现「一击致胜」时故意收工（END_TURN）——已知漏斩样本，
 * 之后恢复正常（补刀收尾）。missArmed.done 由闭花持有。
 */
function sparkMissOncePicker(missArmed: { done: boolean }): Picker {
  return (legal, view, ctx) => {
    if (!missArmed.done && findImmediateWinActions(ctx.engine, ctx.state, 'P1').length > 0) {
      missArmed.done = true
      return endTurnOf(legal, 'P1')
    }
    return sparkPicker(legal, view, ctx)
  }
}

const endTurnPicker: Picker = (legal, view) => endTurnOf(legal, view.you.id)

/** P2：第 1 个自身回合（全局 turn 2）依次 打券 → 打砖 → 收 */
const voucherP2Picker: Picker = (legal, view, ctx) => {
  if (ctx.turn === 2 && ctx.actionsThisTurn === 0) {
    const voucher = legal.find(
      (a): a is Extract<Action, { type: 'PLAY_CARD' }> => a.type === 'PLAY_CARD' && a.uid === VOUCHER_UID,
    )
    if (!voucher) throw new Error('脚本构建：P2 起手无券可打')
    return voucher
  }
  if (ctx.turn === 2 && ctx.actionsThisTurn === 1) {
    const brick = legal.find((a): a is Extract<Action, { type: 'PLAY_CARD' }> => a.type === 'PLAY_CARD')
    if (!brick) throw new Error('脚本构建：券后无牌可打')
    return brick
  }
  return endTurnOf(legal, view.you.id)
}

describe('复盘档位阈值（纯函数 gradeForDelta）', () => {
  test('带符号分差分档：≥ -0.5 为 A、> -2 为 B、≤ -2 为 C；比 AI 更优不惩罚', () => {
    expect(gradeForDelta(0)).toBe('A')
    expect(gradeForDelta(2.4)).toBe('A') // 打得比 Hard AI 更好 → A（不惩罚）
    expect(gradeForDelta(REVIEW_DELTA_A)).toBe('A') // 边界 -0.5 含于 A
    expect(gradeForDelta(REVIEW_DELTA_A - 0.01)).toBe('B')
    expect(gradeForDelta(-1.5)).toBe('B')
    expect(gradeForDelta(REVIEW_DELTA_C)).toBe('C') // 边界 -2 含于 C
    expect(gradeForDelta(REVIEW_DELTA_C - 0.01)).toBe('C')
    expect(gradeForDelta(-4.95)).toBe('C')
  })
})

describe('漏斩检测 findImmediateWinActions（构造局面级）', () => {
  /** 清场摆一枚 P1 大哥（charge + 攻 5 + 可攻） */
  function craftedBoard(extraEnemy?: BoardUnit): GameState {
    const state = engine.initGame(SPARK_SETUP)
    const striker: BoardUnit = {
      instanceId: 'u9001',
      cardId: 'ai-spark',
      ownerId: 'P1',
      attack: 5,
      health: 1,
      maxHealth: 1,
      keywords: ['charge'],
      summonedOnTurn: 1,
      attacksRemaining: 1,
      attackedThisTurn: false,
    }
    state.board = extraEnemy ? [striker, extraEnemy] : [striker]
    return state
  }

  test('构造一击致死局面：100% 检出打脸斩杀动作，模拟后立即 viewer 胜', () => {
    const state = craftedBoard()
    state.players.P2.health = 3
    const wins = findImmediateWinActions(engine, state, 'P1')
    expect(wins).toHaveLength(1)
    const win = wins[0] as Extract<Action, { type: 'ATTACK' }>
    expect(win.attackerId).toBe('u9001')
    expect(win.target).toEqual({ kind: 'hero', playerId: 'P2' })
    const after = engine.viewFor(engine.applyAction(state, win).state, 'P1')
    expect(after.phase).toBe('ended')
    expect(after.winner).toBe('P1')
  })

  test('护甲计入血线：5 攻打 30 血 + 2 甲 → 无斩杀（无非漏斩误报）', () => {
    const state = craftedBoard()
    state.players.P2.health = 30
    state.players.P2.armor = 2
    expect(findImmediateWinActions(engine, state, 'P1')).toEqual([])
  })

  test('嘲讽拦截：脸攻击不合法、杀嘲讽不终局 → 不误报漏斩', () => {
    const state = craftedBoard({
      instanceId: 'u9002',
      cardId: 'ai-glitch',
      ownerId: 'P2',
      attack: 1,
      health: 1,
      maxHealth: 1,
      keywords: ['taunt'],
      summonedOnTurn: 1,
      attacksRemaining: 0,
      attackedThisTurn: false,
    })
    state.players.P2.health = 3
    expect(findImmediateWinActions(engine, state, 'P1')).toEqual([])
  })

  test('轮不到 viewer → 不检测（空集）', () => {
    const state = craftedBoard()
    state.players.P2.health = 3
    expect(findImmediateWinActions(engine, state, 'P2')).toEqual([])
  })
})

describe('整局复盘（脚本 + 自对弈录制体）', () => {
  test('正常跟 AI = S：Hard-vs-Hard 自对弈录制全档 S、overall 100、零漏斩', () => {
    for (const seed of [7, 42, 2026]) {
      const recording = recordingFromSelfplay(seed, 'hard')
      const review = runMatchReview(recording, 'P1')
      expect(review.steps.length).toBeGreaterThan(0)
      expect(review.steps.every((step) => step.score === 'S')).toBe(true)
      expect(review.scores).toEqual({ S: review.steps.length, A: 0, B: 0, C: 0 })
      expect(review.overall).toBe(100)
      expect(review.lethalMissedSteps).toEqual([])
      expect(review.notice).toBeNull()
    }
  })

  test('明显亏模 = C：起手攥着 1/3 嘲讽不打、直接收工 → 首步 C 且带解释', () => {
    const cSetup: GameSetup = {
      seed: 888,
      players: [
        { id: 'P1', faction: 'nvidia', deck: deckOf('ai-glitch') },
        { id: 'P2', faction: 'amd', deck: deckOf('ai-zap') },
      ],
    }
    const actions = buildScriptedActions(cSetup, { P1: endTurnPicker, P2: endTurnPicker }, 6)
    const review = runMatchReview({ ...cSetup, actions }, 'P1')
    expect(review.steps.length).toBe(3) // P1 的三个收工决策点
    for (const step of review.steps) {
      expect(step.score).toBe('C')
      expect(step.evalDelta).toBeLessThanOrEqual(REVIEW_DELTA_C)
      expect(step.note).toContain('场面') // 尽力解释：AI 选择更优（场面亏 X 分）
      expect(step.aiChoice.type).toBe('PLAY_CARD') // Hard AI 每步都会把嘲讽铺出去
    }
    expect(review.lethalMissedSteps).toEqual([])
    expect(review.overall).toBeLessThanOrEqual(REVIEW_GRADE_WEIGHTS.C + 5)
    expect(review.topMisses.length).toBe(3)
  })
  test('漏斩检出：构造一击致死局面故意收工 → 该步标记漏斩 + C；无漏斩对照局零标记', () => {
    const missArmed = { done: false }
    const missActions = buildScriptedActions(SPARK_SETUP, {
      P1: sparkMissOncePicker(missArmed),
      P2: endTurnPicker,
    })
    expect(missArmed.done).toBe(true) // 脚本确实遇到了一击致死局面
    const missReview = runMatchReview({ ...SPARK_SETUP, actions: missActions }, 'P1')
    expect(missReview.lethalMissedSteps).toHaveLength(1)
    const missStep = missReview.steps.find((step) => step.actionIndex === missReview.lethalMissedSteps[0])
    expect(missStep).toBeDefined()
    expect(missStep?.note).toContain('漏斩')
    expect(missStep?.score).toBe('C')
    expect(missReview.topMisses.some((miss) => miss.actionIndex === missReview.lethalMissedSteps[0])).toBe(true)

    // 对照：同一脚本不漏斩（补刀收尾）→ 全局零标记（无非漏斩误报）
    const cleanActions = buildScriptedActions(SPARK_SETUP, { P1: sparkPicker, P2: endTurnPicker })
    expect(cleanActions.length).toBeLessThan(80) // 脚本走到对局自然结束（斩杀获胜）
    const cleanReview = runMatchReview({ ...SPARK_SETUP, actions: cleanActions }, 'P1')
    expect(cleanReview.lethalMissedSteps).toEqual([])
  })

  test('券在手时的决策：后手券局，AI 同样先用券解锁高费卡 → 券步/解锁步/收工步全 S', () => {
    // 前置依赖 VOUCHER_BONUS = 40（P2-ENG1 定稿 + 2026-11-15 bench 校准定值）：
    // 100W 首回合 + 券恰好解锁 140W 砖（brick cost 140 = 100 + 40，cardPool 同步）。
    expect(VOUCHER_BONUS).toBe(40)
    const voucherSetup: GameSetup = {
      seed: 777,
      players: [
        { id: 'P1', faction: 'nvidia', deck: deckOf('ai-zap') },
        { id: 'P2', faction: 'amd', deck: deckOf('ai-brick') },
      ],
    }
    // 动作 0..4：P1 收 / P2 券 → 砖 → 收 / P1 收
    const actions = buildScriptedActions(voucherSetup, { P1: endTurnPicker, P2: voucherP2Picker }, 5)
    expect(actions.length).toBe(5)
    const review = runMatchReview({ ...voucherSetup, actions }, 'P2')
    expect(review.steps.map((step) => step.actionIndex)).toEqual([1, 2, 3])
    for (const step of review.steps) expect(step.score).toBe('S')
    const voucherStep = review.steps[0]
    expect(voucherStep).toBeDefined()
    if (!voucherStep) throw new Error('unreachable: 券步必存在')
    expect(voucherStep.actual.type).toBe('PLAY_CARD')
    if (voucherStep.actual.type === 'PLAY_CARD') expect(voucherStep.actual.uid).toBe(VOUCHER_UID)
    expect(voucherStep.aiChoice.type).toBe('PLAY_CARD')
    if (voucherStep.aiChoice.type === 'PLAY_CARD') expect(voucherStep.aiChoice.uid).toBe(VOUCHER_UID)
    expect(review.scores.S).toBe(3)
    expect(review.overall).toBe(100)
    expect(review.lethalMissedSteps).toEqual([])
  })

  test('确定性：同录制体两次复盘，产出逐字段全等', () => {
    const recording = recordingFromSelfplay(7, 'normal')
    const first = runMatchReview(recording, 'P1')
    const second = runMatchReview(recording, 'P1')
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(first.steps.length).toBeGreaterThan(0)
  })

  test('样本分布回归：normal 视角对 Hard 基准的 C 档占比 < 5%，easy 显著更高', () => {
    const cRatioOf = (difficulty: 'normal' | 'easy'): number => {
      let total = 0
      let c = 0
      for (const seed of [11, 33, 55, 77, 99, 2026]) {
        const review = runMatchReview(recordingFromSelfplay(seed, difficulty), 'P1')
        total += review.steps.length
        c += review.scores.C
      }
      return c / total
    }
    const normalRatio = cRatioOf('normal')
    const easyRatio = cRatioOf('easy')
    expect(normalRatio).toBeLessThan(0.05)
    expect(easyRatio).toBeGreaterThan(normalRatio)
    // 校准实测（12 局 × 双视角）：normal 683 步 C 占 1.3%，easy 648 步 C 占 14.7%
  })

  test('截断容错：终局后残余动作 / 卡池漂移非法动作 → notice 说明、不抛异常', () => {
    const cleanActions = buildScriptedActions(SPARK_SETUP, { P1: sparkPicker, P2: endTurnPicker })
    // 残余动作：对局已结束再补一步
    const residual = runMatchReview(
      { ...SPARK_SETUP, actions: [...cleanActions, { type: 'END_TURN', playerId: 'P1' }] },
      'P1',
    )
    expect(residual.notice).toContain('残余动作未复盘')
    // 非法动作（卡池漂移语义）：对局进行中的录制体插入一步未知 uid 的出牌 → 该处截断
    const voucherSetup: GameSetup = {
      seed: 777,
      players: [
        { id: 'P1', faction: 'nvidia', deck: deckOf('ai-zap') },
        { id: 'P2', faction: 'amd', deck: deckOf('ai-brick') },
      ],
    }
    const liveActions = buildScriptedActions(voucherSetup, { P1: endTurnPicker, P2: voucherP2Picker }, 5)
    const illegal = runMatchReview(
      { ...voucherSetup, actions: [...liveActions, { type: 'PLAY_CARD', playerId: 'P2', uid: 'h999' }] },
      'P1',
    )
    expect(illegal.notice).toContain('无法重放')
    expect(illegal.notice).toContain(`${liveActions.length + 1}`)
  })

  test('批量冒烟：20 局 × 双视角复盘零崩溃，产出不变量成立', () => {
    for (const seed of [101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212, 1313, 1414, 1515, 1616, 1717, 1818, 1919, 2020]) {
      const recording = recordingFromSelfplay(seed, 'normal')
      for (const viewerId of ['P1', 'P2'] as const) {
        const review = runMatchReview(recording, viewerId)
        expect(review.viewerId).toBe(viewerId)
        expect(review.overall).toBeGreaterThanOrEqual(0)
        expect(review.overall).toBeLessThanOrEqual(100)
        const stepCount = review.steps.length
        expect(review.scores.S + review.scores.A + review.scores.B + review.scores.C).toBe(stepCount)
        expect(review.topMisses.length).toBeLessThanOrEqual(3)
        const graded = new Set(review.steps.map((step) => step.actionIndex))
        for (const missed of review.lethalMissedSteps) expect(graded.has(missed)).toBe(true)
        for (const miss of review.topMisses) {
          expect(graded.has(miss.actionIndex)).toBe(true)
          expect(miss.reason.length).toBeGreaterThan(0)
        }
      }
    }
  })

  test('性能红线：50+ 动作对局 Hard 全模拟复盘远低于 10s（实测打印）', () => {
    const recording = recordingFromSelfplay(15, 'hard')
    expect(recording.actions.length).toBeGreaterThanOrEqual(30)
    const started = performance.now()
    const review = runMatchReview(recording, 'P1')
    const elapsed = performance.now() - started
    console.log(`[perf] ${recording.actions.length} 动作 / ${review.steps.length} 决策点 → ${elapsed.toFixed(1)}ms`)
    expect(elapsed).toBeLessThan(10_000)
  })
})
