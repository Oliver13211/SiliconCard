/**
 * mulberry32 PRNG（docs/rules.md §11 确定性规范）。
 *
 * - 状态是一个 uint32 整数，随 GameState.rng.state 序列化；
 * - 一切随机（洗牌/后续随机选择与概率判定）都必须经本模块，禁止其他随机源；
 * - 输出只做瞬时计算、从不进入状态：状态里永远是整数，满足 canonicalJson 约束。
 */

export type RngState = number

const MULTIPLIER = 0x6d2b79f5

/** 纯函数：推进一次 PRNG，返回新状态与 32 位无符号整数输出（等价于 mulberry32 参考实现） */
export function nextUint32(state: RngState): { state: RngState; value: number } {
  const s = (state + MULTIPLIER) >>> 0
  let t = s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return { state: s, value: (t ^ (t >>> 14)) >>> 0 }
}

export interface Rng {
  /** [0, 1) 浮点（仅瞬时使用，禁止写入 GameState） */
  nextFloat(): number
  /** [0, bound) 内的无偏整数（拒绝采样消除模偏差） */
  nextInt(bound: number): number
  /** 就地 Fisher–Yates 洗牌，同一状态产生同一置换 */
  shuffle<T>(items: T[]): T[]
  /** 当前可序列化状态（uint32 整数） */
  getState(): RngState
}

export function createRng(initialState: RngState): Rng {
  let state = initialState >>> 0

  const nextUint = (): number => {
    const r = nextUint32(state)
    state = r.state
    return r.value
  }

  const nextInt = (bound: number): number => {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new Error(`rng.nextInt: bound 必须为正整数，收到 ${bound}`)
    }
    // 2^32 与 bound 均可被 float64 精确表示，以下运算无精度损失
    const limit = 4294967296 - (4294967296 % bound)
    let value = nextUint()
    while (value >= limit) value = nextUint()
    return value % bound
  }

  return {
    nextFloat: () => nextUint() / 2 ** 32,
    nextInt,
    shuffle<T>(items: T[]): T[] {
      for (let i = items.length - 1; i > 0; i--) {
        const j = nextInt(i + 1)
        const tmp = items[i] as T
        items[i] = items[j] as T
        items[j] = tmp
      }
      return items
    },
    getState: () => state,
  }
}
