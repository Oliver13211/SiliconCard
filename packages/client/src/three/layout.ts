/**
 * 牌桌空间布局（M1-R3D1/R3D3）—— 全部数值集中于此，禁止散落硬编码。
 *
 * 坐标约定：玩家 P1 在 +z 一侧（近相机），P2 在 -z 一侧；x 轴左右；
 * y 轴向上。本文件不含 Three.js 依赖（除 Vector3 类型），保证纯逻辑可无头测试。
 */

import type { PlayerId } from '@siliconcard/core'
import * as THREE from 'three'

/** 卡牌 mesh 尺寸（世界单位；比例约 5:7，与 CardFace 画布 512×718 一致） */
export const CARD_W = 1.0
export const CARD_H = 1.4

/** 手牌排的 z 基线（玩家 / 对手镜像） */
export const HAND_Z = 3.7
/** 手牌扇形的最大总张角（弧度，10 张满手时不超此值） */
export const HAND_MAX_SPREAD = Math.PI * 0.42
/** 扇形弯曲：牌相对排中心的额外 y 抬升系数 */
export const HAND_ARC_HEIGHT = 0.55
/** 手牌重叠间距（x 方向每张偏移） */
export const HAND_SLOT_DX = 0.78
/** hover 抬起量（R3D3 交互态） */
export const HAND_HOVER_LIFT = 0.55

/** 场上单位排（扩展槽 BOARD_LIMIT=7）的 z 基线 */
export const BOARD_Z = { P1: 1.15, P2: -1.15 } as const
/** 场上单位相邻槽位间距 */
export const BOARD_SLOT_DX = 1.28

/** 英雄铭牌位置 */
export const HERO_Z = { P1: 2.95, P2: -2.95 } as const
export const HERO_X = 0

/** 牌库堆 / 墓地堆位置（x 正负镜像） */
export const PILE = {
  deck: { x: 4.6, z: 3.1 },
  graveyard: { x: -4.6, z: 3.1 },
} as const

/** 桌面尺寸 */
export const TABLE_W = 22
export const TABLE_D = 14

/** 演出机位（M1-R3D1 验收：含演出机位）。position + lookAt 成对出现。 */
export const CAMERA_SHOTS = {
  /** 常规对战机位（默认） */
  table: { pos: new THREE.Vector3(0, 7.4, 8.8), look: new THREE.Vector3(0, 0, 0.35) },
  /** 开局演出：低角度掠入 */
  intro: { pos: new THREE.Vector3(0, 2.6, 13.5), look: new THREE.Vector3(0, 0.6, 0) },
  /** 结算机位：略俯视全场 */
  gameEnd: { pos: new THREE.Vector3(0, 8.6, 7.2), look: new THREE.Vector3(0, 0, -0.2) },
} as const

export type CameraShot = keyof typeof CAMERA_SHOTS

/** 玩家侧向系数：P1（自己）= +1，P2 = -1。镜像一切 z 布局。 */
export function sideOf(playerId: PlayerId): 1 | -1 {
  return playerId === 'P1' ? 1 : -1
}
