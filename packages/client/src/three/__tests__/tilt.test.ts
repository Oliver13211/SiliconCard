/**
 * 演出修正阶段一 无头回归测试：手牌 tilt 纯逻辑（tilt.ts）。
 *
 * 核心BUG背景：指针停在拾取区边缘时 tilt 来回抽动。回归保证：
 * 1. 目标角在边缘输入下不突变（扫边 Lipschitz 上界 + 饱和区钳制恒定）；
 * 2. hover 迟滞状态机：边缘区（outer）命中不误入、已 hover 时内外圈摆动不掉线。
 */

import { describe, expect, it } from 'vitest'
import {
  TILT_REF_RADIUS_X,
  TILT_REF_RADIUS_Y,
  computeTiltTarget,
  nextHoverState,
  resolveHoverHit,
  sameHoverPick,
  type HoverHit,
  type HoverPickInfo,
  type HoverZone,
} from '../tilt'

describe('computeTiltTarget（目标角计算：相对卡心 + 饱和钳制）', () => {
  it('指针在卡面中心 → 零倾斜', () => {
    expect(computeTiltTarget(0.3, -0.6, 0.3, -0.6)).toEqual({ x: 0, y: 0 })
  })

  it('指针指向哪边就往哪边倾，方向与偏移一致', () => {
    const t = computeTiltTarget(0.4, -0.2, 0.1, -0.5)
    expect(t.x).toBeGreaterThan(0)
    expect(t.y).toBeGreaterThan(0)
  })

  it('钳制：偏离超过归一化半径即饱和到 ±1（方向保持）', () => {
    expect(computeTiltTarget(9, 0, 0, 0)).toEqual({ x: 1, y: 0 })
    expect(computeTiltTarget(-9, 0, 0, 0)).toEqual({ x: -1, y: 0 })
    expect(computeTiltTarget(0, 9, 0, 0)).toEqual({ x: 0, y: 1 })
    expect(computeTiltTarget(0, -9, 0, 0)).toEqual({ x: 0, y: -1 })
    expect(computeTiltTarget(-9, 9, 0, 0)).toEqual({ x: -1, y: 1 })
  })

  it('回归：指针扫过卡面边缘（含钳制点）目标角逐步增量不超 Lipschitz 上界，不突变', () => {
    // 以半个 NDC 步长（0.005）从画布左缘一路扫到右缘 / 下缘到上缘：
    // 旧实现（目标角直接取全画布指针 + 无钳制）在边缘处仍连续，但配合 hover
    // 反复进出的正反馈形成抽动；本约束保证新目标角本身在任何输入序列下
    // 每步变化 ≤ 输入步长/归一化半径（饱和区为 0），渲染端阻尼即可完全滤平。
    const step = 0.005
    const sweep = (axis: 'x' | 'y', from: number, to: number, fixed: number, radius: number) => {
      let prev = axis === 'x' ? computeTiltTarget(from, fixed, 0.1, -0.2) : computeTiltTarget(fixed, from, 0.1, -0.2)
      const n = Math.ceil(Math.abs(to - from) / step)
      for (let i = 1; i <= n; i += 1) {
        const v = from + Math.sign(to - from) * Math.min(step * i, Math.abs(to - from))
        const cur = axis === 'x' ? computeTiltTarget(v, fixed, 0.1, -0.2) : computeTiltTarget(fixed, v, 0.1, -0.2)
        const delta = Math.abs(cur[axis] - prev[axis])
        // 饱和区外：|Δtarget| ≤ |Δ输入| / 半径；钳制点与饱和区内：只可能更小
        expect(delta).toBeLessThanOrEqual(step / radius + 1e-12)
        expect(Math.abs(cur[axis])).toBeLessThanOrEqual(1)
        prev = cur
      }
    }
    sweep('x', -1, 1, -0.2, TILT_REF_RADIUS_X)
    sweep('y', -1, 1, 0.1, TILT_REF_RADIUS_Y)
  })

  it('回归：钳制点附近采样密集扫过，目标角 C0 连续且饱和区恒定（无跳变、无发散）', () => {
    const cx = 0.15
    const around = [cx + TILT_REF_RADIUS_X - 0.01, cx + TILT_REF_RADIUS_X, cx + TILT_REF_RADIUS_X + 0.01]
    const [a, b, c] = around.map((px) => computeTiltTarget(px, 0, cx, 0).x)
    expect(a).toBeLessThan(1)
    expect(b).toBe(1)
    expect(c).toBe(1) // 进入饱和区后目标角钉死在满角，不再随指针增长
  })
})

