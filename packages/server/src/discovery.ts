/**
 * mDNS 服务发现（M2-NET2，bonjour-service）——广播 `_siliconcard._tcp`，
 * 服务名带房间信息（`SiliconCard <房间名> #<房间码>`），TXT 携带协议版本与房间码。
 *
 * 回退硬约束（net-dev 预设）：mDNS 只是便利路径——发现失败（多播被防火墙
 * 拦截 / 网段禁多播 / 超时）绝不影响手动 IP:port 直连建房/加入。
 * 本模块所有接口只失败为「空结果或异常上抛」，不阻塞 server 主流程。
 */

import { Bonjour, type Service } from 'bonjour-service'
import { PROTOCOL_VERSION } from './protocol'

export const MDNS_SERVICE_TYPE = 'siliconcard'

/** 发现结果：host:port 可直接用于手动直连，code 可直接用于 join */
export interface DiscoveredRoom {
  /** mDNS 实例名（含房间名与房间码） */
  instanceName: string
  host: string
  port: number
  roomCode: string
  roomName: string
  protocolVersion: number
}

export interface DiscoveryOptions {
  /** 服务实例名前缀，默认 'SiliconCard' */
  instancePrefix?: string
}

interface RoomServiceInfo {
  roomCode: string
  roomName: string
  service: Service
}

export class Discovery {
  private bonjour: Bonjour | null = null
  private readonly published = new Map<string, RoomServiceInfo>()
  private readonly instancePrefix: string

  constructor(options: DiscoveryOptions = {}) {
    this.instancePrefix = options.instancePrefix ?? 'SiliconCard'
  }

  /** 发布一个房间的 mDNS 服务（幂等：同房间码重复发布会被忽略） */
  publishRoom(info: { code: string; name: string; port: number }): void {
    if (this.published.has(info.code)) return
    this.bonjour ??= new Bonjour()
    const bonjour = this.bonjour
    const name = `${this.instancePrefix} ${info.name} #${info.code}`
    const service = bonjour.publish({
      name,
      type: MDNS_SERVICE_TYPE,
      protocol: 'tcp',
      port: info.port,
      txt: {
        v: String(PROTOCOL_VERSION),
        code: info.code,
        room: info.name,
      },
    })
    this.published.set(info.code, { roomCode: info.code, roomName: info.name, service })
  }

  /** 撤销房间广播（房间销毁/GC 时调用；未发布的房间码静默忽略） */
  unpublishRoom(code: string): void {
    const entry = this.published.get(code)
    if (!entry) return
    this.published.delete(code)
    try {
      entry.service.stop()
    } catch {
      // 服务已不在网（网络切换/守护进程退出）时不让撤销失败放大
    }
  }

  /** 浏览局域网内的硅牌房间；到时返回已收集结果（mDNS 失败 → 空数组，不抛错不断连） */
  async browse(timeoutMs = 3000): Promise<DiscoveredRoom[]> {
    this.bonjour ??= new Bonjour()
    const bonjour = this.bonjour
    return new Promise((resolveBrowse) => {
      const found = new Map<string, DiscoveredRoom>()
      let browser: { stop: () => void } | null = null
      const finish = (): void => {
        try {
          browser?.stop()
        } catch {
          // 浏览器已销毁
        }
        resolveBrowse([...found.values()])
      }
      try {
        browser = bonjour.find({ type: MDNS_SERVICE_TYPE }, (service: Service) => {
          const txt = service.txt ?? {}
          const code = typeof txt['code'] === 'string' ? txt['code'] : ''
          if (!code) return
          const version = Number(txt['v'] ?? '0')
          found.set(code, {
            instanceName: service.name,
            host: service.addresses?.[0] ?? service.host,
            port: service.port,
            roomCode: code,
            roomName: typeof txt['room'] === 'string' ? txt['room'] : service.name,
            protocolVersion: Number.isFinite(version) ? version : 0,
          })
        })
      } catch {
        finish()
        return
      }
      setTimeout(finish, timeoutMs)
    })
  }

  /** 释放全部广播（进程退出/测试收尾） */
  destroy(): void {
    for (const entry of this.published.values()) {
      try {
        entry.service.stop()
      } catch {
        // 同 unpublishRoom
      }
    }
    this.published.clear()
    try {
      this.bonjour?.destroy()
    } catch {
      // bonjour 内部 socket 可能已退出
    }
    this.bonjour = null
  }
}
