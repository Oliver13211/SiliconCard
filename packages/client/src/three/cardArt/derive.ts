/**
 * 卡面图形参数派生（M4-R3D5 第一阶段）—— 纯函数，零 DOM 依赖。
 *
 * 组合式卡面：每张卡的专属图形 = 形制骨架（type 形制 + art.shape 细化）
 * × 派系图案母题（七系各一，未知派系确定性落一系）
 * × 稀有度框饰（common/rare/epic/legendary 四档，legendary 明显高一档）
 * × 关键词角标（七种）× 背景层选型（走线/网格/噪声/对角渐变组合）。
 *
 * 一切随机参数派生自 cardId 的 FNV-1a 确定性哈希（fnv1a + mulberry32 种子流），
 * 禁 Math.random / Date——同一张卡每次生成恒同图。
 * 卡面数值（色板）不在本模块：resolvePalette 保留在 color.ts（M1 逻辑零变化）。
 */

import type { CardDefinition, Keyword } from '@siliconcard/core'
import { fnv1a, mulberry32 } from './color'

/** 确定性随机流随派生模块一并暴露（background.ts 与测试共用） */
export { mulberry32 } from './color'

/** 形制骨架种类：type 定大类，art.shape 细化（44 个已知 shape 名全表覆盖） */
export type SkeletonKind =
  | 'gpu_fans' // 显卡风扇阵（1/2/3 风扇）
  | 'gpu_blower' // 涡轮卡（单风扇 + 散热鳍 + 尾部出风）
  | 'chip_die' // 裸片/SoC（基板 + die + 引脚）
  | 'disc' // 光盘/驱动盘片
  | 'connector' // 接口/金手指
  | 'board' // PCB 板类（主板/笔记本盖板/内存条）
  | 'cooler' // 散热器（塔式/冷排/下压罩）
  | 'peripheral' // 外设（键鼠/椅/质保卡）
  | 'wave' // 波形/灯带流光
  | 'crystal' // 晶体/圆柱机身

/** 派系图案母题：内置七系；未知派系按哈希确定性映射到一系（数据驱动零改动） */
export type MotifKind = 'nvidia' | 'amd' | 'intel' | 'apple' | 'qualcomm' | 'arm' | 'neutral'

/** 稀有度框饰档位：starter/未定义 归入 common 档 */
export type RarityTier = 'common' | 'rare' | 'epic' | 'legendary'

/** 关键词角标（七种，与 core Keyword 一一对应） */
export type KeywordMarkKind =
  | 'shield' // taunt 信仰充值：盾
  | 'halo_shield' // divine_shield 三年质保：盾 + 质保环
  | 'bolt' // charge 超频：闪电
  | 'dual_core' // windfury 双芯 GPU：双核
  | 'bsod' // deathrattle 蓝屏：碎屏
  | 'ghost' // stealth 无输出亮机：幽灵
  | 'trip' // overload 跳闸：断路折线

/** 背景层选型：对角渐变恒开（底），走线/网格/噪声场按种子位选配，至少保一层 */
export interface BgLayers {
  diagonal: true
  traces: boolean
  grid: boolean
  noise: boolean
  /** 走线/噪声各自的确定性子种子（供 background.ts 的 mulberry32 使用） */
  traceSeed: number
  noiseSeed: number
}

/** 派生结果：SVG 组装与背景绘制的唯一输入（纯数据，可 JSON 序列化） */
export interface FaceArtParams {
  cardId: string
  /** 主种子（fnv1a(cardId)），测试与调试用 */
  seed: number
  skeleton: SkeletonKind
  /** 风扇数（仅 gpu_fans / gpu_blower 有效，其余为 0） */
  fanCount: number
  /** 单扇叶数（7/9/11，风扇类骨架用） */
  bladeCount: number
  /** die 数（chip_die 用，soc_dual_die 等为 2） */
  dieCount: number
  motif: MotifKind
  /** 母题抖动参数：让同母题不同卡不重样（确定性派生） */
  motifRot: number
  motifScale: number
  motifShiftY: number
  rarityTier: RarityTier
  marks: KeywordMarkKind[]
  bg: BgLayers
  /** art.glow 是否存在（存在时骨架加径向辉光衬底，保留 M1 art 参数语义） */
  glow: boolean
  /** 已知 art.shape 名（形制子变体渲染选择，如 gaming_mouse / ram_stick）；未知/缺省为 '' */
  variant: string
  /** 形态流 0..1：风扇扫掠角/纹样密度/几何变体等 cardId 确定性来源 */
  morph: number
  /** 第二形态流 0..1：风扇倾角/波形频率等 */
  morph2: number
  /** 第三形态流 0..1：微调/点缀相位等 */
  morph3: number
}

