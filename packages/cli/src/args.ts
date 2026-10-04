/**
 * CLI 参数解析（M3-AGT1）——零依赖手写解析，错误信息自带纠正指引。
 * 入口命令在 --help 与 docs/agent-skill.md 中写死为「一行可复制」：
 *   yarn workspace @siliconcard/cli play  --mode file --seed 42
 *   yarn workspace @siliconcard/cli demo  --seed 42
 */

import type { Difficulty } from '@siliconcard/ai'
import { UsageError } from './content'

export const CLI_VERSION = '0.1.0'

export const PLAY_USAGE = `硅牌 SiliconCard · Agent 对战 CLI（JSON 协议，外部 agent 执 P1 先手）

用法：
  yarn workspace @siliconcard/cli play [参数]

模式：
  --mode file|stdio     file=文件回合制（默认，最省事）：CLI 写 turn.json，
                        agent 写 action.json，终局写 gameover.json；
                        stdio=JSON 行协议：stdout 逐行输出 {type:"hello"|"state"|"gameover"}，
                        stdin 逐行收 {type:"action","action":{...}}
  --dir <path>          file 模式的交换目录（默认：仓库根下的 silicon-card-game/，
                        与 cwd 无关；启动行会打印实际使用的绝对路径）

对局参数：
  --seed <n>            引擎随机种子（默认 42；同 seed + 同动作序列 = 可复现整局）
  --difficulty <档>     对手内置 AI 难度：easy | normal | hard（默认 normal）
  --deck <id|路径>      你的卡组：content 预组卡组 id 或卡组 JSON 文件路径
                        （默认 nvidia-flagship-faith）
  --opponent-deck <…>   对手卡组，同上（默认 amd-war-future）

file 模式可选：
  --poll-ms <n>         轮询 action.json 间隔毫秒（默认 250）
  --wait-timeout <秒>   等待动作的超时秒数，0=一直等（默认 0）

其它：
  --help / -h           本帮助（注意：要看子命令帮助——顶层「yarn workspace @siliconcard/cli --help」
                        会被 yarn 拦截报 Unknown Syntax Error，请写 play --help / demo --help）
  --version             版本

一行上手（文件回合制，另开终端跑 docs/agent-skill.md 里的示例 agent）：
  yarn workspace @siliconcard/cli play --mode file --seed 42
观战演示（内置 AI 自对弈）：
  yarn workspace @siliconcard/cli demo --seed 42
`

export interface PlayArgs {
  mode: 'file' | 'stdio'
  seed: number
  difficulty: Difficulty
  deck?: string
  opponentDeck?: string
  /** undefined = 用默认目录（仓库根下的 silicon-card-game/，见 content.defaultGameDir） */
  dir?: string
  pollMs: number
  waitTimeoutMs: number
  help: boolean
  version: boolean
}

const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard']

function needValue(argv: string[], i: number, flag: string): string {
  const value = argv[i + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`--${flag} 需要一个值（如 --${flag} 42）。--help 查看全部参数。`)
  }
  return value
}

