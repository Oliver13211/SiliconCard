/**
 * 占位内容数据（M1-UI1..3 降级方案）—— content 包就位前的 UI 层数据。
 *
 * ⚠️ 边界说明（架构铁律 4 的临时豁免，见 M1-UI1..3 汇报）：
 * 卡牌数值/文案的正式唯一来源是 @siliconcard/content 的 JSON（M1-CNT1..4 交付）。
 * 在 content 卡池与 packages/content/decks/ 就位之前，客户端为走通「菜单闭环」
 * 需要一份可注册进引擎的占位卡池——全部 id 以 `demo-` 前缀命名，保证与正式
 * content 卡牌 id（kebab-case 型号名，如 `rtx-5090`）永不冲突；
 * content 就位后本文件仅剩派系展示名/色板等纯展示兜底，数值立即失活。
 */

import type { CardDefinition, FactionId, Keyword } from '@siliconcard/core'

/** 派系展示数据（纯展示兜底；技能定义本体以 core 注册表 getFactionSkill 为准） */
export interface FactionDisplay {
  id: FactionId
  name: string
  color: string
  blurb: string
}

/** 内置四系（core factions/builtin.ts 已自动注册技能，§8 M1 批次；M4 三系就位后再扩） */
export const FACTION_DISPLAY: readonly FactionDisplay[] = [
  { id: 'nvidia', name: 'NVIDIA', color: '#76b900', blurb: 'DLSS：给在场显卡白嫖 +1 攻，帧生成玄学' },
  { id: 'amd', name: 'AMD', color: '#ed1c24', blurb: '开光追试试：1 点直伤，但 30% 概率跳闸无事发生' },
  { id: 'intel', name: 'Intel', color: '#0068b5', blurb: '驱动更新：抽一张牌，先重启试试' },
  { id: 'neutral', name: '中立硬件', color: '#8b949e', blurb: '清灰：对任意角色 1 点直伤，十年老机箱必备' },
]

/** 关键词显示名兜底（正式文案以 content/rule 文案为准，见 rules.md §7） */
export const KEYWORD_LABELS: readonly { id: Keyword; label: string }[] = [
  { id: 'taunt', label: '信仰充值' },
  { id: 'divine_shield', label: '三年质保' },
  { id: 'charge', label: '超频' },
  { id: 'windfury', label: '双芯 GPU' },
  { id: 'deathrattle', label: '蓝屏/传家宝' },
  { id: 'stealth', label: '无输出亮机' },
  { id: 'overload', label: '跳闸' },
]

export function keywordLabel(id: Keyword): string {
  return KEYWORD_LABELS.find((k) => k.id === id)?.label ?? id
}

/**
 * 占位卡池（15 张，全部 `demo-` 前缀）。功耗按真实 TDP 梗对齐（5090=575W），
 * 定义全部满足 core findCardDefinitionIssues 校验（测试锁定）。
 */
