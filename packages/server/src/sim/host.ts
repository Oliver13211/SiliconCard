/**
 * 模拟客户端 · 房主（host）——E2E 验收用。建房（可 --fill-ai 让服务端 AI 托管空位），
 * 等对手就座后开局，随机合法动作打完整局。
 *
 * 用法：
 *   yarn workspace @siliconcard/server sim:host --port 49321 --seed 42
 *   yarn workspace @siliconcard/server sim:host --port 49321 --fill-ai --seed 7   # 人机房，无需对手
 * 参数：--host/--port 服务端地址（手动 IP:port 直连路径）；--room-name；--deck 卡组 id；
 *       --seed 动作策略种子；--fill-ai 空位由 AI 托管；--concede-after N 打 N 手后投降；
 *       --no-start 挂机等对方开局（联调用）。
 */

import {
  expectWelcome,
  isRoomResult,
  pickDeck,
  playUntilEnded,
  SimClient,
} from './simClient'

interface HostArgs {
  host: string
  port: number
  roomName?: string
  deckId?: string
  seed: number
  fillAi: boolean
  concedeAfter?: number
  noStart: boolean
}

function parseArgs(argv: readonly string[]): HostArgs {
  const args: HostArgs = { host: '127.0.0.1', port: 49321, seed: 42, fillAi: false, noStart: false }
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
      case '--room-name':
        args.roomName = String(next)
        i += 1
        break
      case '--deck':
        args.deckId = String(next)
        i += 1
        break
      case '--seed':
        args.seed = Number(next)
        i += 1
        break
      case '--fill-ai':
        args.fillAi = true
        break
      case '--concede-after':
        args.concedeAfter = Number(next)
        i += 1
        break
      case '--no-start':
        args.noStart = true
        break
      default:
        throw new Error(`未知参数「${String(flag)}」。可用：--host --port --room-name --deck --seed --fill-ai --concede-after --no-start`)
    }
  }
  if (!Number.isInteger(args.seed)) throw new Error('--seed 需要整数')
  return args
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const client = new SimClient({ onLog: (line) => console.log(line) })
  const deck = pickDeck(args.deckId)
  const url = `ws://${args.host}:${args.port}`

  console.log(`[sim:host] 连接 ${url}（手动 IP:port 直连；卡组 ${deck.label}）`)
  await client.connect(url)
  expectWelcome(client.history()[0])
  client.send({
    v: 1,
    type: 'room',
    op: { name: 'create', roomName: args.roomName, deck: deck.deck, fillWithAi: args.fillAi },
  })
  const created = await client.waitFor((frame) => isRoomResult(frame, 'created'), 5000, 'created 回执')
  if (!isRoomResult(created, 'created')) throw new Error('unreachable')
  const code = created.op.name === 'created' ? created.op.code : ''
  const token = created.op.name === 'created' ? created.op.token : ''
  console.log(`[sim:host] 房间已建：房间码 ${code}（对手用 sim:join --code ${code} 加入）`)
  console.log(`[sim:host] 续传凭据：code=${code} token=${token} lastSeq=${String(client.lastSeq)}`)

  if (!args.fillAi) {
    console.log('[sim:host] 等待对手就座……')
    await client.waitFor(
      (frame) => isRoomResult(frame, 'seat_update') && frame.op.name === 'seat_update' && frame.op.seats.P2 !== null,
      120000,
      '对手加入',
    )
  }

  if (!args.noStart) {
    const seed = Math.floor(Date.now() / 1000) % 0x7fffffff
    console.log(`[sim:host] 开局（seed=${seed}${args.fillAi ? '，对面由 AI 托管' : ''}）`)
    client.send({ v: 1, type: 'room', op: { name: 'start', seed } })
  }

  const result = await playUntilEnded({ client, seat: 'P1', seed: args.seed, concedeAfter: args.concedeAfter })
  console.log(`[sim:host] 对局结束：胜者 ${result.winner ?? '平局'}；本端出招 ${result.actionsSent} 手；累计 ${result.framesSeen} 帧`)
  client.close()
  process.exit(0)
}

void main().catch((error: unknown) => {
  console.error(`[sim:host] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
