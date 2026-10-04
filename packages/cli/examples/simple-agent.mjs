// 硅牌 AI Agent 挑战 · 最小驱动示例（Node 20+，零依赖）
//
// 用法（两个终端，均在仓库根目录执行）：
//   终端 1： yarn workspace @siliconcard/cli play --mode file --seed 42
//            —— 启动行会打印交换目录绝对路径（默认：仓库根下的 silicon-card-game/）
//   终端 2： node packages/cli/examples/simple-agent.mjs silicon-card-game
//
// 协议：读 <dir>/turn.json（state 视图 + legalActions）→ 写 <dir>/action.json
//       → CLI 结算后重写 turn.json（seq 递增）……直到出现 <dir>/gameover.json。
// 规则速查（本脚本之外唯一需要的资料）：docs/agent-skill.md
// 场上单位敌我区分：turn.state.board[].ownerId（"P1"=你 / "P2"=AI）。

import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const dir = process.argv[2] ?? 'silicon-card-game'
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]
let seenSeq = -1 // 只对没处理过的最新 turn.json 出招（防旧局面动作砸回新局面）

while (!existsSync(`${dir}/gameover.json`)) {
  if (!existsSync(`${dir}/turn.json`)) continue // 等 CLI 写出第一回合
  let turn
  try {
    turn = JSON.parse(readFileSync(`${dir}/turn.json`, 'utf8')) // 极小概率撞上重写瞬间，读坏就下轮重读
  } catch {
    continue
  }
  if (turn.seq === seenSeq || turn.phase === 'ended') continue
  seenSeq = turn.seq

  // —— 策略区：从 turn.legalActions 里挑一条 ——
  // 回执语义：turn.lastSettled 声明 CLI 对上一次提交的裁决（accepted=false=被拒，
  // lastError.hint 给纠正指引；lastSettled 未指向你的动作=还没被消费，继续等）。
  // 演示从简：被拒就先稳健收尾。
  const byKind = (kind) => turn.legalActions.filter((l) => l.kind === kind)
  const endTurn = turn.legalActions.find((l) => l.kind === 'END_TURN')
  const rejected = turn.lastSettled && turn.lastSettled.accepted === false
  const chosen = rejected
    ? endTurn
    : (turn.turn <= 10 && byKind('PLAY_CARD').length > 0 && pick(byKind('PLAY_CARD'))) ||
      pick(byKind('ATTACK').length ? byKind('ATTACK') : []) ||
      endTurn ||
      turn.legalActions[0]

  writeFileSync(`${dir}/action.json`, JSON.stringify({ action: chosen.action }))
  console.log(`[T${turn.seq}] 已提交动作：${chosen.action.type}`)
}

const over = JSON.parse(readFileSync(`${dir}/gameover.json`, 'utf8'))
console.log(`对局结束：${over.winner ?? '平局'}（${over.endReason}）· ${over.turns} 回合`)
