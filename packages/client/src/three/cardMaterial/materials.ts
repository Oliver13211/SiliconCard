/**
 * 卡牌拟真材质注册表（P2-R3D1）—— 全局共享，禁 per-card 克隆。
 *
 * 结构（任务书红线：材质按稀有度全局共享 ≤5 档实例）：
 * - 正面箔层（foil coat）：MeshPhysicalMaterial × 4 档（common/rare/epic/legendary）
 *   ——「加色箔层」架构：卡面 albedo 仍是既有 per-card MeshBasicMaterial（map 路径
 *   零改动、low 档直通旧扁平材质），箔层为叠在卡面上方的共享物理层
 *   （漫反射黑 + AdditiveBlending），只贡献法线浮雕高光 / 环境反射 / 传说
 *   clearcoat+iridescence 全息闪层。物理层不带 per-card map，故能严格共享；
 *   若把卡面 map 塞进共享物理材质，材质 uniform 是 per-material 的，同档所有卡
 *   只能显示同一张脸——three.js 下二者不可兼得，本架构以箔层拿满物理响应，
 *   共享实例数恰好 = 4 档 + 1 卡背 = 5。
 * - 卡背：MeshPhysicalMaterial × 1（map = 全卡共用卡背纹理，真正带 map 的共享
 *   物理材质；法线 = 卡背程序化浮雕，注册后一次注入）。
 * - 传说档：clearcoat + iridescence（视角依赖全息微流动，幅度克制；无逐帧动画，
 *   流动感来自视角/tilt 变化，帧循环零成本）。
 * - hover 亮态沿用现有共享切换模式（cardOutline 的注册表换引用），箔层本身
 *   不做亮态分身——hover 演出由描边亮态 + 辉光框 + 抬升承担，实例数保持 ≤5。
 *
 * 共享材质带 userData.shared 标记（与 cardOutline 同约定）：CardEntityPool /
 * SceneManager 的 dispose 遍历据此跳过，场景销毁不弄坏后续场景。
 * 材质构造仅依赖 THREE 数学库，无头可构造（不触发 WebGL）。
 */

import * as THREE from 'three'
import type { RarityTier } from '../cardArt/derive'

/** 箔层档位（= 稀有度四档；未知稀有度已在 cardArt/derive.rarityTierOf 归入 common） */
const COAT_TIERS: readonly RarityTier[] = ['common', 'rare', 'epic', 'legendary']

/** 各档环境反射强度（随稀有度微升；传说配合 clearcoat 最亮） */
const TIER_ENV_INTENSITY: Record<RarityTier, number> = {
  common: 1.2,
  rare: 1.3,
  epic: 1.45,
  legendary: 1.6,
}

const registry = new Map<string, THREE.MeshPhysicalMaterial>()
let backMaterial: THREE.MeshPhysicalMaterial | null = null

/**
 * 共享箔层材质（同档恒同实例；首建时注入当档法线贴图，此后忽略入参——
 * 法线纹理本身按档缓存，同档恒同纹理，不存在二次注入需求）。
 */
export function coatMaterialFor(tier: RarityTier, normalMap: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  const key = `coat|${tier}`
  let mat = registry.get(key)
  if (!mat) {
    const legendary = tier === 'legendary'
    mat = new THREE.MeshPhysicalMaterial({
      // 加色箔层：漫反射黑（加色下不可见），物理响应全来自高光/环境/清漆
      color: '#000000',
      metalness: 0,
      // 纸面基准粗糙度（任务书：纸面 0.7）；金属框感由法线贴图倾斜强度体现
      roughness: 0.7,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.FrontSide,
      normalMap: normalMap ?? null,
      normalScale: new THREE.Vector2(1, 1),
      envMapIntensity: TIER_ENV_INTENSITY[tier],
      // 传说卡 clearcoat 全息闪层（视角依赖微流动；其余档不开启）
      clearcoat: legendary ? 1 : 0,
      clearcoatRoughness: 0.22,
      iridescence: legendary ? 0.32 : 0,
      iridescenceIOR: 1.3,
      iridescenceThicknessRange: [120, 380],
    })
    mat.userData.shared = true
    registry.set(key, mat)
  }
  return mat
}

/**
 * 共享卡背物理材质（全进程唯一；map = 全卡共用卡背纹理）。
 * backNormal 首建时可缺省（法线异步生成后经 setBackNormalMap 注入）。
 */
export function backPhysicalMaterialFor(
  backMap: THREE.Texture,
  backNormal?: THREE.Texture | null,
): THREE.MeshPhysicalMaterial {
  if (!backMaterial) {
    backMaterial = new THREE.MeshPhysicalMaterial({
      map: backMap,
      metalness: 0.05,
      roughness: 0.62,
      normalMap: backNormal ?? null,
      normalScale: new THREE.Vector2(0.6, 0.6),
      envMapIntensity: 0.7,
    })
    backMaterial.userData.shared = true
  }
  return backMaterial
}

/** 一次性注入卡背法线（异步生成完成后调用；幂等，重复注入同纹理无副作用） */
export function setBackNormalMap(tex: THREE.Texture): void {
  if (!backMaterial || backMaterial.normalMap === tex) return
  backMaterial.normalMap = tex
  backMaterial.needsUpdate = true
}

/** 材质是否为跨实体共享的卡牌拟真材质（dispose 遍历据此跳过） */
export function isSharedCardMaterial(mat: THREE.Material): boolean {
  return mat.userData?.shared === true
}

/** 注册表当前实例数（测试观察口：4 箔层档 + 1 卡背 = ≤5） */
export function cardMaterialCount(): number {
  return registry.size + (backMaterial !== null ? 1 : 0)
}

/** 注册表实例数上限（架构红线断言用） */
export function cardMaterialLimit(): number {
  return COAT_TIERS.length + 1
}

/** 清空注册表并 dispose（仅测试隔离用；生产从不调用） */
export function disposeSharedCardMaterials(): void {
  for (const mat of registry.values()) mat.dispose()
  registry.clear()
  if (backMaterial) {
    backMaterial.dispose()
    backMaterial = null
  }
}
