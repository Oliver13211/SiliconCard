/**
 * 教程契约类型（P2-EDU1）。
 *
 * 架构定位（对齐 AGENTS.md 铁律 3）：
 * - 教程 = 受约束的对局。引擎仍是唯一事实源，教程控制器经 createEngine 的
 *   四函数接口驱动（initGame / applyAction / getLegalActions / viewFor），
 *   不自建任何对局事实；过关判定消费真实 GameEvent 事件流（纯函数）；
 * - 关卡内容（卡组 id / seed / 脚本规则 / 气泡文案 / 白名单 / 过关判定）
 *   全部数据驱动，集中在 levels.ts——改动教学内容不碰控制器与 UI 代码；
 * - 脚本对手是"对局驱动方"角色（与 BattleDriver 托管 AI 同一架构位置），
 *   为编排关卡需要读完整 state 生成动作——这是 driver 层的合法职责，
 *   玩家侧 HUD 仍只经 viewFor 视图观察。
 */

import type {
  Action,
  BoardUnit,
  GameEvent,
  GameState,
  PlayerId,
  PlayerView,
  TargetRef,
} from '@siliconcard/core'

// —— 脚本对手（按规则触发的轻规则，禁用 AI 随机性）——

/** 脚本动作（解析成真实 Action 前的教学意图，见 scripted.ts） */
export type ScriptAction =
  | { kind: 'play'; cardId: string }
  /** 攻击；target 由 targetRule 解析（缺省走 genericAttackTarget 优先级） */
  | { kind: 'attack'; attackerCardId: string; targetCardId?: string }
  | { kind: 'attackHero'; attackerCardId: string }
  | { kind: 'endTurn' }

/**
 * 一条脚本规则：每个 P2 回合自上而下求值，第一条产出非空动作列表的规则生效，
 * 之后不再求值（保证每回合至多一组动作、行为可精确编排）。求值只读 state。
 */
export interface ScriptRule {
  id: string
  pick: (state: Readonly<GameState>) => readonly ScriptAction[]
}

/** P2 行为档案（levels.ts 数据引用 scripted.ts 的内置规则集） */
export type P2Profile =
  | { kind: 'passer' }
  /** 场上没自己的单位就打 cardId，其余回合结束（靶子投放） */
  | { kind: 'spawner'; cardId: string }
  /** 投放 cardId + 每回合用场上单位按通用目标优先级攻击（嘲讽/质保/潜行演示共用） */
  | { kind: 'aggressive'; cardId: string }
  /** 投放 cardId；仅在对方存在 divine_shield 单位时攻击该单位（质保演示专用） */
  | { kind: 'shieldDemo'; cardId: string }
  /** L4 毕业战陪练：按确定性轻规则对打（出牌×2 + 换血优先攻击） */
  | { kind: 'sparring' }

// —— 白名单门控（可交互性 = getLegalActions 收窄，UI 入口拦截）——

/**
 * 单步白名单。缺省字段 = 放行；显式给出 = 收窄。
 * 全部为纯函数（数据驱动，可单测）；裁决输入只来自 view + getLegalActions 投影，
 * 门控层不读完整 state（玩家侧不越权）。
 */
export interface StepGate {
  /** 允许打出的卡（按 cardId）；'all' 或缺省 = 全部放行 */
  allowPlayCardIds?: readonly string[] | 'all'
  /** 允许宣告攻击的攻击者（按 cardId）；'all' 或缺省 = 全部放行 */
  allowAttackCardIds?: readonly string[] | 'all'
  /** 允许使用派系技能；缺省 true */
  allowHeroPower?: boolean
  /** 允许结束回合（谓词可表达"素材未到手时放行 / 打出前不许收工"）；缺省 true */
  allowEndTurn?: (view: PlayerView, events: readonly GameEvent[]) => boolean
  /** 允许确认的目标（confirmTarget 终闸）；缺省放行 */
  allowTarget?: (target: TargetRef, view: PlayerView) => boolean
  /** 拦截时的教学提示（缺省通用文案） */
  blockCopy?: string
}

// —— 步骤机与关卡数据 ——

export type EventMatcher = (event: GameEvent) => boolean

