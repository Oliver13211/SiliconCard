/**
 * demo 入口（M3-AGT3）——内置 AI 自对弈观战：一条命令输出完整对局事件流。
 *
 * 一行观战（与 README「AI Agent 挑战」节保持一致）：
 *   yarn workspace @siliconcard/cli demo --seed 42
 *
 * 确定性：同 seed → 同一场对局（双方 AI 决策种子由对局 seed 派生，引擎随机走 seed RNG），
 * `demo --seed 42` 跑两遍输出逐行一致——这也是 --seed 确定性的最直观验证。
 */

import { CLI_VERSION, DEMO_USAGE, parseDemoArgs } from './args'
import { loadContent, resolveDeckChoice, UsageError } from './content'
import { runDemoMatch } from './demoRun'

function main(argv: string[]): void {
  const args = parseDemoArgs(argv)
  if (args.help) {
    process.stdout.write(DEMO_USAGE)
    return
  }
  if (args.version) {
    process.stdout.write(`@siliconcard/cli ${CLI_VERSION}\n`)
    return
  }

  const content = loadContent()
  const p1Deck = resolveDeckChoice(args.deck, 'nvidia-flagship-faith', content, 'deck')
  const p2Deck = resolveDeckChoice(args.opponentDeck, 'amd-war-future', content, 'opponent-deck')

  const out = (line: string): void => {
    process.stdout.write(line + '\n')
  }
  out(
    `硅牌演示 · seed=${args.seed} · P1（${p1Deck.name}，${p1Deck.faction}） vs P2（${p2Deck.name}，${p2Deck.faction}）· 双方 difficulty=${args.difficulty}`,
  )
  runDemoMatch({
    seed: args.seed,
    difficulty: args.difficulty,
    p1Deck,
    p2Deck,
    json: args.json,
    maxActions: args.maxActions,
    write: out,
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