describe('nextHoverState（hover 迟滞状态机）', () => {
  it('未 hover：内圈命中才进入，外圈（迟滞带）擦过不误触', () => {
    expect(nextHoverState(false, 'inner', false)).toBe(true)
    expect(nextHoverState(false, 'outer', false)).toBe(false)
    expect(nextHoverState(false, 'none', false)).toBe(false)
  })

  it('已 hover：内/外圈命中都维持，离开外圈才退出', () => {
    expect(nextHoverState(true, 'inner', true)).toBe(true)
    expect(nextHoverState(true, 'outer', true)).toBe(true)
    expect(nextHoverState(true, 'none', true)).toBe(false)
  })

  it('已 hover 但射线落在其他目标：仅其他目标的内圈可接管', () => {
    expect(nextHoverState(true, 'inner', false)).toBe(true)
    expect(nextHoverState(true, 'outer', false)).toBe(false)
  })

  it('回归：指针静止在拾取区边缘、tilt 使命中区在内/外圈间摆动 —— hover 全程不丢（抽动免疫）', () => {
    // 旧行为等价于把 outer 视为 none：边缘摆动会反复 setHovered(false/true)。
    // 新状态机下同一目标的 inner/outer 交替必须稳定保持 hover。
    const swing: HoverZone[] = ['inner', 'outer', 'inner', 'outer', 'outer', 'inner', 'outer', 'outer']
    let hovered = true
    for (const zone of swing) hovered = nextHoverState(hovered, zone, true)
    expect(hovered).toBe(true)
  })

  it('回归：迟滞带外才真正退出，且退出后外圈不自动重进（无迟滞反转）', () => {
    let hovered = true
    hovered = nextHoverState(hovered, 'outer', true) // 漂到边缘：保持
    hovered = nextHoverState(hovered, 'none', true) // 离开外圈：退出
    expect(hovered).toBe(false)
    hovered = nextHoverState(hovered, 'outer', true) // 在迟滞带游走：不重进
    expect(hovered).toBe(false)
    hovered = nextHoverState(hovered, 'inner', true) // 重新进入内圈：才恢复
    expect(hovered).toBe(true)
  })
})

describe('resolveHoverHit（射线命中解析：外圈只服务既有 hover）', () => {
  const hand = (uid: string): HoverPickInfo => ({ kind: 'handCard', uid, playerId: 'P1' })
  const hit = (uid: string, guard: boolean): HoverHit => ({ info: hand(uid), guard })

  it('审查修复回归：邻卡外圈抢走首命中时跳过之，当前卡内圈 hover 正常建立（死区消除）', () => {
    // 满手牌几何（handLayout 两端后撤）：扇心侧邻卡 B 的 hoverGuard（半宽 0.69）
    // 侵入当前卡 A 的 pickMesh（半宽 0.575）条带且更近相机 → 首命中为 B 的外圈。
    // 修复前该命中 zone='outer' 且非同目标 → hover 永不建立；修复后跳过外圈继续找。
    const hits = [hit('B', true), hit('A', false)] // 按射线距离序：B 外圈在前
    const resolved = resolveHoverHit(hits, null)
    expect(resolved).not.toBeNull()
    expect(resolved!.info).toEqual(hand('A'))
    expect(resolved!.zone).toBe('inner')
    // 状态机串联：hover 由此正常建立（旧逻辑输出 nextHoverState(false,'outer',false)=false）
    expect(nextHoverState(false, resolved!.zone, sameHoverPick(resolved!.info, null))).toBe(true)
  })

  it('已 hover A 时，邻卡外圈在前仍跳过，A 的外圈/内圈命中照常维持迟滞', () => {
    const hoveringA = hand('A')
    const resolved = resolveHoverHit([hit('B', true), hit('A', true)], hoveringA)
    expect(resolved!.info).toEqual(hoveringA)
    expect(resolved!.zone).toBe('outer') // 落在 A 自己的迟滞带 → 维持
    expect(nextHoverState(true, resolved!.zone, sameHoverPick(resolved!.info, hoveringA))).toBe(true)
  })

  it('已 hover A：A 自身外圈在前 → 迟滞维持（退出带优先）；B 内圈在前 → 照常接管', () => {
    // A 的退出带（自身外圈）距相机更近时，迟滞语义优先：A 维持（设计行为，
    // 越出外圈才交出）；B 的内圈更近时才是 B 的合法接管路径。
    const keepA = resolveHoverHit([hit('A', true), hit('B', false)], hand('A'))
    expect(keepA!.info).toEqual(hand('A'))
    expect(keepA!.zone).toBe('outer')
    expect(nextHoverState(true, keepA!.zone, sameHoverPick(keepA!.info, hand('A')))).toBe(true)

    const takeB = resolveHoverHit([hit('B', false), hit('A', true)], hand('A'))
    expect(takeB!.info).toEqual(hand('B'))
    expect(takeB!.zone).toBe('inner')
    expect(nextHoverState(true, takeB!.zone, sameHoverPick(takeB!.info, hand('A')))).toBe(true)
  })

  it('纯外圈擦过（无内圈命中、未 hover）→ 无命中，hover 不误触；同目标外圈在前则采纳', () => {
    expect(resolveHoverHit([hit('B', true)], null)).toBeNull()
    expect(resolveHoverHit([], hand('A'))).toBeNull()
    const resolved = resolveHoverHit([hit('A', true), hit('A', false)], hand('A'))
    // 内圈优先于外圈：同目标时距离序首位的合法命中即采纳（此序中先外圈）
    expect(resolved!.zone).toBe('outer')
  })

  it('sameHoverPick：同 uid 同类为真，跨类/跨 uid/含 null 为假', () => {
    expect(sameHoverPick(hand('A'), hand('A'))).toBe(true)
    expect(sameHoverPick(hand('A'), hand('B'))).toBe(false)
    expect(sameHoverPick(hand('A'), { kind: 'unit', instanceId: 'A', ownerId: 'P1' })).toBe(false)
    expect(sameHoverPick(hand('A'), null)).toBe(false)
    expect(sameHoverPick(null, null)).toBe(true)
  })
})
