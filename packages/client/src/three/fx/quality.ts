/**
 * 全局特效质量开关（M4-R3D5 性能红线：特效可全局降级）。
 *
 * 职责：
 * - high：全部演出开启（粒子/碎片/光柱/电弧/光束/震屏/主题染色/拖影）；
 * - low：中端设备/集显降级——只保留「可感知演出」的骨架（飘字/横幅/闪屏/
 *   实体补间），重型粒子类特效关闭，其余特效量减半；
 *   M4-SND1 起同时约束音频：audioExtras 关闭（次要泛音/BGM 节拍），关键事件音保留。
 *
 * 模块级单例：池在 spawn 时读 gate，运行时切换立即生效（无需重建池）。
 * 纯逻辑部分（scaleFxCount / fxEnabled）可无头测试。
 */

/** 特效质量档位 */
export type EffectQuality = 'high' | 'low'

/** 重型特效分类（low 档关闭或减量的开关粒度） */
export type FxFeature =
  | 'particles' // 粒子（low 保留一半量）
  | 'shards' // 死亡碎裂（low 关闭，退化为光环 + 烟）
  | 'pillars' // 光柱（传说入场 / 召唤 / 传送）
  | 'bolts' // 电弧（跳闸 / 光追失败）
  | 'beams' // 直射光束（开光追）
  | 'shake' // 镜头微震
  | 'theme' // 牌桌派系染色
  | 'trails' // 帧插值拖影（DLSS）
  | 'audioExtras' // 音效装饰层（M4-SND1：low 档关闭次要泛音/BGM 节拍，关键事件音保留）

let quality: EffectQuality = 'high'

export function setEffectQuality(q: EffectQuality): void {
  quality = q
}

export function getEffectQuality(): EffectQuality {
  return quality
}

/** low 档是否关闭某类重型特效（high 恒全开） */
export function fxEnabled(feature: FxFeature): boolean {
  if (quality === 'high') return true
  switch (feature) {
    case 'particles':
      return true // 粒子降量不关（保留最小可感知反馈）
    default:
      return false
  }
}

/** 粒子量缩放：high 恒等；low 减半但至少保留 1（0 原样返回） */
export function scaleFxCount(count: number): number {
  if (quality === 'high') return count
  if (count <= 0) return 0
  return Math.max(1, Math.ceil(count / 2))
}
