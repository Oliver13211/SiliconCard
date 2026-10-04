/**
 * 协议层（M3-AGT1）——对外的 JSON 消息契约。
 *
 * 两条铁律（预设硬约束）：
 * - 状态输出自解释：viewFor 裁剪视图 + 带语义的 legalActions + cardGlossary 图鉴
 *   + help 块，外部 agent 不需要读源码或文档就能理解每条消息；
 * - 非法动作的错误信息指导自行纠正：RuleError 的 code / message / detail 全透出，
 *   另加 hint 字段给出下一步怎么改；状态未变，agent 重发 action 即可，无需重启。
 *
 * 两种承载（同一套消息结构）：
 * - file 模式：turn.json / action.json / gameover.json 轮转；
 * - stdio 模式：stdin/stdout 每行一个 JSON 消息。
 */

import type { Action, GameEvent, PlayerView, RuleErrorCode } from '@siliconcard/core'
import { RuleError } from '@siliconcard/core'
import {
  describeLegalActions,
  eventToLine,
  glossaryEntry,
  heroPowerEntry,
  type LegalActionEntry,
} from './describe'
import { AGENT_PLAYER, type AgentMatch } from './driver'

export const FILE_PROTOCOL = 'siliconcard.file/1'
export const STDIO_PROTOCOL = 'siliconcard.stdio/1'
export const CLI_PROTOCOL_VERSION = '0.1.0'

/** 视角内出现过的 cardId → 图鉴（自解释的关键：cardId 只在图鉴里有含义） */
export type CardGlossary = Record<string, ReturnType<typeof glossaryEntry>>

function collectGlossary(view: PlayerView): CardGlossary {
  const glossary: CardGlossary = {}
  const ids = new Set<string>(view.you.hand.map((c) => c.cardId))
  for (const unit of view.board) ids.add(unit.cardId)
  for (const id of ids) {
    const entry = glossaryEntry(id)
    if (entry) glossary[id] = entry
  }
  return glossary
}

function heroPowers(view: PlayerView): Record<string, ReturnType<typeof heroPowerEntry>> {
  const out: Record<string, ReturnType<typeof heroPowerEntry>> = {}
  const you = heroPowerEntry(view.you.faction)
  const opponent = heroPowerEntry(view.opponent.faction)
  if (you) out[view.you.faction] = you
  if (opponent) out[view.opponent.faction] = opponent
  return out
}

/** 错误码 → 纠正指引（要求：agent 只看这条 hint 就知道怎么改下一次动作） */
export const ERROR_HINTS: Readonly<Record<RuleErrorCode, string>> = {
  GAME_ENDED: '对局已结束：读取 gameover（file 模式 gameover.json / stdio gameover 消息）收尾，不要再发动作。',
  NOT_YOUR_TURN: '现在轮不到你：等 CLI 下一次写 turn.json（stdio 下一条 state 消息）再发动作。',
  UNKNOWN_ACTION: '动作结构不合法：action 必须是 legalActions[].action 里的对象原样（type/playerId 等字段齐全）。',
  CARD_NOT_IN_HAND: 'uid 不在你的手牌：只能用最新 state.you.hand 列出的 uid；最稳妥是从 legalActions 里整条复制 action。',
  INSUFFICIENT_MANA: '功耗不足：本回合剩余功耗见 state.you.mana，只能打出 cost ≤ mana 的牌，或改发 END_TURN 结束回合。',
  INVALID_TARGET: '目标不合法：detail.reason 说明了原因；合法目标已全部展开在 legalActions 里，选一条带 target 的原样回传。',
  UNIT_NOT_ON_BOARD: 'attackerId 不在你场上：只能攻击 state.board 里 ownerId === "P1" 的单位，且 attacksRemaining > 0。',
  UNIT_CANNOT_ATTACK: '该单位本回合不能攻击（攻击次数用尽，或入场当回合失调——charge 者除外）。换别的单位或 END_TURN。',
  TAUNT_BLOCKING: '敌方有信仰充值（taunt）单位在场：必须先攻击 taunt 单位，合法目标已展开在 legalActions。',
  BOARD_FULL: '场上扩展槽已满（BOARD_LIMIT=7）：先换掉场面（或打 driver 法术），下一回合再上单位。',
  DECK_INVALID: '卡组不合法：总数必须等于 30 张且所有 cardId 已注册；检查 --deck / --opponent-deck 的 JSON。',
  HERO_POWER_USED: '派系技能本回合已用过（每回合一次）：改出牌 / 攻击，或 END_TURN。',
  FACTION_UNREGISTERED: '派系技能未注册：使用内置四系（nvidia / amd / intel / neutral）的卡组。',
}

export interface ProtocolError {
  code: RuleErrorCode
  message: string
  detail?: Record<string, unknown>
  /** 下一步怎么改（纠正指引，agent 无需问人） */
  hint: string
}

