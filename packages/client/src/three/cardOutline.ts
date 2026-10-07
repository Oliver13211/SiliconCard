/**
 * 3D 卡牌描边（演出修正阶段二·需求 2）—— inverted hull 背面扩张。
 *
 * 实现：CardEntity 内加一个略大于牌面的 BoxGeometry，材质 side=BackSide ——
 * 从任何视角只渲染盒体内壁，牌面（深度更近）遮挡中心，四周露出 ~2.5% 宽的
 * 色环，即经典 inverted hull 描边（背面扩张的等效手段，牌这种薄平面用盒体
 * 比沿法线扩张更稳：正反两面、侧棱与近侧视角下都有连续轮廓）。
 * 描边盒（1.05×1.04）小于拾取面（1.15×1.12）与迟滞外圈（1.38×1.32），
 * 不改变任何射线命中结果；且 Mesh.raycast 尊重 BackSide，外壁朝外的一面
 * 被剔除，不会抢先命中。
 *
 * 描边色：传说卡金边（与卡面稀有度宝石/金框同源 #ff9d2e），其余按派系主色。
 * hover/选中时切到共享注册表里的「亮态」材质（同色系提亮 + 不透明度拉满）。
 *
 * 性能红线（材质不爆炸）：材质全局共享注册表，键 = 色值×亮暗两态，
 * 上限 = 派系色 7 + 传说金 1 = 8 色 × 2 态 = 16 个实例，进程级复用、永不
 * per-card 克隆；几何每实体一份（随实体池复用，dispose 由池统一释放）。
 * 共享材质带 userData.shared 标记，CardEntityPool / SceneManager 的 dispose
 * 遍历必须跳过（见两处 guard），否则一次场景销毁会弄坏后续场景。
 * 纯函数部分（outlineColorFor）可无头测试；材质注册表仅依赖 THREE 数学库，
 * 无头可构造（不触发 WebGL）。
 */

import * as THREE from 'three'
import { FACTION_COLORS, shade } from './cardArt/color'

/** 传说金边（与 CardFace.rarityColor legendary 宝石色一致） */
export const OUTLINE_LEGENDARY_GOLD = '#ff9d2e'
/** 未知派系（占位卡 / 对手手牌未知牌面）的中性描边 */
export const OUTLINE_NEUTRAL = '#8b949e'

/**
 * 描边色（纯函数）：传说 → 金；其余 → 派系主色（未知派系走中性）。
 * 同一张卡（faction+rarity 固定）恒同色——确定性铁律。
 */
export function outlineColorFor(faction: string, rarity: string | undefined): string {
  if (rarity === 'legendary') return OUTLINE_LEGENDARY_GOLD
  return FACTION_COLORS[faction] ?? OUTLINE_NEUTRAL
}

const registry = new Map<string, THREE.MeshBasicMaterial>()

/** 亮态提亮系数（shade >1 为提亮）：hover/选中时描边加亮 */
const BRIGHT_SHADE = 1.45
/** 常态 / 亮态描边不透明度 */
const NORMAL_OPACITY = 0.85
const BRIGHT_OPACITY = 1

/**
 * 共享描边材质（同键恒同实例）。bright = hover/选中亮态。
 * 注册表有界（8 色 × 2 态），生产路径不清理；disposeSharedOutlineMaterials
 * 仅供测试隔离。
 */
export function outlineMaterial(hex: string, bright: boolean): THREE.MeshBasicMaterial {
  const key = `${hex}|${bright ? 1 : 0}`
  let mat = registry.get(key)
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({
      color: bright ? shade(hex, BRIGHT_SHADE) : hex,
      transparent: true,
      opacity: bright ? BRIGHT_OPACITY : NORMAL_OPACITY,
      side: THREE.BackSide,
      depthWrite: false,
    })
    mat.userData.shared = true
    registry.set(key, mat)
  }
  return mat
}

/** 注册表当前实例数（测试观察口：验证共享上限） */
export function outlineMaterialCount(): number {
  return registry.size
}

/** 清空共享注册表并 dispose（仅测试隔离用；生产从不调用） */
export function disposeSharedOutlineMaterials(): void {
  for (const mat of registry.values()) mat.dispose()
  registry.clear()
}

/** 材质是否为跨实体共享的描边材质（dispose 遍历据此跳过） */
export function isSharedOutlineMaterial(mat: THREE.Material): boolean {
  return mat.userData?.shared === true
}
