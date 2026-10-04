/**
 * play 入口（M3-AGT1）——外部 agent 对战 CLI。
 *
 * 一行上手（与 docs/agent-skill.md 保持一致）：
 *   yarn workspace @siliconcard/cli play --mode file --seed 42
 *   yarn workspace @siliconcard/cli play --mode stdio --seed 42
 *
 * 退出码：0 正常终局；2 用法错误；1 运行时错误 / 对局被弃。
 * stdio 模式下 stdout 只输出协议 JSON，人读进度全部走 stderr。
 */

import { resolve } from 'node:path'
import { PLAY_USAGE, parsePlayArgs } from './args'
import { defaultGameDir, loadContent, resolveDeckChoice, UsageError } from './content'
import { AgentMatch } from './driver'
import { runFileMode } from './modes/file'
import { runStdioMode } from './modes/stdio'
import { CLI_VERSION } from './args'

function main(argv: string[]): void {
  const args = parsePlayArgs(argv)
  if (args.help) {
    process.stdout.write(PLAY_USAGE)
    return
  }
  if (args.version) {
    process.stdout.write(`@siliconcard/cli ${CLI_VERSION}\n`)
    return
  }

  const content = loadContent()
  const agentDeck = resolveDeckChoice(args.deck, 'nvidia-flagship-faith', content, 'deck')
  const opponentDeck = resolveDeckChoice(args.opponentDeck, 'amd-war-future', content, 'opponent-deck')
  // 默认交换目录稳定落在仓库根（yarn workspace 会把 cwd 切到 packages/cli/，
  // 相对路径默认值会与文档不一致；显式 --dir 仍按相对 cwd 解析）
  const gameDir = args.dir ?? defaultGameDir()

  const progress =
    args.mode === 'stdio'
      ? (line: string): void => {
          process.stderr.write(line + '\n')
        }
      : (line: string): void => {
          process.stdout.write(line + '\n')
        }

  progress(
    `硅牌 Agent 对战 · seed=${args.seed} · 你=P1（${agentDeck.name}，${agentDeck.faction}） vs 内置 AI=${args.difficulty}（${opponentDeck.name}，${opponentDeck.faction}）`,
  )
  if (args.mode === 'file') {
    progress(`file 模式 · 交换目录（绝对路径）：${resolve(gameDir)}（turn.json / action.json / gameover.json 都在这里）`)
  }
  if (content.invalidCards.length > 0) {
    progress(`注意：content 中有 ${content.invalidCards.length} 张卡未通过结构校验被跳过（不影响本局已用卡组）。`)
  }

  const match = new AgentMatch({
    seed: args.seed,
    difficulty: args.difficulty,
    agentDeck,
    opponentDeck,
  })

  const run =
    args.mode === 'file'
      ? runFileMode(match, { dir: gameDir, pollMs: args.pollMs, waitTimeoutMs: args.waitTimeoutMs, log: progress })
      : runStdioMode(match, { log: progress })

  run
    .then((over) => {
      if (over) {
        progress(`胜者：${over.winner ?? '平局'}（${over.endReason ?? '-'}）· 共 ${over.turns} 回合 · ${over.totalEvents} 个事件`)
        if (over.aiAnomalies.length > 0) progress(`AI 异常记录（如实透出）：${over.aiAnomalies.join('；')}`)
      }
    })
    .catch((error: unknown) => {
      process.stderr.write(`[运行错误] ${String(error)}\n`)
      process.exit(1)
    })
}

try {
  main(process.argv.slice(2))
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`[用法错误] ${error.message}\n`)
    process.exit(2)
  }
  process.stderr.write(`[运行错误] ${String(error)}\n`)
  process.exit(1)
}