/**
 * 动作裁决回执（M3 终审第 2 轮缺陷 1 修复）：每张 turn.json / state 消息都声明
 * 「本次状态是对 agent 哪个动作的回应」——
 * - accepted=true：action 已被引擎结算（可能连带 AI 回合），可提交下一个动作；
 * - accepted=false：action 被拒绝（error 带纠正指引），改完直接重发，状态未受影响；
 * - agent 提交动作后，若新状态的 lastSettled 仍是上一个动作（本次提交未被提及），
 *   说明动作文件尚未被消费，继续等待即可——CLI 绝不静默丢弃动作文件。
 * lastError 是 lastSettled.error 的快捷视图（accepted=false 时才有值），与 seq 同一对象
 * 一次原子写入，不存在「seq 已递增而错误信息迟到」的中间态。
 */
export interface LastSettledInfo {
  accepted: boolean
  /** 被裁决的动作（JSON 解析失败等无法还原动作时缺省） */
  action?: Action
  /** accepted=false 时的拒绝原因与纠正指引 */
  error?: ProtocolError
}

export function toProtocolError(error: RuleError): ProtocolError {
  const hint = ERROR_HINTS[error.code] ?? '检查动作字段与最新 legalActions 是否一致，重发即可。'
  return {
    code: error.code,
    message: error.message,
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
    hint,
  }
}

export const PROTOCOL_HELP = {
  howToAct: {
    file: '把要执行的动作写入 action.json：{ "action": <legalActions 里任意一条的 action 对象原样> }。提交后等 turn.json 的 seq 变化并看 lastSettled 回执：accepted=true=已结算可提交下一个；accepted=false=被拒，按 lastError.hint 改完重发；lastSettled 仍是上一个动作=尚未消费，继续等。',
    stdio: '向 stdout 发一行 JSON：{ "type": "action", "action": <legalActions 里任意一条的 action 对象原样> }，然后等下一条 state 消息并按 lastSettled 回执处理（同 file 模式）。',
  },
  actionTypes: {
    PLAY_CARD: '{ type:"PLAY_CARD", playerId:"P1", uid:<手牌 uid>, target?:{ kind:"unit", instanceId } | { kind:"hero", playerId } }',
    ATTACK: '{ type:"ATTACK", playerId:"P1", attackerId:<己方单位 instanceId>, target:<同上 TargetRef> }',
    USE_HERO_POWER: '{ type:"USE_HERO_POWER", playerId:"P1", target?:(技能需要指定目标时) }',
    END_TURN: '{ type:"END_TURN", playerId:"P1" }',
    CONCEDE: '{ type:"CONCEDE", playerId:"P1" }',
  },
  targetRef: 'TargetRef = { kind:"unit", instanceId:"<board 里的实例 id>" } 或 { kind:"hero", playerId:"P1"|"P2" }；合法取值已展开在每条 legalActions 里，照抄即可。',
  stateDigest: '顶层 turn/phase/activePlayer/winner 是 state 同名字段的便捷副本（同源，免解嵌套）。state.you=你的公开数值+手牌；手牌条目是轻量引用 {uid, cardId, cost}——卡名/效果查 cardGlossary[cardId]（legalActions[].summary 也已内联卡名）。state.opponent=对手仅计数。state.board=双方场上单位全量，ownerId:"P1"|"P2" 区分敌我（判定攻击/换血目标必看），instanceId 供 TargetRef 引用，attacksRemaining>0 才能攻击。',
  rulesDigest: '供电 100W/回合（上限 1000W）随出牌消耗；单位入场当回合不能攻击（charge 例外）；手牌上限 10、场上每方至多 7；一方体质归零即负，牌库抽空则疲劳递增扣血。',
  fullDoc: 'docs/agent-skill.md（仓库根目录）——规则速查 + 动作 schema 逐字段 + 策略提示。',
} as const

/** 每次轮到 agent 决策时 CLI 写出的完整状态消息（turn.json / stdio state） */
export interface StateMessage {
  protocol: string
  message: 'state'
  /** 递增序号：同一文件被重写时可区分新旧（file 模式防读旧） */
  seq: number
  you: typeof AGENT_PLAYER
  opponentKind: string
  turn: number
  phase: 'main' | 'ended'
  activePlayer: 'P1' | 'P2'
  waitingFor: 'P1' | 'P2'
  winner: 'P1' | 'P2' | null
  endReason: 'health_zero' | 'concede' | null
  /** viewFor(P1) 裁剪视图：你=完整手牌，对手=仅计数 */
  state: PlayerView
  /** 当前全部合法动作（含原样 action + 人话 summary） */
  legalActions: LegalActionEntry[]
  /** 本消息涉及 cardId 的图鉴 */
  cardGlossary: CardGlossary
  heroPowers: Record<string, ReturnType<typeof heroPowerEntry>>
  /** 自上一条状态消息以来的人话事件日志 */
  log: string[]
  /** 自上一条状态消息以来的引擎原始事件（需要精确消费时用） */
  events: GameEvent[]
  /** 上一次动作裁决回执（null=尚无任何裁决）；提交动作后以它确认「被拒/被接受/未消费」 */
  lastSettled: LastSettledInfo | null
  /** lastSettled.accepted=false 时的快捷视图（= lastSettled.error；无错为 null），与 seq 同次原子写入 */
  lastError: ProtocolError | null
  /** 协议静态说明（自解释兜底） */
  help: typeof PROTOCOL_HELP
}

