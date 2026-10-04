/**
 * file 模式（M3-AGT1）——文件回合制：外部 agent 最省事的接入方式。
 *
 * 目录约定（--dir 指定，默认仓库根下的 silicon-card-game/）：
 * - turn.json     —— CLI 写：轮到你了（state 视图 + legalActions + lastSettled/lastError + help）
 * - action.json   —— 外部 agent 写：{ "action": <turn.json 的 legalActions[].action 原样> }
 * - gameover.json —— CLI 终局写一次（winner / finalState / 全程 log+events）
 * - protocol-readme.txt —— 开局写一次的协议速读（给误入目录的 agent 的路标）
 *
 * 轮转规则（终审第 2 轮修复后的回执语义）：
 * 1. CLI 写 turn.json（seq 递增；lastSettled=上一次动作的裁决回执，lastError 与其同源）；
 * 2. agent 轮询发现 seq 变化后提交 action.json；
 * 3. CLI 轮询发现动作文件 → 读取成功后**立即删除**（消费语义：一个动作只结算一次）；
 *    读取失败（半文件）同样删除并以 UNKNOWN_ACTION 出回执；
 * 4. 结算：接受 → 推进（含 AI 回合）；拒绝 → 状态不变；
 * 5. 无论接受/拒绝/解析失败，都重写 turn.json（seq+1），lastSettled 指向该次裁决——
 *    **CLI 绝不静默丢弃动作文件**：agent 提交后若新状态的 lastSettled 仍是上一个动作，
 *    说明提交尚未被消费，继续等待即可。
 *
 * 注：CLI 结算/AI 回合期间 agent 提前写入的动作不会被删除（旧版会），下一个轮询
 * 周期会被正常消费——若局面已变则引擎拒绝并出回执，agent 按 lastError 纠正重发。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { FILE_PROTOCOL, PROTOCOL_HELP, buildGameOverMessage, buildStateMessage, eventsToLog, parseAgentAction, toProtocolError, type GameOverMessage, type LastSettledInfo } from '../protocol'
import { AGENT_PLAYER, type AgentMatch } from '../driver'

export interface FileModeOptions {
  dir: string
  /** 轮询 action.json 的间隔毫秒（默认 250；测试可调小） */
  pollMs?: number
  /** 等待 action.json 的超时毫秒；0 = 一直等（默认 0） */
  waitTimeoutMs?: number
  /** 进度输出（人读，默认 stdout；测试可静音） */
  log?: (line: string) => void
}

function fileReadme(dir: string): string {
  return `硅牌 Agent 对战 · 文件回合制协议（${FILE_PROTOCOL}）

本交换目录（绝对路径）：${dir}

轮到你了    ：读 turn.json（state=你视角的战局，legalActions=当前全部合法动作，
              每条带 summary 人话；state.board 每个单位带 ownerId:"P1"|"P2" 区分敌我，
              instanceId 供目标引用；cardId 含义查 cardGlossary）。
行动       ：写 action.json —— { "action": <legalActions 里任选一条的 action 对象原样> }。
回执       ：动作提交后等 turn.json 的 seq 变化，看 lastSettled——
             accepted=true：已结算（可提交下一个）；
             accepted=false：被拒，lastError.hint 给纠正指引，改完重写 action.json 即可，
             对局状态不受影响；
             lastSettled 仍是上一个动作：本次提交尚未被消费，继续等。
             lastError 与 seq 在同一次原子写入中出现，绝不会迟到丢失。
终局       ：出现 gameover.json 即结束（winner / finalState / 全程 log 与 events）。

找不到目录？CLI 启动行会打印本目录的绝对路径；默认目录固定在仓库根下的
silicon-card-game/（与调用命令的位置无关）。

完整规则与动作 schema：仓库 docs/agent-skill.md。
`
}

