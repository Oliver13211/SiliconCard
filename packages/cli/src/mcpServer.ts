/**
 * MCP server 核心（M3-AGT4，可选任务）——零新增 npm 依赖的最小 stdio JSON-RPC 实现。
 *
 * 范围裁决：MCP stdio 传输 = 每行一个 JSON-RPC 2.0 消息（无 Content-Length 头），
 * initialize / tools/list / tools/call 三件套即可覆盖「开局 / 查看 / 出牌」，
 * 不需要官方 SDK——满足任务「零依赖且最小实现才做」的前提，故实装。
 *
 * 工具（对齐 play 的双模式语义）：
 * - silicon_start：开局（seed/difficulty/deck/opponentDeck，缺省同 play）→ 返回 StateMessage
 * - silicon_view：查看当前局面（StateMessage：state 视图 + legalActions + lastError）
 * - silicon_act：提交动作（同 stdio 模式的 parse/结算/拒绝语义）→ StateMessage | GameOverMessage
 *
 * 会话模型：单会话（server 内当前对局）。silicon_start 重开即替换；对局结束后
 * silicon_act 返回 GAME_ENDED 提示，需重新 silicon_start。
 */

import type { Action } from '@siliconcard/core'
import { RuleError } from '@siliconcard/core'
import type { Difficulty } from '@siliconcard/ai'
import { CLI_VERSION } from './args'
import { loadContent, resolveDeckChoice, type ContentData, type DeckChoice } from './content'
import { AgentMatch } from './driver'
import {
  buildGameOverMessage,
  buildStateMessage,
  parseAgentAction,
  toProtocolError,
  type GameOverMessage,
  type ProtocolError,
  type StateMessage,
} from './protocol'

const MCP_PROTOCOL_VERSION = '2024-11-05'

export const MCP_SERVER_INFO = { name: 'siliconcard-mcp', version: CLI_VERSION } as const

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'silicon_start',
    description:
      '开局一局硅牌对战：你执 P1 先手，对手是内置 AI（执 P2）。参数均可省略（seed=42, difficulty=normal, deck=nvidia-flagship-faith, opponentDeck=amd-war-future）。返回完整局面与当前合法动作。',
    inputSchema: {
      type: 'object',
      properties: {
        seed: { type: 'integer', minimum: 0, description: '引擎随机种子，同 seed + 同动作序列可复现整局' },
        difficulty: { type: 'string', enum: ['easy', 'normal', 'hard'], description: '内置 AI 难度' },
        deck: { type: 'string', description: '你的卡组：content 预组卡组 id 或卡组 JSON 路径' },
        opponentDeck: { type: 'string', description: '对手卡组：同上' },
      },
    },
  },
  {
    name: 'silicon_view',
    description:
      '查看当前对局：你视角的战局（state）、全部合法动作（legalActions，每条带 summary 与可原样回传的 action）、事件日志（log）。对局未开始时提示先调 silicon_start。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'silicon_act',
    description:
      '提交一个动作。action 必须是 silicon_view 返回的 legalActions[].action 原样对象（照抄最稳）。非法动作会返回 code/hint 纠正指引，对局状态不变，改完重发即可。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'object', description: 'legalActions[].action 原样，如 { "type": "END_TURN", "playerId": "P1" }' },
      },
      required: ['action'],
    },
  },
]

export interface McpSession {
  match: AgentMatch
  seed: number
  difficulty: Difficulty
  agentDeck: DeckChoice
  opponentDeck: DeckChoice
}

/** server 运行时状态（可注入 content，测试友好） */
export class McpServerCore {
  session: McpSession | null = null
  private content: ContentData | null = null

  constructor(content?: ContentData) {
    this.content = content ?? null
  }

  private ensureContent(): ContentData {
    this.content ??= loadContent()
    return this.content
  }

  private startGame(args: Record<string, unknown>): StateMessage {
    const content = this.ensureContent()
    const seedRaw = args['seed'] ?? 42
    const seed = typeof seedRaw === 'number' && Number.isInteger(seedRaw) && seedRaw >= 0 ? seedRaw : 42
    const diffRaw = args['difficulty']
    const difficulty: Difficulty = diffRaw === 'easy' || diffRaw === 'hard' || diffRaw === 'normal' ? diffRaw : 'normal'
    const deckArg = typeof args['deck'] === 'string' ? args['deck'] : undefined
    const opponentDeckArg = typeof args['opponentDeck'] === 'string' ? args['opponentDeck'] : undefined
    const agentDeck = resolveDeckChoice(deckArg, 'nvidia-flagship-faith', content, 'deck')
    const opponentDeck = resolveDeckChoice(opponentDeckArg, 'amd-war-future', content, 'opponent-deck')
    const match = new AgentMatch({ seed, difficulty, agentDeck, opponentDeck })
    this.session = { match, seed, difficulty, agentDeck, opponentDeck }
    return buildStateMessage(match, { protocol: 'siliconcard.mcp/1' })
  }

