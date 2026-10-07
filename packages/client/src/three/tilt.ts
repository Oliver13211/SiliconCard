/**
 * 手牌 tilt 的纯逻辑层（演出修正阶段一，需求 1）。
 *
 * 抽动根因（本阶段定位）：hover 判定基于 tilt 变换后的几何 —— 指针停在拾取区
 * 边缘时「tilt 转动 → 边缘投影漂移出拾取区 → hover 丢失 → tilt 回正 → 边缘漂回
 * 拾取区 → hover 重进」构成正反馈环；叠加旧实现目标角直接取全画布指针 NDC
 * （与卡面位置无关，边缘处梯度不受控），抽动被进一步放大。
 *
 * 修法（三招组合，全部收敛为下面两个无头纯函数）：
 * 1. 目标角按「指针相对卡面中心的偏移」计算，并对最大角做饱和钳制
 *    （computeTiltTarget）—— 边缘处目标角有界、梯度归零，不再陡增；
 * 2. hover 进出加迟滞：内圈（核心拾取面）命中才进入，已 hover 时外圈
 *    （扩展拾取面）命中仍维持，离开外圈才交出（nextHoverState）——
 *    tilt 引起的边缘投影漂移落在迟滞带内，不再反复进出；
 * 3. 平滑时间常数加大（CardEntity 内 tilt 阻尼 10 → 6.5）。
 *
 * 本文件零依赖（无 Three.js），渲染线（TableRenderer / SceneManager）每帧调用，
 * 回归测试见 __tests__/tilt.test.ts（边缘输入下目标角不突变）。
 */

/** hover 射线命中区域：核心拾取面 / 仅迟滞外圈命中 / 未命中 */
export type HoverZone = 'inner' | 'outer' | 'none'

/** 拾取信息（结构等价于 CardEntity.PickInfo；type-only 引入，运行时零依赖） */
export type HoverPickInfo =
  | { kind: 'handCard'; uid: string; playerId: 'P1' | 'P2' }
  | { kind: 'unit'; instanceId: string; ownerId: 'P1' | 'P2' }
  | { kind: 'hero'; playerId: 'P1' | 'P2' }
  | { kind: 'pile'; pile: 'deck' | 'graveyard'; playerId: 'P1' | 'P2' }

/** 两个 pick 信息是否指向同一目标（迟滞状态机与 hover 变化检测共用） */
export function sameHoverPick(a: HoverPickInfo | null, b: HoverPickInfo | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  switch (a.kind) {
    case 'handCard':
      return b.kind === 'handCard' && a.uid === b.uid
    case 'unit':
      return b.kind === 'unit' && a.instanceId === b.instanceId
    case 'hero':
      return b.kind === 'hero' && a.playerId === b.playerId
    case 'pile':
      return b.kind === 'pile' && a.pile === b.pile
  }
}

/**
 * 目标角归一化半径（画布 NDC 单位）：指针偏离卡面中心该距离时达到满倾斜。
 * 参考量纲：table 机位下满手牌近端卡半宽 ≈0.08 NDC（16:9）、半高 ≈0.20 NDC，
 * 取略大于半宽/略小于半高的半径 → 卡面映射到约 0~60% 倾斜行程，边缘外饱和。
 */
export const TILT_REF_RADIUS_X = 0.15
export const TILT_REF_RADIUS_Y = 0.18

/** tilt 目标（-1..1，渲染端再乘 TILT_YAW / TILT_PITCH 得实际角） */
export interface TiltTarget {
  x: number
  y: number
}

function saturate(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

/**
 * tilt 目标角：指针 NDC（px,py）相对卡面中心 NDC（cx,cy）的偏移，按轴归一化并
 * 饱和钳制到 [-1,1]。纯函数、连续（钳制点 C0 且梯度归零）：指针扫过卡面边缘与
 * 饱和区时目标角不突变（回归测试保证）。
 */
export function computeTiltTarget(px: number, py: number, cx: number, cy: number): TiltTarget {
  return {
    x: saturate((px - cx) / TILT_REF_RADIUS_X),
    y: saturate((py - cy) / TILT_REF_RADIUS_Y),
  }
}

/**
 * hover 迟滞状态机（纯函数）：
 * - 未 hover：仅内圈命中才进入（外圈只是迟滞带，擦过不误触）；
 * - 已 hover 且仍是同一目标：内圈/外圈命中都维持，离开外圈（none）才退出；
 * - 已 hover 但射线落在其他目标上：只有其他目标的内圈才能接管 hover。
 * 输入 zone 来自射线测试对「首个命中载体是否迟滞外圈」的标记。
 */
export function nextHoverState(hovered: boolean, zone: HoverZone, sameTarget: boolean): boolean {
  if (!hovered) return zone === 'inner'
  return sameTarget ? zone !== 'none' : zone === 'inner'
}

// —— 射线命中解析（独立审查修复：迟滞外圈造成的 hover 死区） ——

/** 解析后的单条命中：对象链上首个 pick 信息 + 是否迟滞外圈 */
export interface HoverHit {
  info: HoverPickInfo
  guard: boolean
}

/**
 * 按射线距离序解析 hover 命中（纯函数，SceneManager.pickAt 的判定核心）。
 *
 * 规则（审查修复）：**迟滞外圈只服务既有 hover** —— guard 命中仅当其目标就是
 * 当前 hover 目标（sameHoverPick(info, lastHover)）才计 zone='outer'，否则跳过
 * 该命中继续找下一个。否则满手牌时扇心一侧邻卡（handLayout 两端后撤 → 邻卡
 * 更近相机）的 hoverGuard（半宽 0.69）会侵入当前卡 pickMesh（半宽 0.575）约
 * 0.115 世界单位并抢走首命中 → zone='outer' 且非同目标 → hover 永远无法建立，
 * 卡面边缘出现「点不亮」死区（恰是本阶段要修的悬停区）。
 * 非外圈命中一律采纳；全部命中被跳过 → null（= zone 'none'）。
 */
export function resolveHoverHit(
  hits: readonly HoverHit[],
  lastHover: HoverPickInfo | null,
): { info: HoverPickInfo; zone: HoverZone } | null {
  for (const hit of hits) {
    if (hit.guard && !sameHoverPick(hit.info, lastHover)) continue
    return { info: hit.info, zone: hit.guard ? 'outer' : 'inner' }
  }
  return null
}