export const PLACEHOLDER_CARDS: readonly CardDefinition[] = [
  {
    id: 'demo-rtx-5090',
    name: 'RTX 5090',
    faction: 'nvidia',
    type: 'gpu',
    cost: 575,
    attack: 9,
    health: 7,
    keywords: ['charge'],
    rarity: 'legendary',
    flavor: '609W？不，是信仰的代价。',
  },
  {
    id: 'demo-rtx-4090',
    name: 'RTX 4090',
    faction: 'nvidia',
    type: 'gpu',
    cost: 450,
    attack: 8,
    health: 8,
    rarity: 'epic',
    flavor: '矿潮老兵，传家预定。',
  },
  {
    id: 'demo-titan-z',
    name: 'Titan Z 双芯',
    faction: 'nvidia',
    type: 'gpu',
    cost: 700,
    attack: 7,
    health: 9,
    keywords: ['windfury'],
    rarity: 'legendary',
    flavor: '一张卡，两次快乐，功耗也双倍。',
  },
  {
    id: 'demo-gtx-1060',
    name: 'GTX 1060',
    faction: 'nvidia',
    type: 'gpu',
    cost: 120,
    attack: 3,
    health: 4,
    rarity: 'common',
    flavor: '六年前的甜点卡，现在还能亮机。',
  },
  {
    id: 'demo-gt-1030',
    name: 'GT 1030 亮机卡',
    faction: 'nvidia',
    type: 'gpu',
    cost: 30,
    attack: 1,
    health: 2,
    keywords: ['stealth'],
    rarity: 'starter',
    flavor: '无输出亮机：主打一个听不见。',
  },
  {
    id: 'demo-rx-6900xt',
    name: 'Radeon RX 6900 XT',
    faction: 'amd',
    type: 'gpu',
    cost: 300,
    attack: 6,
    health: 6,
    tags: ['miner'],
    rarity: 'rare',
    flavor: '2017 年上岗挖矿，至今没歇过。',
  },
  {
    id: 'demo-rx-580',
    name: 'Radeon RX 580',
    faction: 'amd',
    type: 'gpu',
    cost: 185,
    attack: 4,
    health: 5,
    tags: ['miner'],
    keywords: ['deathrattle'],
    rarity: 'common',
    flavor: '传家宝：我死了，遗产留给下一位。',
  },
  {
    id: 'demo-arc-b580',
    name: 'Arc B580',
    faction: 'intel',
    type: 'gpu',
    cost: 250,
    attack: 5,
    health: 6,
    keywords: ['divine_shield'],
    rarity: 'rare',
    flavor: '三年质保，烧了就换（驱动除外）。',
  },
  {
    id: 'demo-arc-a380',
    name: 'Arc A380',
    faction: 'intel',
    type: 'gpu',
    cost: 140,
    attack: 3,
    health: 3,
    rarity: 'common',
    flavor: '驱动更新后性能提升 200%（个体差异可能较大）。',
  },
  {
    id: 'demo-driver-12vhpwr',
    name: '12VHPWR 熔毁',
    faction: 'nvidia',
    type: 'driver',
    cost: 100,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 3 }],
    },
    rarity: 'rare',
    flavor: '接口：我先熔为敬。',
  },
  {
    id: 'demo-driver-whql',
    name: 'WHQL 认证驱动',
    faction: 'intel',
    type: 'driver',
    cost: 150,
    effect: { trigger: 'onPlay', steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }] },
    rarity: 'common',
    flavor: '驱动更新：先重启试试。',
  },
  {
    id: 'demo-driver-mineslide',
    name: '矿难',
    faction: 'amd',
    type: 'driver',
    cost: 200,
    effect: {
      trigger: 'onPlay',
      steps: [
        { op: 'buff', target: { kind: 'all', pool: 'allUnits', tag: 'miner' }, attack: -2, health: -2 },
      ],
    },
    rarity: 'epic',
    flavor: '币价一崩，全线跳车。',
  },
  {
    id: 'demo-driver-rollback',
    name: '驱动回滚',
    faction: 'intel',
    type: 'driver',
    cost: 150,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'removeKeyword', target: { kind: 'chosen', pool: 'allUnits' }, keyword: 'taunt' }],
    },
    rarity: 'rare',
    flavor: '新驱动不如旧驱动稳，懂的都懂。',
  },
  {
    id: 'demo-acc-tower-cooler',
    name: '六热管风冷',
    faction: 'neutral',
    type: 'accessory',
    cost: 75,
    effect: { trigger: 'aura', aura: { stat: 'attack', delta: 1, scope: 'ownUnits' } },
    rarity: 'common',
    flavor: '积灰清完，风扇又是新的一样。',
  },
  {
    id: 'demo-acc-psu',
    name: '80PLUS 白牌电源',
    faction: 'neutral',
    type: 'accessory',
    cost: 100,
    keywords: ['taunt'],
    rarity: 'common',
    flavor: '白牌电源：跳闸的时候陪你一起。',
  },
]

/** 卡组里没有 demo-cards 时给结算/日志用的派系名兜底 */
export function factionDisplayName(faction: FactionId): string {
  return FACTION_DISPLAY.find((f) => f.id === faction)?.name ?? faction
}

/** 生成派系技能按钮文案（技能名来自 core 注册表，M4 派系未注册时优雅降级） */
export function factionBlurb(faction: FactionId): string {
  return FACTION_DISPLAY.find((f) => f.id === faction)?.blurb ?? ''
}