/** 单个教学步骤（气泡 + 白名单 + 推进条件） */
export interface TutorialStep {
  id: string
  bubble: { title: string; body: string }
  /** 事件匹配 → 推进到下一步（缺省 = 本步等待过关判定或终局） */
  advanceOn?: EventMatcher
  gate?: StepGate
}

/** 事件流过关判定（纯函数：整段事件流 → 是否过关）；返回 null 表示未过关 */
export type ObjectiveCheck = (events: readonly GameEvent[]) => boolean | null

/** 关1..5 顶层关卡；关3 拆 7 节（每节一场独立迷你对局） */
export interface TutorialLevel {
  id: number
  name: string
  subtitle: string
  /** 简报页正文（梗化但准确） */
  brief: string
  /** 目标标签（HUD 目标条） */
  objectiveLabel: string
  /** 目标进度（纯函数；缺省无进度条） */
  objectiveProgress?: (events: readonly GameEvent[]) => { done: number; total: number }
  /** 固定 seed（引擎确定性保证整关可复现） */
  seed: number
  /** P1 预组卡组 id（content/decks/tutorial-*.json） */
  playerDeckId: string
  /** P1 派系；L4 由玩家在简报页选择（缺省 neutral） */
  playerFaction?: string
  /** P2 脚本卡组 id */
  scriptDeckId: string
  /** P2 行为档案 */
  p2Profile: P2Profile
  /** 步骤机（关1/2/3 节）；缺省 = 单步自由关（L4） */
  steps?: readonly TutorialStep[]
  /** 过关判定（消费真实事件流） */
  objective: ObjectiveCheck
  /** 过关后小结（完成页正文） */
  summary: string
  /** 关3 分节（有分节时 level.select 走分节列表） */
  sections?: readonly TutorialSection[]
  /** L4：玩家自选派系（简报页出派系选择器） */
  chooseFaction?: boolean
  /** L5：无对局，结业导航（进真实 SetupScreen） */
  graduation?: boolean
}

/** 关3 的单个关键词节（= 一场迷你对局 + 独立判定与进度） */
export interface TutorialSection {
  id: string
  keyword: string
  keywordLabel: string
  name: string
  brief: string
  objectiveLabel: string
  seed: number
  playerDeckId: string
  scriptDeckId: string
  p2Profile: P2Profile
  steps: readonly TutorialStep[]
  objective: ObjectiveCheck
  summary: string
}

/** 教学节/关在步骤机上的运行时上下文（controller 持有，门控与判定消费） */
export interface TutorialContext {
  level: TutorialLevel
  section: TutorialSection | null
  stepIndex: number
  events: readonly GameEvent[]
}

// —— 控制器 → UI 帧回调 ——

export type FrameListener = (frame: TutorialFrame) => void

export interface TutorialFrame {
  view: PlayerView
  legalActions: readonly Action[]
  events: readonly GameEvent[]
  seed: number
}

/** 控制器状态快照（桥接层同步进 zustand store） */
export interface TutorialStatus {
  phase: 'idle' | 'running' | 'passed' | 'failed'
  levelId: number | null
  sectionId: string | null
  stepIndex: number
  bubble: { title: string; body: string } | null
  objectiveLabel: string
  objectiveProgress: { done: number; total: number } | null
  /** 玩家动作被白名单拦截时的教学提示 */
  nudge: string | null
}

// —— 工具（跨模块复用的小型纯函数）——

/** 事件流实例登记表：instanceId → 场上单位快照（MINION_SUMMONED 时登记） */
export function unitRegistryOf(events: readonly GameEvent[]): Map<string, BoardUnit> {
  const registry = new Map<string, BoardUnit>()
  for (const event of events) {
    if (event.type === 'MINION_SUMMONED') registry.set(event.unit.instanceId, event.unit)
  }
  return registry
}

/** 玩家动作归属（借实例登记表把 ATTACK_DECLARED 的 attackerId 归到卡/主人） */
export function ownerOfInstance(registry: Map<string, BoardUnit>, instanceId: string): PlayerId | null {
  return registry.get(instanceId)?.ownerId ?? null
}

export function cardIdOfInstance(registry: Map<string, BoardUnit>, instanceId: string): string | null {
  return registry.get(instanceId)?.cardId ?? null
}