/** 对局结束消息（file 模式 gameover.json / stdio gameover 消息） */
export interface GameOverMessage {
  protocol: string
  message: 'gameover'
  seed: number
  winner: 'P1' | 'P2' | null
  endReason: 'health_zero' | 'concede' | null
  turns: number
  totalEvents: number
  finalState: PlayerView
  /** 全程人话日志（自首条消息累积到终局，条数与对局事件总量一致） */
  log: string[]
  /** 全程引擎原始事件（复盘/录像用途；totalEvents 条） */
  events: GameEvent[]
  aiAnomalies: string[]
  goodbye: string
}

/** 组装「轮到你了」状态消息（seq 按 match 递增；protocol 标识承载方式，file/stdio 各自传入） */
export function buildStateMessage(
  match: AgentMatch,
  options?: { lastSettled?: LastSettledInfo | null; protocol?: string },
): StateMessage {
  const view = match.engine.viewFor(match.state, AGENT_PLAYER)
  const legal = match.engine.getLegalActions(match.state, AGENT_PLAYER)
  const events = match.takeEvents()
  const seq = match.nextSnapshotSeq()
  const lastSettled = options?.lastSettled ?? null
  return {
    protocol: options?.protocol ?? STDIO_PROTOCOL,
    message: 'state',
    seq,
    you: AGENT_PLAYER,
    opponentKind: `内置 AI（${match.difficulty}）`,
    turn: view.turn,
    phase: view.phase,
    activePlayer: view.activePlayer,
    waitingFor: AGENT_PLAYER,
    winner: view.winner,
    endReason: match.state.endReason,
    state: view,
    legalActions: describeLegalActions(view, legal),
    cardGlossary: collectGlossary(view),
    heroPowers: heroPowers(view),
    log: events.map((e) => eventToLine(view, e)),
    events,
    lastSettled,
    lastError: lastSettled && !lastSettled.accepted ? (lastSettled.error ?? null) : null,
    help: PROTOCOL_HELP,
  }
}

/** 组装终局消息（log/events 为全程完整记录，来源 match.allEvents） */
export function buildGameOverMessage(
  match: AgentMatch,
  fullLog: string[] = [],
  protocol: string = STDIO_PROTOCOL,
): GameOverMessage {
  const view = match.engine.viewFor(match.state, AGENT_PLAYER)
  return {
    protocol,
    message: 'gameover',
    seed: match.seed,
    winner: view.winner,
    endReason: match.state.endReason,
    turns: view.turn,
    totalEvents: match.eventCount,
    finalState: view,
    log: fullLog,
    events: [...match.allEvents],
    aiAnomalies: [...match.aiAnomalies],
    goodbye: `对局结束。胜者：${view.winner ?? '平局'}（${match.state.endReason ?? '-'}）。想再来一局？重跑同一条 play 命令，换 --seed 试试新对局。`,
  }
}

/** 外部动作输入解析：接受 {"type":"action","action":{...}}、{"action":{...}} 或裸动作对象 */
export function parseAgentAction(raw: unknown): { action: Action } | { error: ProtocolError } {
  let candidate: unknown = raw
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      return { error: { code: 'UNKNOWN_ACTION', message: '输入不是合法 JSON', hint: ERROR_HINTS.UNKNOWN_ACTION } }
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { error: { code: 'UNKNOWN_ACTION', message: '动作必须是 JSON 对象', hint: ERROR_HINTS.UNKNOWN_ACTION } }
  }
  const obj = candidate as Record<string, unknown>
  if ('action' in obj && obj['action'] !== undefined) candidate = obj['action']
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { error: { code: 'UNKNOWN_ACTION', message: '缺少 action 字段', hint: ERROR_HINTS.UNKNOWN_ACTION } }
  }
  const inner = candidate as Record<string, unknown>
  if (typeof inner['type'] !== 'string') {
    return {
      error: {
        code: 'UNKNOWN_ACTION',
        message: `动作缺少 type 字段（收到：${JSON.stringify(candidate)}）`,
        hint: 'action.type 必须是 PLAY_CARD / ATTACK / USE_HERO_POWER / END_TURN / CONCEDE 之一；最稳妥是从 legalActions 里整条复制。',
      },
    }
  }
  return { action: candidate as unknown as Action }
}

/** 事件 → 人话日志的便捷函数（file/stdio 的终局日志补全） */
export function eventsToLog(view: PlayerView, events: readonly GameEvent[]): string[] {
  return events.map((e) => eventToLine(view, e))
}
