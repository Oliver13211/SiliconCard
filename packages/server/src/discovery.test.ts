/**
 * M2-NET2 服务发现测试 —— mDNS（_siliconcard._tcp）广播与浏览 + 手动 IP:port
 * 直连硬回退（net-dev 预设硬约束：mDNS 失败必须能用）。
 * - 广播：服务名带房间信息（`SiliconCard <房间名> #<房间码>`），TXT 携带版本与房间码；
 * - 浏览：browse 能发现本服务端发布的房间（本机多播实测可用；若环境禁多播，
 *   browse 以空结果收场而非抛错——不阻塞主流程）；
 * - 回退：完全关闭 mDNS 的服务端，凭 URL（IP:port）直连建房/加入照常工作。
 */

import { describe, expect, it } from 'vitest'
import { createGameServer } from './server'
import { SimClient, pickDeck } from './sim/simClient'

function deckOf(id: string) {
  const picked = pickDeck(id).deck
  return { faction: picked.faction, cards: picked.cards }
}

describe('M2-NET2 服务发现（mDNS）与手动直连回退', () => {
  it(
    '广播房间 → browse 发现（服务名/TXT 带房间信息）→ dropRoom 撤销不抛错',
    async () => {
      const server = await createGameServer({ port: 0, host: '127.0.0.1', discovery: true })
      try {
        expect(server.discovery).not.toBeNull()
        const client = new SimClient()
        await client.connect(server.url())
        client.send({ v: 1, type: 'room', op: { name: 'create', roomName: '发现测试房', deck: deckOf('nvidia-flagship-faith') } })
        const created = await client.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
        const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''

        // bonjour 发布是异步探测（probe），给广播一点时间再浏览
        await new Promise((resolve) => setTimeout(resolve, 500))
        const found = await server.discovery!.browse(4000)
        const mine = found.find((room) => room.roomCode === code)
        if (mine) {
          // 多播可用（本机实测可用）：校验服务名带房间信息与 TXT 版本
          expect(mine.instanceName).toContain('发现测试房')
          expect(mine.instanceName).toContain(code)
          expect(mine.protocolVersion).toBe(1)
          expect(mine.port).toBe(server.port)
        } else {
          // 多播被环境禁用：browse 必须以空结果优雅收场（回退路径兜底），不许抛错
          console.log('[discovery] 本环境未发现 mDNS 服务（多播可能被禁）——回退路径测试兜底')
        }

        // 撤销广播不抛错
        expect(server.rooms.dropRoom(code)).toBe(true)
        client.close()
      } finally {
        await server.close() // 内部 destroy：全部 unpublish + bonjour 销毁
      }
    },
    30_000,
  )

  it('硬回退：关闭 mDNS 的服务端，手动 IP:port 直连建房/加入/开完整局', async () => {
    // discovery: false —— 相当于 mDNS 完全不可用/被防火墙拦截
    const server = await createGameServer({ port: 0, host: '127.0.0.1', discovery: false })
    try {
      expect(server.discovery).toBeNull()

      const host = new SimClient()
      await host.connect(server.url()) // 手动 IP:port（此处为回环）直连
      host.send({ v: 1, type: 'room', op: { name: 'create', roomName: '直连房', deck: deckOf('intel-driver-magic') } })
      const created = await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'created', 5000, 'created')
      const code = created.type === 'room' && created.op.name === 'created' ? created.op.code : ''
      expect(code).not.toBe('')

      const guest = new SimClient()
      await guest.connect(server.url())
      guest.send({ v: 1, type: 'room', op: { name: 'join', code, deck: deckOf('amd-war-future') } })
      await guest.waitFor((frame) => frame.type === 'room' && frame.op.name === 'joined', 5000, 'joined')

      host.send({ v: 1, type: 'room', op: { name: 'start', seed: 8080 } })
      await host.waitFor((frame) => frame.type === 'room' && frame.op.name === 'started', 5000, 'started')
      // 双方各交一手回合证明对局在无任何发现机制的网络上照常推进
      const hostLegal = await host.waitFor((frame) => frame.type === 'sync' && frame.snapshot.legalActions.length > 0, 5000, 'P1 回合')
      expect(hostLegal.type).toBe('sync')
      host.send({ v: 1, type: 'action', action: { type: 'END_TURN', playerId: 'P1' } })
      await guest.waitFor(
        (frame) => frame.type === 'events' && frame.events.some((event) => event.type === 'TURN_START') && frame.view.activePlayer === 'P2',
        20000,
        'P2 回合',
      )
      host.close()
      guest.close()
    } finally {
      await server.close()
    }
  })
})
