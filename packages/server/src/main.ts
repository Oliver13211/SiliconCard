/**
 * 服务端启动入口（M2-NET1..3）——`yarn workspace @siliconcard/server start`。
 *
 * 参数：
 *   --port N        监听端口（默认 49321）
 *   --host ADDR     绑定地址（默认 0.0.0.0）
 *   --no-mdns       关闭 mDNS 广播（手动 IP:port 直连永远可用，此开关只关便利路径）
 *   --content-dir P content 数据目录（默认仓库 packages/content）
 *   --grace-ms N    断线宽限（默认 60000；到时全部人类席位仍离线才销毁房间）
 *   --max-rooms N   房间上限（默认 64）
 *
 * 输出全部中文；Ctrl+C 优雅退出（撤销 mDNS 广播、断开连接）。
 */

import { networkInterfaces } from 'node:os'
import { createGameServer, DEFAULT_SERVER_PORT, SERVER_VERSION } from './index'
import { PROTOCOL_VERSION } from './protocol'

interface StartArgs {
  port: number
  host: string
  mdns: boolean
  contentDir?: string
  graceMs?: number
  maxRooms?: number
}

function parseArgs(argv: readonly string[]): StartArgs {
  const args: StartArgs = { port: DEFAULT_SERVER_PORT, host: '0.0.0.0', mdns: true }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    switch (flag) {
      case '--port':
        if (next === undefined || !/^\d+$/.test(next)) throw new Error('--port 需要一个端口号，例如 --port 49321')
        args.port = Number(next)
        i += 1
        break
      case '--host':
        if (next === undefined) throw new Error('--host 需要一个地址，例如 --host 0.0.0.0')
        args.host = next
        i += 1
        break
      case '--no-mdns':
        args.mdns = false
        break
      case '--content-dir':
        if (next === undefined) throw new Error('--content-dir 需要一个目录路径')
        args.contentDir = next
        i += 1
        break
      case '--grace-ms':
        if (next === undefined || !/^\d+$/.test(next)) throw new Error('--grace-ms 需要毫秒数，例如 --grace-ms 30000')
        args.graceMs = Number(next)
        i += 1
        break
      case '--max-rooms':
        if (next === undefined || !/^\d+$/.test(next)) throw new Error('--max-rooms 需要一个数字')
        args.maxRooms = Number(next)
        i += 1
        break
      default:
        throw new Error(`未知参数「${String(flag)}」。可用：--port / --host / --no-mdns / --content-dir / --grace-ms / --max-rooms`)
    }
  }
  return args
}

function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address)
    }
  }
  return out
}

async function main(): Promise<void> {
  let args: StartArgs
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const server = await createGameServer({
    port: args.port,
    host: args.host,
    discovery: args.mdns,
    contentDir: args.contentDir,
    disconnectGraceMs: args.graceMs,
    maxRooms: args.maxRooms,
  })

  console.log(`硅牌 LAN 服务端 v${SERVER_VERSION}（协议 v${PROTOCOL_VERSION}）`)
  console.log(`  卡池：注册 ${server.content.cards.length} 张卡牌定义；预组卡组 ${server.content.decks.length} 套（${server.content.decks.map((deck) => deck.id).join('、') || '无'}）`)
  if (server.content.invalidCards.length > 0) {
    console.warn(`  ⚠ ${server.content.invalidCards.length} 张卡牌未通过结构校验被跳过（详见 content JSON）`)
  }
  console.log(`  监听：${server.url()}（本机回环）`)
  for (const ip of lanAddresses()) {
    console.log(`  局域网：ws://${ip}:${server.port}（手动 IP:port 直连地址——mDNS 不可用时的硬回退）`)
  }
  console.log(`  mDNS 广播：${server.discovery ? `开启（${'_siliconcard._tcp'}，服务名带房间名与房间码）` : '关闭（--no-mdns）'}`)
  console.log('  就绪。用 sim:host 建房、sim:join 加入，或打开网页客户端。')

  const shutdown = (signal: string): void => {
    console.log(`\n收到 ${signal}，正在关闭（撤销 mDNS、断开连接）……`)
    void server.close().then(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

void main().catch((error: unknown) => {
  console.error(`服务端异常退出：${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
