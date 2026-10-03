/**
 * 手牌扇形布局（M1-R3D3）—— 纯函数，无 Three.js 场景依赖，可无头测试。
 *
 * 炉石式手牌扇：牌沿 x 轴等距展开（总宽超限时自动压缩间距），
 * 绕排中心沿圆弧起伏、向两端微倾；张数越多张角越收（不超过 HAND_MAX_SPREAD）。
 */

import { HAND_ARC_HEIGHT, HAND_MAX_SPREAD, HAND_SLOT_DX } from './layout'

/** 一张手牌的最终摆位（世界坐标 + 欧拉角） */
export interface HandSlotTransform {
  x: number
  y: number
  z: number
  /** 绕 x 轴俯仰（牌面朝相机微仰） */
  rotX: number
  /** 绕 y 轴（暂用 0，保留翻牌演出） */
  rotY: number
  /** 绕 z 轴的扇形倾角 */
  rotZ: number
}

const HAND_BASE_Y = 0.12
/** 手牌微仰角 */
const HAND_TILT_X = -0.18
/** 手牌扇最大总宽（世界单位），超限则压缩间距 */
const HAND_MAX_WIDTH = 6.6
/** 倾角随张角的比例系数（封顶在视觉舒适值） */
const TILT_FACTOR = 0.55

/** 第 index 张（0 起）相对扇心的归一化张角（弧度） */
export function handSlotAngle(index: number, count: number): number {
  if (count <= 1) return 0
  const spread = Math.min(HAND_MAX_SPREAD, (count - 1) * 0.14)
  return spread * (index / (count - 1) - 0.5)
}

/**
 * 计算第 index 张在 count 张手牌中的摆位。
 * 纯函数：同输入恒同输出（确定性铁律对渲染层的延伸）。
 */
export function handSlotTransform(index: number, count: number, zBase: number): HandSlotTransform {
  const angle = handSlotAngle(index, count)
  const dx =
    count <= 1 ? HAND_SLOT_DX : Math.min(HAND_SLOT_DX, HAND_MAX_WIDTH / (count - 1))
  const x = (index - (count - 1) / 2) * dx
  const arcY = HAND_ARC_HEIGHT * (Math.cos(angle) - 1)
  const tilt = -angle * TILT_FACTOR
  return {
    x,
    y: HAND_BASE_Y + arcY,
    z: zBase - Math.abs(angle) * 0.9, // 两端牌略微后撤，增强扇形纵深感
    rotX: HAND_TILT_X,
    rotY: 0,
    rotZ: tilt === 0 ? 0 : Math.max(-0.2, Math.min(0.2, tilt)), // 中心牌恰为 +0（防 -0）
  }
}

/** 一次性铺开整手牌 */
export function handTransforms(count: number, zBase: number): HandSlotTransform[] {
  const out: HandSlotTransform[] = []
  for (let i = 0; i < count; i += 1) out.push(handSlotTransform(i, count, zBase))
  return out
}
