/**
 * M4-R3D5 第一阶段无头测试：卡面图形系统的纯函数部分。
 * - deriveFaceArt：图形参数派生（cardId 确定性哈希 → 骨架×母题×框饰×角标×背景层）；
 * - buildFaceArtSvg / svgToDataUri：SVG 组装（纯字符串，零 DOM）。
 * 不 import 触发 DOM canvas 的执行路径（CardFace 顶层的 drawCardFace 等留给 WF-VISUAL 截图验收）。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition, Keyword } from '@siliconcard/core'
import { deriveFaceArt, keywordMarkOf, mulberry32, rarityTierOf } from '../cardArt/derive'
import { buildFaceArtSvg, svgToDataUri } from '../cardArt/svg'
import { resolvePalette } from '../CardFace'
import { fnv1a } from '../cardArt/color'

function defOf(over: Partial<CardDefinition> = {}): CardDefinition {
  return {
    id: 'test-card',
    name: '测试卡',
    faction: 'nvidia',
    type: 'gpu',
    cost: 300,
    attack: 4,
    health: 5,
    rarity: 'rare',
    keywords: [],
    art: { shape: 'gpu_dual_fan', palette: 'nvidia', glow: 'green' },
    ...over,
  }
}

describe('deriveFaceArt（图形参数派生）', () => {
  it('同一张卡两次派生结果完全一致（确定性，禁 Math.random/Date）', () => {
    const def = defOf({ id: 'rtx-5090', keywords: ['taunt', 'charge'], rarity: 'legendary' })
    expect(deriveFaceArt(def)).toEqual(deriveFaceArt(def))
    expect(deriveFaceArt(def)).toEqual(deriveFaceArt({ ...def }))
  })

  it('不同 cardId 种子必然不同（90 卡可辨识的根基）', () => {
    const ids = ['a', 'b', 'nvidia-12v-2x6', 'amd-adrenalin', 'intel-arc-a380']
    const seeds = ids.map((id) => deriveFaceArt(defOf({ id })).seed)
    expect(new Set(seeds).size).toBe(ids.length)
    seeds.forEach((s) => expect(s).toBe(fnv1a(ids[seeds.indexOf(s)] ?? '')))
  })

  it('gpu 形制骨架：shape 名映射风扇数（双风扇/三风扇/单风扇/涡轮）', () => {
    expect(deriveFaceArt(defOf({ art: { shape: 'gpu_dual_fan', palette: 'nvidia' } }))?.fanCount).toBe(2)
    expect(deriveFaceArt(defOf({ art: { shape: 'gpu_double_fan', palette: 'nvidia' } }))?.fanCount).toBe(2)
    expect(deriveFaceArt(defOf({ art: { shape: 'gpu_triple_fan', palette: 'nvidia' } }))?.fanCount).toBe(3)
    expect(deriveFaceArt(defOf({ art: { shape: 'gpu_single_fan', palette: 'nvidia' } }))?.fanCount).toBe(1)
    const blower = deriveFaceArt(defOf({ art: { shape: 'gpu_blower', palette: 'nvidia' } }))
    expect(blower?.skeleton).toBe('gpu_blower')
    expect(blower?.fanCount).toBe(1)
  })

  it('driver/accessory 形制骨架：shape 名映射芯片/盘片/接口/板等', () => {
    expect(deriveFaceArt(defOf({ type: 'driver', art: { shape: 'driver_disc', palette: 'amd_red' } }))?.skeleton).toBe('disc')
    expect(deriveFaceArt(defOf({ type: 'driver', art: { shape: 'soc_die', palette: 'intel' } }))?.skeleton).toBe('chip_die')
    expect(deriveFaceArt(defOf({ type: 'driver', art: { shape: 'soc_dual_die', palette: 'intel' } }))?.dieCount).toBe(2)
    expect(deriveFaceArt(defOf({ type: 'accessory', art: { shape: 'power_connector', palette: 'neutral_gray' } }))?.skeleton).toBe('connector')
    expect(deriveFaceArt(defOf({ type: 'accessory', art: { shape: 'motherboard_atx', palette: 'neutral_gray' } }))?.skeleton).toBe('board')
    expect(deriveFaceArt(defOf({ type: 'accessory', art: { shape: 'cooler_tower', palette: 'noctua_beige' } }))?.skeleton).toBe('cooler')
    expect(deriveFaceArt(defOf({ type: 'accessory', art: { shape: 'gaming_mouse', palette: 'logitech_blue' } }))?.skeleton).toBe('peripheral')
  })

  it('未知 shape 按 type 确定性兜底（数据驱动扩展零改动），且同 id 恒同', () => {
    const unknown = defOf({ id: 'mystery-gpu', art: { shape: 'brand_new_form', palette: 'nvidia' } })
    const a = deriveFaceArt(unknown)
    const b = deriveFaceArt(unknown)
    expect(a.skeleton).toBe(b.skeleton)
    expect(a.skeleton).toBe('gpu_fans') // gpu 缺省走风扇阵
    expect([1, 2, 3]).toContain(a.fanCount)
    const noArt = deriveFaceArt(defOf({ id: 'placeholder-x', art: undefined, type: 'accessory' }))
    expect(noArt.skeleton).toBe(noArt.skeleton)
    expect(['connector', 'board', 'cooler', 'peripheral']).toContain(noArt.skeleton)
  })

  it('派系母题：七系直取', () => {
    const factions = ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'neutral'] as const
    for (const f of factions) {
      expect(deriveFaceArt(defOf({ faction: f }))?.motif).toBe(f)
    }
  })

  it('未知派系确定性落一系合法母题（数据驱动零改动）', () => {
    const def = defOf({ id: 'mystery-faction-card', faction: 'via' })
    const a = deriveFaceArt(def)
    const b = deriveFaceArt(def)
    expect(a.motif).toBe(b.motif)
    expect(['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'neutral']).toContain(a.motif)
  })

  it('稀有度框饰：四档直取，starter/未定义归 common', () => {
    expect(rarityTierOf('legendary')).toBe('legendary')
    expect(rarityTierOf('epic')).toBe('epic')
    expect(rarityTierOf('rare')).toBe('rare')
    expect(rarityTierOf('common')).toBe('common')
    expect(rarityTierOf('starter')).toBe('common')
    expect(rarityTierOf(undefined)).toBe('common')
  })

  it('关键词角标：七种关键词全覆盖且互不相同，未知关键词被过滤', () => {
    const kws: Keyword[] = ['taunt', 'divine_shield', 'charge', 'windfury', 'deathrattle', 'stealth', 'overload']
    const marks = kws.map((k) => keywordMarkOf(k))
    expect(new Set(marks).size).toBe(7)
    expect(deriveFaceArt(defOf({ keywords: kws }))?.marks).toEqual(marks)
    expect(deriveFaceArt(defOf({ keywords: ['nope' as Keyword] }))?.marks).toEqual([])
    expect(deriveFaceArt(defOf({ keywords: undefined }))?.marks).toEqual([])
  })

  it('背景层选型确定性且至少保一层，子种子独立', () => {
    for (const id of ['bg-a', 'bg-b', 'bg-c', 'bg-d', 'bg-e']) {
      const bg = deriveFaceArt(defOf({ id }))?.bg
      expect(bg?.diagonal).toBe(true)
      expect(bg?.traces || bg?.grid || bg?.noise).toBe(true)
      expect(bg?.traceSeed).not.toBe(bg?.noiseSeed)
      expect(deriveFaceArt(defOf({ id }))?.bg).toEqual(bg)
    }
  })

  it('母题抖动参数在约定范围内（同母题不同卡不重样）', () => {
    const p = deriveFaceArt(defOf({ id: 'jitter-card' }))
    expect(Math.abs(p?.motifRot ?? 0)).toBeLessThanOrEqual(14)
    expect(p?.motifScale).toBeGreaterThanOrEqual(0.92)
    expect(p?.motifScale).toBeLessThanOrEqual(1.08)
    expect(Math.abs(p?.motifShiftY ?? 0)).toBeLessThanOrEqual(8)
    expect(p?.glow).toBe(true) // defOf 自带 glow
    expect(deriveFaceArt(defOf({ art: { shape: 'chip', palette: 'intel' } }))?.glow).toBe(false)
  })
})

describe('mulberry32（确定性随机流）', () => {
  it('同种子同序列，异种子异序列，输出在 [0,1)', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    const seqA = [a(), a(), a(), a()]
    const seqB = [b(), b(), b(), b()]
    expect(seqA).toEqual(seqB)
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true)
    const c = mulberry32(12346)
    expect([c(), c(), c(), c()]).not.toEqual(seqA)
  })
})

describe('buildFaceArtSvg（SVG 组装）', () => {
  const pal = resolvePalette({ shape: 'fan', palette: 'nvidia' }, 'nvidia')

  it('基本形态：svg 根节点 + 尺寸 + viewBox', () => {
    const svg = buildFaceArtSvg(deriveFaceArt(defOf()), pal)
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(svg).toContain('width="512"')
    expect(svg).toContain('height="718"')
    expect(svg).toContain('viewBox="0 0 512 718"')
    expect(svg.endsWith('</svg>')).toBe(true)
  })

  it('同参数恒同串（组装确定性）', () => {
    const params = deriveFaceArt(defOf({ id: 'stable-svg', keywords: ['taunt'] }))
    expect(buildFaceArtSvg(params, pal)).toBe(buildFaceArtSvg(params, pal))
    expect(buildFaceArtSvg(deriveFaceArt(defOf({ id: 'stable-svg', keywords: ['taunt'] })), pal)).toBe(
      buildFaceArtSvg(params, pal),
    )
  })

  it('不同参数不同串（组合可辨识）', () => {
    const a = buildFaceArtSvg(deriveFaceArt(defOf({ id: 'svg-a' })), pal)
    const b = buildFaceArtSvg(deriveFaceArt(defOf({ id: 'svg-b' })), pal)
    expect(a).not.toBe(b)
    const amd = buildFaceArtSvg(deriveFaceArt(defOf({ id: 'svg-a', faction: 'amd' })), resolvePalette({ shape: 'fan', palette: 'amd_red' }, 'amd'))
    expect(amd).not.toBe(a) // 母题/配色不同 → 图形不同
  })

  it('形制骨架与风扇数写入 data 标记', () => {
    const dual = buildFaceArtSvg(deriveFaceArt(defOf({ art: { shape: 'gpu_dual_fan', palette: 'nvidia' } })), pal)
    expect(dual).toContain('data-skeleton="gpu_fans"')
    expect(dual.match(/data-fan=/g)?.length).toBe(2)
    const triple = buildFaceArtSvg(deriveFaceArt(defOf({ art: { shape: 'gpu_triple_fan', palette: 'nvidia' } })), pal)
    expect(triple.match(/data-fan=/g)?.length).toBe(3)
    expect(buildFaceArtSvg(deriveFaceArt(defOf({ art: { shape: 'driver_disc', palette: 'amd_red' } })), pal)).toContain(
      'data-skeleton="disc"',
    )
  })

  it('稀有度框饰档位标记；legendary 明显高一档（多出渐变与辉光带）', () => {
    expect(buildFaceArtSvg(deriveFaceArt(defOf({ rarity: 'legendary' })), pal)).toContain('data-tier="legendary"')
    const leg = buildFaceArtSvg(deriveFaceArt(defOf({ rarity: 'legendary' })), pal)
    expect(leg).toContain('url(#leg-grad)')
    expect(leg).toContain('url(#fr-glow)')
    for (const tier of ['common', 'rare', 'epic', 'legendary'] as const) {
      expect(buildFaceArtSvg(deriveFaceArt(defOf({ rarity: tier === 'common' ? 'starter' : tier })), pal)).toContain(
        `data-tier="${tier}"`,
      )
    }
  })

  it('派系母题与关键词角标写入 data 标记', () => {
    const svg = buildFaceArtSvg(deriveFaceArt(defOf({ faction: 'qualcomm', keywords: ['windfury', 'overload'] })), pal)
    expect(svg).toContain('data-motif="qualcomm"')
    expect(svg).toContain('data-mark="dual_core"')
    expect(svg).toContain('data-mark="trip"')
  })

  it('无角标时不输出 data-mark（占位符不渲染）', () => {
    const svg = buildFaceArtSvg(deriveFaceArt(defOf({ keywords: [] })), pal)
    expect(svg).not.toContain('data-mark=')
  })

  it('禁外部资源：无 href / 无 <image> / 无网络字体引用', () => {
    const cases = [
      defOf({ id: 'x1', rarity: 'legendary', keywords: ['taunt', 'divine_shield', 'charge', 'windfury', 'deathrattle', 'stealth', 'overload'] }),
      defOf({ id: 'x2', faction: 'arm', art: { shape: 'aio_radiator', palette: 'arm' } }),
      defOf({ id: 'x3', faction: 'mystery', art: undefined, type: 'accessory' }),
    ]
    for (const def of cases) {
      const svg = buildFaceArtSvg(deriveFaceArt(def), resolvePalette(def.art, def.faction))
      expect(svg).not.toMatch(/href/i)
      expect(svg).not.toContain('<image')
      expect(svg).not.toMatch(/@import|url\(http/)
    }
  })
})

describe('svgToDataUri（内联编码）', () => {
  it('data URI 前缀正确且可逆（SVG 经 data URI → Image 内联渲染，无网络请求）', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#76b900"/></svg>'
    const uri = svgToDataUri(svg)
    expect(uri.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true)
    expect(uri).not.toContain('<') // 已全量转义，无裸标记
    expect(decodeURIComponent(uri.slice(uri.indexOf(',') + 1))).toBe(svg)
  })
})
