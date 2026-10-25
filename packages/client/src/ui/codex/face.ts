/**
 * 图鉴卡面同源渲染（P2-UI4 验收：图鉴内卡面与对局内卡面完全一致，同一渲染函数）。
 *
 * 与 TableRenderer.getFace（packages/client/src/three/TableRenderer.ts）同管线：
 *   drawCardFace（同步底：背景+质感+底版+角标）→ composeCardFaceArt（异步补绘 SVG 图形层），
 *   缓存键同为 CardFace.cardFaceCacheKey；图鉴不传 cost/attack/health（用定义基础值），
 *   与对局内满血新手牌的缓存键等价（cardFaceCacheKey 对缺省回落 def 数值）。
 *
 * 禁止在图鉴里另画一套卡面视觉；本模块只做「取缓存 → 绘制 → 贴到展示 canvas」。
 */

import type { CardDefinition } from '@siliconcard/core'
import {
  cardFaceCacheKey,
  composeCardFaceArt,
  drawCardFace,
  FACE_H,
  FACE_W,
  TextureCache,
  type CardFaceParams,
} from '../../three/CardFace'

type FaceTexture = ReturnType<TextureCache['get']>

/** 图鉴卡面渲染入参：与对局内基础形态完全同参（缺省 cost/attack/health 回落定义值） */
export function codexFaceParams(def: CardDefinition): CardFaceParams {
  return { def }
}

/** 图鉴专用纹理缓存（与 TableRenderer 的 faceCache 分实例，避免跨屏生命周期纠缠） */
export const codexFaceCache = new TextureCache()

/**
 * 确保缓存里有该卡卡面（缓存复用的唯一入口）：
 * 未命中时 drawCardFace 绘制入库，并按 TableRenderer 同款流程异步 composeCardFaceArt
 * 补绘 SVG 图形层（完成后 needsUpdate 并回调 onComposed，失败静默）。
 * 返回缓存纹理与是否本次新绘制（供缓存复用断言）。
 */
export function ensureCodexFace(
  cache: TextureCache,
  def: CardDefinition,
  draw: (p: CardFaceParams) => HTMLCanvasElement = drawCardFace,
  onComposed?: () => void,
): { texture: FaceTexture; drawn: boolean } {
  const params = codexFaceParams(def)
  const key = cardFaceCacheKey(params)
  const hit = cache.get(key)
  if (hit) return { texture: hit, drawn: false }
  const canvas = draw(params)
  const texture = cache.put(key, canvas)
  void composeCardFaceArt(canvas, params)
    .then(() => {
      texture.needsUpdate = true
      onComposed?.()
    })
    .catch(() => {})
  return { texture, drawn: true }
}

function blit(target: HTMLCanvasElement, texture: FaceTexture): void {
  const ctx = target.getContext('2d')
  if (!ctx) return
  target.width = FACE_W
  target.height = FACE_H
  const image = texture?.image
  if (image) ctx.drawImage(image as CanvasImageSource, 0, 0)
}

/**
 * 把缓存卡面贴到图鉴的展示 canvas 上：
 * 同步先贴「背景+质感+底版+角标」底图；SVG 图形层异步就绪后（onComposed）再贴一次刷新。
 * 展示 canvas 不进缓存，缓存里那张 canvas 由 compose 原地补绘（与 TableRenderer 一致）。
 */
export function blitCodexFace(
  target: HTMLCanvasElement,
  cache: TextureCache,
  def: CardDefinition,
  draw: (p: CardFaceParams) => HTMLCanvasElement = drawCardFace,
): void {
  const first = ensureCodexFace(cache, def, draw, () => {
    // compose 完成后缓存画布已含 SVG 图形层：再贴一次刷新展示图
    if (target.isConnected) blit(target, cache.get(cardFaceCacheKey(codexFaceParams(def))))
  })
  blit(target, first.texture)
}