/** 原子写（tmp + rename）：外部 agent 可能在任意时刻读 turn.json，绝不让它读到半个文件 */
function writeFileStrict(path: string, data: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** 跑完一局文件回合制对局，返回终局消息（同时已写入 gameover.json） */
export async function runFileMode(match: AgentMatch, options: FileModeOptions): Promise<GameOverMessage> {
  const dir = resolve(options.dir)
  const pollMs = options.pollMs ?? 250
  const waitTimeoutMs = options.waitTimeoutMs ?? 0
  const log = options.log ?? ((): void => {})
  mkdirSync(dir, { recursive: true })
  const turnPath = resolve(dir, 'turn.json')
  const actionPath = resolve(dir, 'action.json')
  const overPath = resolve(dir, 'gameover.json')
  rmSync(overPath, { force: true })
  rmSync(actionPath, { force: true }) // 仅开局清一次残留（对局期间动作文件只在消费点删除）
  writeFileSync(resolve(dir, 'protocol-readme.txt'), fileReadme(dir), 'utf8')

  let lastSettled: LastSettledInfo | null = null
  const fullLog: string[] = []

  while (!match.over) {
    // 1) 写「轮到你了」（seq 递增；lastSettled/lastError 随同一对象原子写入）
    const stateMsg = buildStateMessage(match, { lastSettled, protocol: FILE_PROTOCOL })
    fullLog.push(...stateMsg.log)
    writeFileStrict(turnPath, stateMsg)
    log(`[turn ${stateMsg.turn}] 等待 action.json（合法动作 ${stateMsg.legalActions.length} 条）`)

    // 2) 轮询等待动作文件
    const started = Date.now()
    for (;;) {
      if (existsSync(actionPath)) break
      if (waitTimeoutMs > 0 && Date.now() - started > waitTimeoutMs) {
        throw new Error(
          `等待 action.json 超时（${waitTimeoutMs}ms）：外部 agent 应向 ${actionPath} 写入 { "action": <turn.json 的 legalActions[].action> }。可用 --wait-timeout 调大。`,
        )
      }
      await sleep(pollMs)
    }

    // 3) 读取并立即删除（消费语义；动作文件在等待期间不存在被吞窗口）
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(actionPath, 'utf8'))
    } catch (error) {
      rmSync(actionPath, { force: true })
      lastSettled = {
        accepted: false,
        error: { code: 'UNKNOWN_ACTION', message: `action.json 不是合法 JSON：${String(error)}`, hint: PROTOCOL_HELP.howToAct.file },
      }
      log('[turn ?] action.json 解析失败，已出回执')
      continue
    }
    rmSync(actionPath, { force: true })

    const parsed = parseAgentAction(raw)
    if ('error' in parsed) {
      lastSettled = { accepted: false, error: parsed.error }
      continue
    }

    // 4) 结算
    const outcome = match.applyAgentAction(parsed.action)
    if (!outcome.ok && outcome.error) {
      const protocolError = toProtocolError(outcome.error)
      lastSettled = { accepted: false, action: parsed.action, error: protocolError }
      log(`[turn ${match.state.turn}] 动作被拒：${protocolError.code}`)
      continue
    }
    lastSettled = { accepted: true, action: parsed.action }
    log(`[turn ${match.state.turn}] 动作已结算：${parsed.action.type}`)

    // 5) 轮到 AI 则连续结算其回合（事件并入下一张 turn.json 的 log）
    if (!match.over && !match.agentTurn) match.runAiTurns()
  }

  // 终局前最后一次结算的事件（agent 侧或 AI 侧）尚未冲洗，补进全程日志
  const finalEvents = match.takeEvents()
  fullLog.push(...eventsToLog(match.engine.viewFor(match.state, AGENT_PLAYER), finalEvents))

  const over = buildGameOverMessage(match, fullLog, FILE_PROTOCOL)
  writeFileStrict(overPath, over)
  rmSync(actionPath, { force: true })
  rmSync(turnPath, { force: true })
  log(`对局结束：${over.winner ?? '平局'}（${over.endReason ?? '-'}），gameover.json 已写入`)
  return over
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}
