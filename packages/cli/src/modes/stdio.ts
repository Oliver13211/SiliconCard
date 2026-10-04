/**
 * stdio 模式（M3-AGT1）——stdin/stdout JSON 行协议：每行一个 JSON 消息，适合
 * 被宿主程序（或带管道的脚本）直接驱动。
 *
 * 消息流（CLI → agent，stdout）：
 *   {"type":"hello", protocol, version, you, opponent, seed, howToAct, fullDoc}
 *   {"type":"state", ...StateMessage}        —— 轮到你了 / 动作被拒（lastError 带纠正 hint）
 *   {"type":"gameover", ...GameOverMessage}
 * agent → CLI（stdin）：
 *   {"type":"action", "action":{...}}        —— 也接受 {"action":{...}} 或裸动作对象
 *   {"type":"ping"}                          —— 可选心跳，回 {"type":"pong"}
 *
 * 约束：stdout 只输出协议 JSON（每行一条、UTF-8、无前缀）；一切人读进度走 stderr。
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import {
  CLI_PROTOCOL_VERSION,
  PROTOCOL_HELP,
  STDIO_PROTOCOL,
  buildGameOverMessage,
  buildStateMessage,
  eventsToLog,
  parseAgentAction,
  toProtocolError,
  type GameOverMessage,
  type LastSettledInfo,
  type StateMessage,
} from '../protocol'
import { AGENT_PLAYER, type AgentMatch } from '../driver'

export interface StdioModeOptions {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
  /** 进度输出（默认静音；play.ts 注入 stderr，保证 stdout 纯协议） */
  log?: (line: string) => void
}

function emit(output: NodeJS.WritableStream, message: unknown): void {
  output.write(JSON.stringify(message) + '\n')
}

type LineVerdict = 'continue' | 'gameEnded'

/** 跑完一局 stdio 行协议对局；输入流提前关闭且未终局时返回 null（对局放弃） */
export async function runStdioMode(match: AgentMatch, options: StdioModeOptions = {}): Promise<GameOverMessage | null> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const log = options.log ?? ((): void => {})
  const rl: ReadlineInterface = createInterface({ input, crlfDelay: Infinity })

  emit(output, {
    type: 'hello',
    protocol: STDIO_PROTOCOL,
    version: CLI_PROTOCOL_VERSION,
    you: AGENT_PLAYER,
    opponent: `内置 AI（${match.difficulty}）`,
    seed: match.seed,
    howToAct: PROTOCOL_HELP.howToAct.stdio,
    fullDoc: PROTOCOL_HELP.fullDoc,
  })

  let lastSettled: LastSettledInfo | null = null
  let settled = false
  const fullLog: string[] = []

  const emitState = (): StateMessage => {
    const msg = buildStateMessage(match, { lastSettled, protocol: STDIO_PROTOCOL })
    fullLog.push(...msg.log)
    emit(output, { type: 'state', ...msg })
    return msg
  }

  const emitGameOver = (): GameOverMessage => {
    const events = match.takeEvents()
    if (events.length > 0) {
      fullLog.push(...eventsToLog(match.engine.viewFor(match.state, AGENT_PLAYER), events))
    }
    const over = buildGameOverMessage(match, fullLog, STDIO_PROTOCOL)
    emit(output, { type: 'gameover', ...over })
    return over
  }

  /** 处理一行 agent 输入；'gameEnded' 表示本次动作直接终局 */
  const handleLine = (line: string): LineVerdict => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return 'continue'
    let raw: unknown
    try {
      raw = JSON.parse(trimmed)
    } catch (error) {
      lastSettled = { accepted: false, error: { code: 'UNKNOWN_ACTION', message: `该行不是合法 JSON：${String(error)}`, hint: PROTOCOL_HELP.howToAct.stdio } }
      return 'continue'
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      if ((raw as Record<string, unknown>)['type'] === 'ping') {
        emit(output, { type: 'pong', seq: (raw as Record<string, unknown>)['seq'] ?? null })
        return 'continue'
      }
    }
    const parsed = parseAgentAction(raw)
    if ('error' in parsed) {
      lastSettled = { accepted: false, error: parsed.error }
      return 'continue'
    }
    const outcome = match.applyAgentAction(parsed.action)
    if (!outcome.ok && outcome.error) {
      const protocolError = toProtocolError(outcome.error)
      lastSettled = { accepted: false, action: parsed.action, error: protocolError }
      log(`动作被拒：${protocolError.code}`)
      return 'continue'
    }
    lastSettled = { accepted: true, action: parsed.action }
    log(`动作已结算：${parsed.action.type}`)
    return match.over ? 'gameEnded' : 'continue'
  }

  emitState()

  return await new Promise<GameOverMessage | null>((resolve) => {
    const finish = (result: GameOverMessage | null, exitCode: number): void => {
      if (!settled) {
        settled = true
        rl.close()
        if (exitCode !== 0) process.exitCode = exitCode
        resolve(result)
      }
    }
    rl.on('line', (line: string) => {
      try {
        const verdict = handleLine(line)
        if (verdict === 'continue') {
          if (match.over) {
            finish(emitGameOver(), 0)
            return
          }
          if (!match.agentTurn) match.runAiTurns()
          if (match.over) {
            finish(emitGameOver(), 0)
            return
          }
          emitState()
        } else {
          finish(emitGameOver(), 0)
        }
      } catch (error) {
        // 引擎/环境级异常：响亮打出（stderr + 非零退出码），不让协议静默吞错
        log(`运行异常：${String(error)}`)
        finish(null, 1)
      }
    })
    rl.on('close', () => {
      if (!settled && !match.over) {
        log('stdin 已关闭且对局未终局：视为外部 agent 弃赛，不写 gameover。')
        finish(null, 1)
        return
      }
      finish(null, 0)
    })
  })
}
