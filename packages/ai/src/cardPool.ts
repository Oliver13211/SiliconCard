/**
 * AI 自对弈内置卡池（cardPool）——自对弈 harness 与测试用的确定性卡组数据。
 *
 * 为什么不直接用 @siliconcard/content：ai 包依赖边界只有 @siliconcard/core
 * （预设允许范围），content JSON 属宿主注入数据——client/server 集成时由宿主
 * registerCardDefinitions 注入正式卡池；本模块提供一组覆盖全部关键词、直伤/
 * AOE/抽牌/随机效果与完整费用曲线（100W–800W）的合成卡池，供自对弈验收
 * （100 局）与启发式单测使用。注册幂等、additive，不污染宿主已注册定义。
 */

import { registerCardDefinitions, type CardDefinition, type DeckSpec } from '@siliconcard/core'

/** 合成卡池（含 summon token `ai-scrap`；token 不进卡组） */
export const AI_CARD_POOL: readonly CardDefinition[] = [
  {
    id: 'ai-zap',
    name: '静电放炮',
    faction: 'neutral',
    type: 'driver',
    cost: 100,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 1 }],
    },
    rarity: 'common',
  },
  {
    id: 'ai-glitch',
    name: '花屏亮机卡',
    faction: 'neutral',
    type: 'gpu',
    cost: 100,
    attack: 1,
    health: 3,
    keywords: ['taunt'],
    rarity: 'starter',
  },
  {
    id: 'ai-spark',
    name: '一键超频',
    faction: 'neutral',
    type: 'gpu',
    cost: 200,
    attack: 2,
    health: 1,
    keywords: ['charge'],
    rarity: 'common',
  },
  {
    id: 'ai-warranty',
    name: '还在质保期内',
    faction: 'neutral',
    type: 'gpu',
    cost: 200,
    attack: 2,
    health: 2,
    keywords: ['divine_shield'],
    rarity: 'common',
  },
  {
    id: 'ai-ghost',
    name: '矿卡残魂',
    faction: 'neutral',
    type: 'gpu',
    cost: 300,
    attack: 3,
    health: 2,
    keywords: ['deathrattle'],
    effect: {
      trigger: 'deathrattle',
      steps: [{ op: 'summon', cardId: 'ai-scrap', count: 1 }],
    },
    rarity: 'rare',
  },
  {
    id: 'ai-scrap',
    name: '拆机件',
    faction: 'neutral',
    type: 'gpu',
    cost: 100,
    attack: 2,
    health: 2,
    rarity: 'starter',
  },
  {
    id: 'ai-workhorse',
    name: '机房劳模',
    faction: 'neutral',
    type: 'gpu',
    cost: 300,
    attack: 3,
    health: 4,
    keywords: ['taunt'],
    rarity: 'common',
  },
  {
    id: 'ai-overclocked',
    name: '暴力超频卡',
    faction: 'neutral',
    type: 'gpu',
    cost: 300,
    attack: 5,
    health: 4,
    keywords: ['overload'],
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'lockMana', player: 'sourceOwner', amount: 100 }],
    },
    rarity: 'rare',
  },
  {
    id: 'ai-lottery',
    name: '玄学抽奖',
    faction: 'neutral',
    type: 'driver',
    cost: 300,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'damage', target: { kind: 'random', pool: 'enemyUnits' }, amount: 3 }],
    },
    rarity: 'rare',
  },
  {
    id: 'ai-driver-update',
    name: '驱动更新',
    faction: 'neutral',
    type: 'driver',
    cost: 300,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'draw', player: 'sourceOwner', count: 2 }],
    },
    rarity: 'common',
  },
  {
    id: 'ai-dualcore',
    name: '双芯亮机卡',
    faction: 'neutral',
    type: 'gpu',
    cost: 400,
    attack: 3,
    health: 3,
    keywords: ['windfury'],
    rarity: 'rare',
  },
  {
    id: 'ai-fireball',
    name: '12VHPWR 熔毁',
    faction: 'neutral',
    type: 'driver',
    cost: 400,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 4 }],
    },
    rarity: 'rare',
  },
  {
    id: 'ai-brick',
    name: '开箱即砖',
    faction: 'neutral',
    type: 'gpu',
    cost: 400,
    attack: 4,
    health: 5,
    rarity: 'common',
  },
  {
    id: 'ai-sweep',
    name: '矿难演习',
    faction: 'neutral',
    type: 'driver',
    cost: 500,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'damage', target: { kind: 'all', pool: 'enemyUnits' }, amount: 2 }],
    },
    rarity: 'rare',
  },
  {
    id: 'ai-titan',
    name: '双芯旗舰',
    faction: 'neutral',
    type: 'gpu',
    cost: 600,
    attack: 7,
    health: 6,
    keywords: ['taunt'],
    rarity: 'epic',
  },
  {
    id: 'ai-beast',
    name: '旗舰信仰',
    faction: 'neutral',
    type: 'gpu',
    cost: 800,
    attack: 9,
    health: 9,
    rarity: 'legendary',
  },
]

/** 幂等注册合成卡池（自对弈 harness / 测试 beforeAll 调用） */
export function registerAiCardPool(): void {
  registerCardDefinitions(AI_CARD_POOL)
}

/** 标准自对弈卡组：15 种 × 2 = 30 张（DECK_SIZE），费用曲线 100W→800W */
export function makeAiDeckSpec(): DeckSpec {
  const deckCardIds = [
    'ai-zap',
    'ai-glitch',
    'ai-spark',
    'ai-warranty',
    'ai-ghost',
    'ai-workhorse',
    'ai-overclocked',
    'ai-lottery',
    'ai-driver-update',
    'ai-dualcore',
    'ai-fireball',
    'ai-brick',
    'ai-sweep',
    'ai-titan',
    'ai-beast',
  ]
  return { cards: deckCardIds.map((cardId) => ({ cardId, count: 2 })) }
}
