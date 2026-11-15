/**
 * 法线贴图缓存胶水（P2-R3D1）—— 复用卡面 TextureCache 体系，键扩展不重绘不泄漏。
 *
 * TextureCache.put 默认按 albedo 惯例打 SRGB 色域；法线/数据贴图必须线性
 * （NoColorSpace），此处入库后立即纠正——纠正发生在首次 GPU 上传前，
 * 无多余开销。无头环境（paint 返回 null）不入缓存直接回落 null，
 * 上层材质以无浮雕形态工作（可构造不炸）。
 */

import * as THREE from 'three'
import { TextureCache } from '../CardFace'

/**
 * 法线纹理入库/取用：键命中直接复用（不重绘）；未命中经 paint 生成后入库。
 * paint 返回 null（无 DOM）→ 返回 null 且不占缓存位。
 */
export function normalTextureFor(
  cache: TextureCache,
  key: string,
  paint: () => HTMLCanvasElement | null,
): THREE.CanvasTexture | null {
  const hit = cache.get(key)
  if (hit) return hit
  const canvas = paint()
  if (!canvas) return null
  const tex = cache.put(key, canvas)
  tex.colorSpace = THREE.NoColorSpace
  tex.anisotropy = 4
  return tex
}