  private viewGame(): StateMessage {
    if (!this.session) throw new McpToolError('对局未开始：先调用 silicon_start 开局。')
    return buildStateMessage(this.session.match, { protocol: 'siliconcard.mcp/1' })
  }

  private actGame(args: Record<string, unknown>): StateMessage | GameOverMessage {
    if (!this.session) throw new McpToolError('对局未开始：先调用 silicon_start 开局。')
    const match = this.session.match
    if (match.over) {
      return buildGameOverMessage(match, [], 'siliconcard.mcp/1')
    }
    const parsed = parseAgentAction(args['action'])
    if ('error' in parsed) {
      throw new McpToolError(`${parsed.error.message} ${parsed.error.hint}`, parsed.error)
    }
    const outcome = match.applyAgentAction(parsed.action as Action)
    if (!outcome.ok && outcome.error) {
      const protocolError = toProtocolError(outcome.error)
      throw new McpToolError(`${protocolError.message} ${protocolError.hint}`, protocolError)
    }
    if (!match.over && !match.agentTurn) match.runAiTurns()
    if (match.over) return buildGameOverMessage(match, [], 'siliconcard.mcp/1')
    return buildStateMessage(match, { protocol: 'siliconcard.mcp/1' })
  }

  private callTool(name: unknown, args: unknown): unknown {
    const toolArgs = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {}
    switch (name) {
      case 'silicon_start':
        return this.startGame(toolArgs)
      case 'silicon_view':
        return this.viewGame()
      case 'silicon_act':
        return this.actGame(toolArgs)
      default:
        // 未知工具按 MCP 惯例以工具层错误返回（isError:true），便于客户端把指路信息展示给模型
        throw new McpToolError(
          `未知工具「${String(name)}」。可用：${MCP_TOOLS.map((t) => t.name).join(' / ')}。`,
        )
    }
  }

  /**
   * 处理一行 JSON-RPC 消息，返回应回写的响应对象（通知类返回 null）。
   * 解析失败（非法 JSON）由调用方负责产出 -32700。
   */
  handleMessage(raw: string): unknown | null {
    let msg: unknown
    try {
      msg = JSON.parse(raw)
    } catch {
      return jsonRpcError(null, -32700, 'Parse error: 该行不是合法 JSON')
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
      return jsonRpcError(null, -32600, 'Invalid Request: 消息必须是 JSON-RPC 2.0 对象')
    }
    const obj = msg as Record<string, unknown>
    const id = obj['id'] ?? null
    const method = obj['method']
    if (typeof method !== 'string') {
      return jsonRpcError(id, -32600, 'Invalid Request: 缺少 method 字段')
    }
    if (id === null || id === undefined) {
      // 通知（如 notifications/initialized）：不回包
      return null
    }
    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: MCP_SERVER_INFO,
              instructions:
                '硅牌 Agent 对战：先 silicon_start 开局，再 silicon_view 查看局面（legalActions 每条带人话 summary），silicon_act 提交动作（action 原样回传 legalActions[].action）。规则速查：仓库 docs/agent-skill.md。',
            },
          }
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } }
        case 'tools/call': {
          const params = obj['params'] !== null && typeof obj['params'] === 'object' ? (obj['params'] as Record<string, unknown>) : {}
          let payload: unknown
          try {
            payload = this.callTool(params['name'], params['arguments'])
          } catch (error) {
            if (error instanceof McpToolError) {
              return {
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: JSON.stringify(error.protocolError ?? { error: error.message }) }], isError: true },
              }
            }
            throw error
          }
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false } }
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} }
        default:
          return jsonRpcError(id, -32601, `Method not found: ${method}（可用：initialize / tools/list / tools/call / ping）`)
      }
    } catch (error) {
      if (error instanceof RuleError) {
        const protocolError = toProtocolError(error)
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(protocolError) }], isError: true } }
      }
      return jsonRpcError(id, -32603, `Internal error: ${String(error)}`)
    }
  }
}

/** 工具层失败：以 isError:true 的工具结果返回（协议层仍成功），带纠正指引 */
export class McpToolError extends Error {
  readonly protocolError?: ProtocolError
  constructor(message: string, protocolError?: ProtocolError) {
    super(message)
    this.protocolError = protocolError
  }
}

function jsonRpcError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } }
}
