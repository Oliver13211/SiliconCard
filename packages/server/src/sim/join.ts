/**
 * 模拟客户端 · 加入方（join）——E2E 验收用。加入指定房间码（或 --auto 从
 * 服务端 HTTP 房间列表挑第一个有空位的房间），随机合法动作打完整局。
 *
 * 用法：
 *   yarn workspace @siliconcard/server sim:join --port 49321 --code XXXXXX --seed 42
 *   yarn workspace @siliconcard/server sim:join --host 192.168.1.20 --port 49321 --auto   # 只知道 IP:port 也能玩（回退路径）
 * 断线重连演练：被 kill 后用打印的凭据重启：
 *   yarn workspace @siliconcard/server sim:join --resume CODE TOKEN LASTSEQ --seed 42
 */

import {
  expectWelcome,
  playUntilEnded,
  pickDeck,
  SimClient,
} from './simClient'
import type { ServerFrame } from '../protocol'

interface JoinArgs {
  host: string
  port: number
  code?: string
  auto: boolean
  deckId?: string
  seed: number
  resume?: { code: string; token: string; lastSeq: number | null }
  concedeAfter?: number
}

function parseArgs(argv: readonly string[]): JoinArgs {
  const args: JoinArgs = { host: '127.0.0.1', port: 49321, seed: 42, auto: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    switch (flag) {
      case '--host':
        args.host = String(next)
        i += 1
        break
      case '--port':
        args.port = Number(next)
        i += 1
        break
      case '--code':
        args.code = String(next)
        i += 1
        break
      case '--auto':
        args.auto = true
        break
      case '--deck':
        args.deckId = String(next)
        i += 1
        break
      case '--seed':
        args.seed = Number(next)
        i += 1
        break
      case '--resume': {
        // --resume CODE TOKEN LASTSEQ（LASTSEQ 为 -1 表示从零全量对齐）
        const token = argv[i + 2]
        const lastSeqRaw = argv[i + 3]
        if (next === undefined || token === undefined) throw new Error('--resume 需要 CODE TOKEN LASTSEQ 三个值')
        args.resume = { code: next.toUpperCase(), token, lastSeq: lastSeqRaw === '-1' ? null : Number(lastSeqRaw) }
        i += 3
        break
      }
      case '--concede-after':
        args.concedeAfter = Number(next)
        i += 1
        break
      default:
        throw new Error(`未知参数「${String(flag)}」。可用：--host --port --code --auto --deck --seed --resume CODE TOKEN LASTSEQ --concede-after`)
    }
  }
  if (!args.auto && !args.code && !args.resume) throw new Error('需要 --code XXXXXX 或 --auto（从房间列表挑）或 --resume')
  return args
}

/** 手动 IP:port 直连的配套发现：HTTP 房间列表挑第一个有空位的房间 */
async function fetchOpenRoom(host: string, port: number): Promise<string> {
  const response = await fetch(`http://${host}:${port}/siliconcard/rooms`)
  if (!response.ok) throw new Error(`房间列表请求失败：HTTP ${String(response.status)}`)
  const body = (await response.json()) as { rooms?: { code?: string; openSeats?: number; phase?: string }[] }
  const room = (body.rooms ?? []).find((entry) => (entry.openSeats ?? 0) > 0 && entry.phase === 'lobby')
  if (!room?.code) throw new Error('服务端没有可加入的房间（openSeats=0 或全部已开局）')
  return room.code
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const client = new SimClient({ onLog: (line) => console.log(line) })
  const url = `ws://${args.host}:${args.port}`
  let seat: 'P1' | 'P2' = 'P2'

  if (args.resume) {
    console.log(`[sim:join] 重连 ${url}（房间 ${args.resume.code}，lastSeq=${String(args.resume.lastSeq)}）`)
    await client.connect(url)
    expectWelcome(client.history()[0])
    client.send({
      v: 1,
      type: 'room',
      op: { name: 'resume', code: args.resume.code, token: args.resume.token, lastSeq: args.resume.lastSeq },
    })
    const resumed = await client.waitFor((frame: ServerFrame) => frame.type === 'room' && frame.op.name === 'resumed', 5000, 'resumed 回执')
    const replayed = resumed.type === 'room' && resumed.op.name === 'resumed' ? resumed.op.replayed : 0
    seat = resumed.type === 'room' && resumed.op.name === 'resumed' ? resumed.op.seat : 'P2'
    console.log(`[sim:join] 重连成功：以 ${seat} 席位续传 ${replayed} 帧 + 一次全量对齐`)
  } else {
    const deck = pickDeck(args.deckId)
    const code = args.code ?? (await fetchOpenRoom(args.host, args.port))
    console.log(`[sim:join] 连接 ${url}，加入房间 ${code}（卡组 ${deck.label}）`)
    await client.connect(url)
    expectWelcome(client.history()[0])
    client.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deck.deck } })
    await client.waitFor((frame: ServerFrame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined 回执')
    seat = 'P2'
    console.log('[sim:join] 已就座（P2），等待房主开局……')
  }

  const result = await playUntilEnded({ client, seat, seed: args.seed, concedeAfter: args.concedeAfter })
  console.log(`[sim:join] 对局结束：胜者 ${result.winner ?? '平局'}；本端（${seat}）出招 ${result.actionsSent} 手；累计 ${result.framesSeen} 帧`)
  client.close()
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.error(`[sim:join] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
