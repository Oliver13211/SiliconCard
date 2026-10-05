/**
 * @siliconcard/ai — 内置人机（启发式，M1-AI1 起）。
 *
 * 硬约束：只通过 core 公开接口博弈（getLegalActions + viewFor），
 * 禁止读取完整 GameState 作弊（运行时闸门见 src/sealed.ts，测试守护）。
 * 难度分级 = 评估深度 / 噪声（easy / normal / hard，见 DIFFICULTY_PROFILES）。
 *
 * ———— 对接方式（client bot.ts 替换 / server 虚拟玩家 / harness 同构）————
 *
 * 1. 创建 AI 实例（每局每方一个，实例内有决策 RNG 游标，勿跨局复用）：
 *
 * ```ts
 * import { createAiPlayer } from '@siliconcard/ai'
 * const bot = createAiPlayer({ playerId: 'P2', difficulty: 'normal', seed })
 * ```
 *
 * 2. 引擎 state 更新且轮到该玩家时，逐步取动作并结算（每次一个动作，
 *    结算后重新观察——与引擎「枚举 → 结算 → 再枚举」的契约同构）：
 *
 * ```ts
 * while (view.activePlayer === 'P2' && view.phase === 'main') {
 *   const action = bot.decideNextAction(engine, state) // null = 非其回合/已终局（防御）
 *   if (!action) break
 *   state = engine.applyAction(state, action).state
 *   // 消费 events 驱动演出……
 * }
 * ```
 *
 * 3. 卡牌定义与派系技能由宿主经 core 注册 API 注入（registerCardDefinitions /
 *    内置四系技能随 core 加载自动注册）；AI 读定义注册表只为「看牌面」，
 *    不触碰对局隐藏信息。
 *
 * 自对弈验收：runSelfPlayGame(engine, { seed }) —— 双 AI 同引擎单局对跑，
 * 100 局验收测试见 src/selfplay.test.ts（零崩溃 / 零非法 / 双方胜率 >20%）。
 */

export const AI_VERSION = '0.1.0' // M1-AI1：内置人机 Normal（启发式评估 + 三档难度）

export { createAiPlayer } from './player'
export type { AiPlayer, CreateAiPlayerOptions, Difficulty, DifficultyProfile } from './player'
export { DIFFICULTY_PROFILES } from './player'

export { evaluateView, keywordBonus, unitScore, KEYWORD_SCORE } from './evaluate'
export {
  actionFaceDamage,
  estimateAvailableFaceDamage,
  isLethalAvailable,
  lethalCandidateActions,
} from './lethal'

export { createAiRng, deriveAiSeed } from './rng'
export { sealState, revealState } from './sealed'

export { runSelfPlayGame, DEFAULT_MAX_ACTIONS } from './selfplay'
export type { SelfPlayConfig, SelfPlayResult, SelfPlaySideConfig } from './selfplay'

export {
  runDeckMatchup,
  runFactionBalance,
  createBalanceEngine,
} from './matchup'
export type {
  BalanceDeck,
  CardPlayStat,
  DeckMatchupConfig,
  DeckMatchupResult,
  FactionBalanceConfig,
  FactionBalanceReport,
  DeckOverallStat,
} from './matchup'

export { AI_CARD_POOL, makeAiDeckSpec, registerAiCardPool } from './cardPool'
