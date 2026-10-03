/**
 * 手写补间引擎（M1-R3D4）—— 项目约束：不新增依赖、补间动画手写。
 *
 * 纯逻辑、零 DOM/Three 依赖，可无头测试；渲染循环每帧调 Timeline.update(dt)。
 * 「动画可快进」（性能预算，见 design-report §3.4）由 fastForward() 一步到位：
 * 同步把所有未完成补间推到终点并触发完成回调，事件流排队的演出瞬间清空。
 */

export type EaseFn = (t: number) => number

/** 常用缓动（全部满足 f(0)=0, f(1)=1，单调不减） */
export const easeLinear: EaseFn = (t) => t
export const easeOutCubic: EaseFn = (t) => 1 - (1 - t) ** 3
export const easeInCubic: EaseFn = (t) => t * t * t
export const easeInOutQuad: EaseFn = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
/** 回弹落场（出牌落场用，端点仍为 0/1，中途越过 1） */
export const easeOutBack: EaseFn = (t) => {
  if (t === 0 || t === 1) return t // 多项式在端点有 1e-16 级浮点噪声，契约要求精确
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}
/** 冲撞回弹（攻击演出用，端点为 0/1，中途振荡越过 1） */
export const easeOutElastic: EaseFn = (t) => {
  if (t === 0 || t === 1) return t
  const c4 = (2 * Math.PI) / 3
  return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1
}

/** 单条补间定义 */
export interface TweenStep {
  /** 时长（秒，>0） */
  duration: number
  /** 延迟启动（秒，默认 0）——与 Timeline.sequence 连用实现接力 */
  delay?: number
  ease?: EaseFn
  /** 每帧回调：p 为 ease 后的进度 0..1（可能越界如 easeOutBack）；纯时序步可省略 */
  onUpdate?: (p: number) => void
  /** 正常播完或被 fastForward 推到终点时调用（恰好一次） */
  onDone?: () => void
}

interface RunningStep extends TweenStep {
  elapsed: number
  delaySec: number
  done: boolean
}

/**
 * 并行补间容器。同一 Timeline 上的步互不等待；接力用 sequence() 或 delay 编排。
 * update 返回本帧是否有任何活动步（供渲染循环决定是否继续重绘演出层）。
 */
export class Timeline {
  private steps: RunningStep[] = []

  get size(): number {
    return this.steps.length
  }

  get active(): boolean {
    return this.steps.length > 0
  }

  add(step: TweenStep): void {
    this.steps.push({ delaySec: step.delay ?? 0, ...step, elapsed: 0, done: false })
  }

  /** 把多条步按顺序接力：后一条的 delay = 前面全部 duration+delay 之和 */
  sequence(steps: readonly TweenStep[]): void {
    let offset = 0
    for (const s of steps) {
      this.add({ ...s, delay: offset + (s.delay ?? 0) })
      offset += s.duration + (s.delay ?? 0)
    }
  }

  /** 推进 dt 秒；返回是否仍有活动步 */
  update(dt: number): boolean {
    let anyActive = false
    for (const s of this.steps) {
      if (s.done) continue
      s.elapsed += dt
      const effective = s.elapsed - s.delaySec
      if (effective < 0) {
        anyActive = true // 尚在延迟中，仍算活动
        continue
      }
      const p = Math.min(1, effective / Math.max(s.duration, Number.EPSILON))
      s.onUpdate?.((s.ease ?? easeLinear)(p))
      if (p >= 1) {
        s.done = true
        s.onDone?.()
      } else {
        anyActive = true
      }
    }
    this.steps = this.steps.filter((s) => !s.done)
    return anyActive
  }

  /**
   * 快进：同步把全部步推到终点（onUpdate(1) + onDone 各恰好一次），
   * 清空队列。用于「跳过演出」按钮 / 批量事件回放。
   */
  fastForward(): void {
    const pending = this.steps
    this.steps = []
    for (const s of pending) {
      if (s.done) continue
      s.onUpdate?.((s.ease ?? easeLinear)(1))
      s.done = true
      s.onDone?.()
    }
  }

  /** 丢弃全部未完成步（不触发 onUpdate/onDone），用于 dispose 或状态硬重置 */
  cancelAll(): void {
    this.steps = []
  }
}
