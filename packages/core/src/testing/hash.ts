/**
 * 确定性基础设施：canonical JSON 与稳定哈希。
 * 黄金回放的快照比对基于此——引擎状态任何语义变化都会改变哈希。
 * core 零运行时依赖：手写实现，不引入第三方序列化库。
 */

/** 递归排序对象键、剔除 undefined，输出字节级稳定的 JSON 字符串 */
export function canonicalJson(value: unknown): string {
  return serialize(value)
}

function serialize(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      // 引擎状态不允许出现 NaN/Infinity（出现即状态被污染，立即失败）
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number in game state')
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'object': {
      // 引擎状态是纯 JSON：这些类型一旦混入即状态被污染，立即失败
      if (value instanceof Map || value instanceof Set || value instanceof Date) {
        throw new Error(`canonicalJson: cannot serialize ${value.constructor.name} in game state`)
      }
      if (Array.isArray(value)) {
        return `[${value.map((v) => serialize(v)).join(',')}]`
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(',')}}`
    }
    default:
      throw new Error(`canonicalJson: cannot serialize value of type ${typeof value}`)
  }
}

/** FNV-1a 32 位哈希（hex 8 位），作用于 canonicalJson 输出 */
export function stableHash(value: unknown): string {
  const s = canonicalJson(value)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
