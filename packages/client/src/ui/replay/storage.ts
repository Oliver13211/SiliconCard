/**
 * 回放库浏览器本地存储（P2-INF1）——IndexedDB `siliconcard-replays` v1。
 *
 * 双 store 契约（plan 定稿）：
 * - `meta`：ReplayMeta 元数据索引（keyPath 'id'，附 savedAt 索引）——列表页零回放体扫描；
 * - `body`：ReplayRecording 回放体（seed + 卡组 + 动作序列，keyPath 'id' 同键关联）。
 *
 * 可测试性：存储经 ReplayStorageBackend 抽象接口注入——无头单测用内存实现，
 * 浏览器默认走 IndexedDB；环境不可用时静默降级内存实现（回放是副业，
 * 存储失败绝不阻塞对局）。
 *
 * 容量策略：本地保留最近 50 局（按 savedAt LRU 淘汰），支持删单局；
 * 淘汰与容量是纯函数（evictIdsBeyondCap），单测直测。
 */

import { stableHash, type ReplayRecording } from '@siliconcard/core'
import type { ReplayMeta } from './types'

export const REPLAY_DB_NAME = 'siliconcard-replays'
export const REPLAY_DB_VERSION = 1
export const REPLAY_META_STORE = 'meta'
export const REPLAY_BODY_STORE = 'body'
/** 本地回放容量上限（第 51 局完成时最旧一局被淘汰） */
export const REPLAY_CAP = 50

export interface ReplayStorageBackend {
  getAllMeta(): Promise<ReplayMeta[]>
  getBody(id: string): Promise<ReplayRecording | null>
  put(meta: ReplayMeta, body: ReplayRecording): Promise<void>
  delete(id: string): Promise<void>
}

/** 内容寻址 id：同录制 → 同 id（重复导入天然去重，只刷新 savedAt） */
export function replayIdOf(recording: ReplayRecording): string {
  return stableHash(recording)
}

// —— 内存实现（无头单测 / IndexedDB 不可用降级） ——

export function createMemoryBackend(): ReplayStorageBackend {
  const metas = new Map<string, ReplayMeta>()
  const bodies = new Map<string, ReplayRecording>()
  return {
    async getAllMeta() {
      return [...metas.values()]
    },
    async getBody(id) {
      return bodies.get(id) ?? null
    },
    async put(meta, body) {
      metas.set(meta.id, { ...meta })
      bodies.set(meta.id, body)
    },
    async delete(id) {
      metas.delete(id)
      bodies.delete(id)
    },
  }
}

// —— IndexedDB 实现 ——

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB 请求失败'))
  })
}

/** 写事务以 complete 事件为准（单请求 success 不代表事务已提交） */
function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB 事务中止'))
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB 事务失败'))
  })
}

export function createIndexedDbBackend(factory: IDBFactory | undefined): ReplayStorageBackend | null {
  if (!factory) return null
  let dbPromise: Promise<IDBDatabase> | null = null

  const open = (): Promise<IDBDatabase> => {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(REPLAY_DB_NAME, REPLAY_DB_VERSION)
      request.onupgradeneeded = () => {
        const db = request.result
        if (!db.objectStoreNames.contains(REPLAY_META_STORE)) {
          db.createObjectStore(REPLAY_META_STORE, { keyPath: 'id' }).createIndex('savedAt', 'savedAt')
        }
        if (!db.objectStoreNames.contains(REPLAY_BODY_STORE)) {
          db.createObjectStore(REPLAY_BODY_STORE, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error(`${REPLAY_DB_NAME} 打开失败`))
      request.onblocked = () => reject(new Error('回放库被其他标签页占用（版本升级未完成），稍后再试'))
    })
    return dbPromise
  }

  /** 读：主请求结果；写：事务 complete；两条路径都带上可读错误 */
  async function withStores<T>(
    mode: IDBTransactionMode,
    run: (stores: { meta: IDBObjectStore; body: IDBObjectStore }) => IDBRequest<T>,
  ): Promise<T> {
    const db = await open()
    const transaction = db.transaction([REPLAY_META_STORE, REPLAY_BODY_STORE], mode)
    const request = run({
      meta: transaction.objectStore(REPLAY_META_STORE),
      body: transaction.objectStore(REPLAY_BODY_STORE),
    })
    if (mode === 'readonly') return requestAsPromise(request)
    await transactionDone(transaction)
    return request.result
  }

  return {
    async getAllMeta() {
      return withStores('readonly', ({ meta }) => meta.getAll() as IDBRequest<ReplayMeta[]>)
    },
    async getBody(id) {
      const body = await withStores('readonly', (stores) => stores.body.get(id) as IDBRequest<ReplayRecording | undefined>)
      return body ?? null
    },
    async put(meta, body) {
      // 双 store 同事务写入：要么都进要么都不进（meta/body 永不成孤行）
      await withStores('readwrite', ({ meta: metaStore, body: bodyStore }) => {
        bodyStore.put(body, meta.id)
        return metaStore.put(meta)
      })
    },
    async delete(id) {
      await withStores('readwrite', ({ meta, body }) => {
        body.delete(id)
        return meta.delete(id)
      })
    },
  }
}

// —— 后端选择（注入点 + 惰性单例） ——

let backendOverride: ReplayStorageBackend | null = null
let defaultBackend: ReplayStorageBackend | null = null

/** 测试/特殊宿主注入存储实现；传 null 恢复默认 */
export function configureReplayBackend(backend: ReplayStorageBackend | null): void {
  backendOverride = backend
}

export function replayBackend(): ReplayStorageBackend {
  if (backendOverride) return backendOverride
  defaultBackend ??=
    typeof indexedDB !== 'undefined' ? (createIndexedDbBackend(indexedDB) ?? createMemoryBackend()) : createMemoryBackend()
  return defaultBackend as ReplayStorageBackend
}

// —— 容量策略（纯函数 + 落库入口） ——

/**
 * LRU 淘汰：按 savedAt 新→旧排序，保留前 cap 条，返回应淘汰的 id。
 * savedAt 相同按 id 字典序兜底（排序全序，淘汰结果确定）。
 */
export function evictIdsBeyondCap(metas: readonly ReplayMeta[], cap: number = REPLAY_CAP): string[] {
  const sorted = [...metas].sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return sorted.slice(Math.max(0, cap)).map((meta) => meta.id)
}

/**
 * 落库 + 容量收口：写入后超出 cap 的最旧记录同批删除。
 * 返回本次被淘汰的 id（空数组 = 没有淘汰；新写入记录 savedAt 为最新，
 * 常规路径下不会被自我淘汰——除非调用方刻意传入更旧的 savedAt）。
 */
export async function saveReplayWithCap(
  backend: ReplayStorageBackend,
  meta: ReplayMeta,
  body: ReplayRecording,
  cap: number = REPLAY_CAP,
): Promise<{ evicted: string[] }> {
  await backend.put(meta, body)
  const metas = await backend.getAllMeta()
  const evicted = evictIdsBeyondCap(metas, cap)
  for (const id of evicted) await backend.delete(id)
  return { evicted }
}