export function parsePlayArgs(argv: string[]): PlayArgs {
  const args: PlayArgs = {
    mode: 'file',
    seed: 42,
    difficulty: 'normal',
    pollMs: 250,
    waitTimeoutMs: 0,
    help: false,
    version: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--mode':
        args.mode = needValue(argv, i, 'mode') as PlayArgs['mode']
        if (args.mode !== 'file' && args.mode !== 'stdio') {
          throw new UsageError(`--mode 只接受 file 或 stdio（收到：${args.mode}）`)
        }
        i++
        break
      case '--seed': {
        const raw = needValue(argv, i, 'seed')
        const seed = Number(raw)
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
          throw new UsageError(`--seed 需要一个 0 ~ 4294967295 的整数（收到：${raw}）`)
        }
        args.seed = seed
        i++
        break
      }
      case '--difficulty': {
        const raw = needValue(argv, i, 'difficulty') as Difficulty
        if (!DIFFICULTIES.includes(raw)) {
          throw new UsageError(`--difficulty 只接受 easy / normal / hard（收到：${raw}）`)
        }
        args.difficulty = raw
        i++
        break
      }
      case '--deck':
        args.deck = needValue(argv, i, 'deck')
        i++
        break
      case '--opponent-deck':
        args.opponentDeck = needValue(argv, i, 'opponent-deck')
        i++
        break
      case '--dir':
        args.dir = needValue(argv, i, 'dir')
        i++
        break
      case '--poll-ms': {
        const raw = Number(needValue(argv, i, 'poll-ms'))
        if (!Number.isInteger(raw) || raw <= 0) throw new UsageError(`--poll-ms 需要正整数毫秒（收到：${raw}）`)
        args.pollMs = raw
        i++
        break
      }
      case '--wait-timeout': {
        const seconds = Number(needValue(argv, i, 'wait-timeout'))
        if (!Number.isFinite(seconds) || seconds < 0) throw new UsageError(`--wait-timeout 需要非负秒数（收到：${seconds}）`)
        args.waitTimeoutMs = seconds * 1000
        i++
        break
      }
      case '--help':
      case '-h':
        args.help = true
        break
      case '--version':
        args.version = true
        break
      default:
        throw new UsageError(`未知参数「${flag}」。--help 查看全部参数与一行上手命令。`)
    }
  }
  return args
}

export interface DemoArgs {
  seed: number
  difficulty: Difficulty
  deck?: string
  opponentDeck?: string
  json: boolean
  maxActions: number
  help: boolean
  version: boolean
}

export const DEMO_USAGE = `硅牌 SiliconCard · 演示对局（内置 AI 自对弈观战，输出对局事件流）

用法：
  yarn workspace @siliconcard/cli demo [参数]

  --seed <n>            引擎随机种子（默认 42；同 seed 逐字节复现同一场对局）
  --difficulty <档>     双方 AI 难度：easy | normal | hard（默认 normal）
  --deck <id|路径>      P1 卡组：预组卡组 id 或 JSON 路径（默认 nvidia-flagship-faith）
  --opponent-deck <…>   P2 卡组，同上（默认 amd-war-future）
  --json                改为逐行输出引擎原始事件 JSON（默认人话解说）
  --max-actions <n>     动作数上限护栏（默认 4000）
  --help / -h           本帮助        --version    版本

一行观战：
  yarn workspace @siliconcard/cli demo --seed 42
`

export function parseDemoArgs(argv: string[]): DemoArgs {
  const args: DemoArgs = { seed: 42, difficulty: 'normal', json: false, maxActions: 4000, help: false, version: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--seed': {
        const raw = needValue(argv, i, 'seed')
        const seed = Number(raw)
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
          throw new UsageError(`--seed 需要一个 0 ~ 4294967295 的整数（收到：${raw}）`)
        }
        args.seed = seed
        i++
        break
      }
      case '--difficulty': {
        const raw = needValue(argv, i, 'difficulty') as Difficulty
        if (!DIFFICULTIES.includes(raw)) {
          throw new UsageError(`--difficulty 只接受 easy / normal / hard（收到：${raw}）`)
        }
        args.difficulty = raw
        i++
        break
      }
      case '--deck':
        args.deck = needValue(argv, i, 'deck')
        i++
        break
      case '--opponent-deck':
        args.opponentDeck = needValue(argv, i, 'opponent-deck')
        i++
        break
      case '--json':
        args.json = true
        break
      case '--max-actions': {
        const raw = Number(needValue(argv, i, 'max-actions'))
        if (!Number.isInteger(raw) || raw <= 0) throw new UsageError(`--max-actions 需要正整数（收到：${raw}）`)
        args.maxActions = raw
        i++
        break
      }
      case '--help':
      case '-h':
        args.help = true
        break
      case '--version':
        args.version = true
        break
      default:
        throw new UsageError(`未知参数「${flag}」。--help 查看全部参数。`)
    }
  }
  return args
}