// —— 卡面几何常量（SVG 层与 Canvas 底版共用，单位 = 画布像素） ——

/** 布局常量移至 cardArt/layout（卡面大改版：插画窗升格主视觉），此处再导出保持既有引用路径 */
export { ART_WINDOW, KEYWORD_ROW_Y } from './layout'

// —— 已知 art.shape → 形制骨架 全表（content 现存 44 名逐一覆盖；未知名走 type 兜底） ——

interface SkeletonSpec {
  skeleton: SkeletonKind
  fanCount?: number
  dieCount?: number
}

const SHAPE_TABLE: Record<string, SkeletonSpec> = {
  // gpu 类
  gpu_dual_fan: { skeleton: 'gpu_fans', fanCount: 2 },
  gpu_double_fan: { skeleton: 'gpu_fans', fanCount: 2 },
  gpu_dual_core: { skeleton: 'gpu_fans', fanCount: 2 },
  gpu_triple_fan: { skeleton: 'gpu_fans', fanCount: 3 },
  gpu_single_fan: { skeleton: 'gpu_fans', fanCount: 1 },
  gpu_blower: { skeleton: 'gpu_blower', fanCount: 1 },
  gpu_bare_board: { skeleton: 'board' },
  cooler_shroud: { skeleton: 'cooler' },
  // 芯片类（gpu/driver 皆可）
  chip: { skeleton: 'chip_die' },
  soc_die: { skeleton: 'chip_die' },
  soc_dual_die: { skeleton: 'chip_die', dieCount: 2 },
  igpu_chip: { skeleton: 'chip_die' },
  cpu_dieshot: { skeleton: 'chip_die' },
  codec_block: { skeleton: 'chip_die' },
  psu_block: { skeleton: 'chip_die' },
  // 盘片类（driver 为主）
  driver_disc: { skeleton: 'disc' },
  driver_installer: { skeleton: 'disc' },
  patch_note: { skeleton: 'disc' },
  spell_drive: { skeleton: 'disc' },
  spell_donut: { skeleton: 'disc' },
  // 接口类
  connector: { skeleton: 'connector' },
  power_connector: { skeleton: 'connector' },
  display_out: { skeleton: 'connector' },
  // 板类
  motherboard_atx: { skeleton: 'board' },
  motherboard_matx: { skeleton: 'board' },
  switch_pcb: { skeleton: 'board' },
  riser_pcb: { skeleton: 'board' },
  mini_pc: { skeleton: 'board' },
  macbook_pro_lid: { skeleton: 'board' },
  macbook_air_wedge: { skeleton: 'board' },
  ram_stick: { skeleton: 'board' },
  // 散热类
  cooler_tower: { skeleton: 'cooler' },
  aio_radiator: { skeleton: 'cooler' },
  // 外设类
  gaming_chair: { skeleton: 'peripheral' },
  gaming_mouse: { skeleton: 'peripheral' },
  keyboard_deck: { skeleton: 'peripheral' },
  genius_counter: { skeleton: 'peripheral' },
  warranty_card: { skeleton: 'peripheral' },
  // 晶体类
  mac_pro_cylinder: { skeleton: 'crystal' },
  unified_memory: { skeleton: 'crystal' },
  // 波形类
  voltage_curve: { skeleton: 'wave' },
  wave: { skeleton: 'wave' },
  spell_bolt: { skeleton: 'wave' },
  rgb_strip: { skeleton: 'wave' },
}

const MOTIFS: readonly MotifKind[] = ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'neutral']

const KEYWORD_MARKS: Record<Keyword, KeywordMarkKind> = {
  taunt: 'shield',
  divine_shield: 'halo_shield',
  charge: 'bolt',
  windfury: 'dual_core',
  deathrattle: 'bsod',
  stealth: 'ghost',
  overload: 'trip',
}

