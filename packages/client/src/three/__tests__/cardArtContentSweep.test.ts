/**
 * M4-R3D5 第一阶段内容包全量扫描：packages/content/cards 下全部卡牌定义
 * 经「派生 → SVG 组装」自动覆盖，并验证组合系统的核心承诺——
 * 同卡恒同图（确定性）、不同卡互不同图（可辨识）、四层组合参数全部合法。
 *
 * content JSON 只读（跨包只读消费，不修改 content 包）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { CardDefinition } from '@siliconcard/core'
import { deriveFaceArt } from '../cardArt/derive'
import { buildFaceArtSvg } from '../cardArt/svg'
import { resolvePalette } from '../CardFace'

const CARDS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../../packages/content/cards',
)

function loadAllCardDefs(): CardDefinition[] {
  const defs: CardDefinition[] = []
  for (const faction of readdirSync(CARDS_DIR)) {
    if (!statSync(join(CARDS_DIR, faction)).isDirectory()) continue // 跳过 .gitkeep 等
    const dir = join(CARDS_DIR, faction)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      defs.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')) as CardDefinition)
    }
  }
  return defs
}

describe('内容包 90 卡全量扫描（组合覆盖 + 恒同图）', () => {
  const defs = loadAllCardDefs()

  it('content 卡牌全部加载（当前 90 张）', () => {
    expect(defs.length).toBe(90)
  })

  it('同卡两次派生恒同图（确定性哈希，禁 Math.random/Date）', () => {
    for (const def of defs) {
      const a = deriveFaceArt(def)
      const b = deriveFaceArt(def)
      expect(a).toEqual(b)
      const palA = resolvePalette(def.art, def.faction)
      expect(buildFaceArtSvg(a, palA)).toBe(buildFaceArtSvg(b, palA))
    }
  })

  it('90 张卡 SVG 互不相同（组合自动全覆盖、可辨识）', () => {
    const svgs = defs.map((def) => buildFaceArtSvg(deriveFaceArt(def), resolvePalette(def.art, def.faction)))
    expect(new Set(svgs).size).toBe(defs.length)
  })

  it('全部卡牌的四层组合参数落在合法集合内', () => {
    const tiers = new Set(['common', 'rare', 'epic', 'legendary'])
    for (const def of defs) {
      const p = deriveFaceArt(def)
      expect(tiers.has(p.rarityTier)).toBe(true)
      expect([
        'gpu_fans',
        'gpu_blower',
        'chip_die',
        'disc',
        'connector',
        'board',
        'cooler',
        'peripheral',
        'wave',
        'crystal',
      ]).toContain(p.skeleton)
      expect(['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'neutral']).toContain(p.motif)
      for (const m of p.marks) {
        expect(['shield', 'halo_shield', 'bolt', 'dual_core', 'bsod', 'ghost', 'trip']).toContain(m)
      }
      const svg = buildFaceArtSvg(p, resolvePalette(def.art, def.faction))
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      expect(svg).not.toMatch(/href/i)
    }
  })

  it('形制骨架全表命中：风扇类 gpu shape 全部落风扇系骨架，无一类落兜底', () => {
    const fanShapes = new Set(['gpu_single_fan', 'gpu_dual_fan', 'gpu_double_fan', 'gpu_triple_fan', 'gpu_dual_core'])
    for (const def of defs) {
      const shape = def.art?.shape
      if (shape !== undefined && fanShapes.has(shape)) {
        expect(deriveFaceArt(def)?.skeleton).toBe('gpu_fans')
      }
      if (shape === 'gpu_blower') {
        expect(deriveFaceArt(def)?.skeleton).toBe('gpu_blower')
      }
    }
  })
})
