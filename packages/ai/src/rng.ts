/**
 * AI 决策用种子 RNG（mulberry32，与 core §11 同算法的包内自实现）。
 *
 * 用途边界：只驱动 AI 自身的决策噪声 / 难度随机（dropout、候选抖动），
 * 与引擎 RNG（GameState.rng）完全独立——对局随机仍全部由引擎种子驱动，
 * AI 决策随机只影响「同一局面下选哪个合法动作」。
 *
 * 确定性：同 seed + 同决策序列 → 同决策（自对弈 harness 与回放测试依赖此性质）。
 */

export type AiRngState = number

const MULTIPLIER = 0x6d2b79f5

/** 纯函数：推进一次 PRNG（mulberry32 参考实现，与 core/src/engine/prng.ts 一致） */
export function aiNextUint32(state: AiRngState): { state: AiRngState; value: number } {
  const s = (state + MULTIPLIER) >>> 0
  let t = s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return { state: s, value: (t ^ (t >>> 14)) >>> 0 }
}

export interface AiRng {
  /** [0, 1) 浮点 */
  nextFloat(): number
  /** [0, bound) 内的无偏整数（拒绝采样消除模偏差） */
  nextInt(bound: number): number
  /** 当前状态（uint32）——调试 / 复现用 */
  getState(): AiRngState
}

export function createAiRng(initialState: AiRngState): AiRng {
  let state = initialState >>> 0

  const nextUint = (): number => {
    const r = aiNextUint32(state)
    state = r.state
    return r.value
  }

  return {
    nextFloat: () => nextUint() / 2 ** 32,
    nextInt(bound: number): number {
      if (!Number.isInteger(bound) || bound <= 0) {
        throw new Error(`aiRng.nextInt: bound 必须为正整数，收到 ${bound}`)
      }
      const limit = 4294967296 - (4294967296 % bound)
      let value = nextUint()
      while (value >= limit) value = nextUint()
      return value % bound
    },
    getState: () => state,
  }
}

/**
 * 由对局 seed 确定性派生指定玩家的 AI 决策种子。
 * 双方 AI 同局各持独立决策流，互不干扰；同 seed 重放时逐字节一致。
 */
export function deriveAiSeed(gameSeed: number, playerId: 'P1' | 'P2'): number {
  const salt = playerId === 'P1' ? 0x9e3779b9 : 0x85ebca6b
  return (Math.imul(gameSeed >>> 0, 0x27d4eb2d) ^ salt) >>> 0
}