/** 稀有度 → 框饰档位（starter/未定义 归 common 档） */
export function rarityTierOf(rarity: string | undefined): RarityTier {
  if (rarity === 'legendary' || rarity === 'epic' || rarity === 'rare') return rarity
  return 'common'
}

/** 关键词 → 角标种类（未知关键词过滤掉，保证 SVG 组装不炸） */
export function keywordMarkOf(keyword: string): KeywordMarkKind | undefined {
  return KEYWORD_MARKS[keyword as Keyword]
}

/**
 * 图形参数派生（纯函数核心）。
 * 同一 cardId 输入恒等输出；不同 cardId 至少 seed 不同、抖动参数大概率不同。
 */
export function deriveFaceArt(def: CardDefinition): FaceArtParams {
  const seed = fnv1a(def.id)
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0)
  // 固定消费顺序：骨架兜底 → 叶片 → 母题 → 抖动三项（换分支也不影响后续取值个数之外的决定性）
  const j1 = rng()
  const j2 = rng()
  const j3 = rng()
  const j4 = rng()
  const j5 = rng()
  const j6 = rng()
  // 形态流（卡面大改版新增，追加在既有消费序之后，j1..j6 语义不变）
  const j7 = rng()
  const j8 = rng()
  const j9 = rng()

  // 1. 形制骨架：art.shape 查表；未知/缺省按 type 兜底（数据驱动扩展零改动）
  const shape = def.art?.shape
  const hit = shape !== undefined ? SHAPE_TABLE[shape] : undefined
  let skeleton: SkeletonKind
  let fanCount = 0
  let dieCount = 1
  if (hit) {
    skeleton = hit.skeleton
    fanCount = hit.fanCount ?? 0
    dieCount = hit.dieCount ?? 1
  } else if (def.type === 'gpu') {
    skeleton = 'gpu_fans'
    fanCount = 1 + Math.floor(j1 * 3) // 1..3 风扇
  } else if (def.type === 'driver') {
    skeleton = j2 < 0.5 ? 'chip_die' : 'disc'
  } else {
    const pool: readonly SkeletonKind[] = ['connector', 'board', 'cooler', 'peripheral']
    skeleton = pool[Math.floor(j1 * pool.length)] ?? 'board'
  }
  const bladeCount = [7, 9, 11][Math.floor(j2 * 3)] ?? 9

  // 2. 派系母题：内置七系直取；未知派系按种子落一系
  const motif = MOTIFS.find((m) => m === def.faction) ?? MOTIFS[Math.floor(j3 * MOTIFS.length)] ?? 'neutral'

  // 3. 母题抖动（同母题不同卡不重样）
  const motifRot = Math.round((j4 * 2 - 1) * 14 * 100) / 100 // -14..14 deg
  const motifScale = Math.round((0.92 + j5 * 0.16) * 1000) / 1000 // 0.92..1.08
  const motifShiftY = Math.round((j6 * 2 - 1) * 8 * 100) / 100 // -8..8 px

  // 4. 稀有度档位 + 关键词角标
  const rarityTier = rarityTierOf(def.rarity)
  const marks = (def.keywords ?? [])
    .map((k) => KEYWORD_MARKS[k])
    .filter((m): m is KeywordMarkKind => m !== undefined)

  // 5. 背景层选型：主种子位选配，至少保一层；子种子独立派生
  const traces = ((seed >>> 3) & 1) === 1
  const grid = ((seed >>> 7) & 1) === 1
  const noise = ((seed >>> 11) & 1) === 1
  const bg: BgLayers = {
    diagonal: true,
    traces: traces || (!grid && !noise), // 三层全关时保底走线
    grid,
    noise,
    traceSeed: fnv1a(`${def.id}:trace`),
    noiseSeed: fnv1a(`${def.id}:noise`),
  }

  return {
    cardId: def.id,
    seed,
    skeleton,
    fanCount,
    bladeCount,
    dieCount,
    motif,
    motifRot,
    motifScale,
    motifShiftY,
    rarityTier,
    marks,
    bg,
    glow: (def.art?.glow ?? '') !== '',
    variant: hit ? (shape ?? '') : '',
    morph: Math.round(j7 * 10000) / 10000,
    morph2: Math.round(j8 * 10000) / 10000,
    morph3: Math.round(j9 * 10000) / 10000,
  }
}
