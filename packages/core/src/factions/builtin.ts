/**
 * 内置派系技能定义（docs/rules.md §8：M1 前四系 + M4 三系）—— 引擎基线数据，纯声明式。
 *
 * 放置位置理由（M1-ENG5 汇报）：initGame 校验「双方 faction 必须已注册技能」，
 * 而 core 自带的测试 / 黄金回放 / fuzz 均使用 nvidia/amd/intel/neutral 派系，
 * 故四系技能作为引擎默认注册数据随 engine/factions.ts 模块加载自动注册；
 * content 包就绪后（factions/*.json）可 registerFactionSkills 同 factionId
 * 后写覆盖，或由宿主另行注册——本文件不构成对 content 的抢占。
 *
 * 唯一的规则逻辑（开光追试试 30% 失败）不在此表达——EffectStep 无条件原语，
 * 按 §5 命名 handler 逃生舱引用 effects/handlers.ts 的 ray_tracing_try。
 */

import { HERO_POWER_COST } from '../constants'
import type { FactionSkillDefinition } from '../engine/factions'

export const BUILTIN_FACTION_SKILLS: readonly FactionSkillDefinition[] = [
  {
    // DLSS：已上机的卡帧数白嫖 +1 攻（§8：buff chosen ownUnits attack +1）
    factionId: 'nvidia',
    skillName: 'DLSS',
    skillId: 'dlss',
    cost: HERO_POWER_COST,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'buff', target: { kind: 'chosen', pool: 'ownUnits' }, attack: 1 }],
    },
  },
  {
    // 开光追试试：指定目标打 1 点伤害，但 70% 概率才开得起来（§8：handler 按 RNG < 0.7
    // 成功，失败发 KEYWORD_TRIGGERED{detail:'光追失败'} 且无事发生）。
    // 目标池经定义级 targetPool 声明（handler 步骤无 target 字段，见 factions.ts）
    factionId: 'amd',
    skillName: '开光追试试',
    skillId: 'ray_tracing_try',
    cost: HERO_POWER_COST,
    targetPool: 'anyCharacter',
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'handler', name: 'ray_tracing_try' }],
    },
  },
  {
    // 驱动更新：抽 1 张牌（§8：draw sourceOwner count 1）
    factionId: 'intel',
    skillName: '驱动更新',
    skillId: 'driver_update',
    cost: HERO_POWER_COST,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'draw', player: 'sourceOwner', count: 1 }],
    },
  },
  {
    // 清灰：指定任意角色打 1 点伤害（§8：damage chosen anyCharacter amount 1）
    factionId: 'neutral',
    skillName: '清灰',
    skillId: 'dust_off',
    cost: HERO_POWER_COST,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'damage', target: { kind: 'chosen', pool: 'anyCharacter' }, amount: 1 }],
    },
  },
  // —— 以下 M4 三系（docs/rules.md §8 M4 行，M4-CNT5 引擎侧前置）——
  // 三条均为既有原语组合（gainArmor / buff random / summon），无新原语、无契约变更。
  {
    // 能效比：自身英雄 gainArmor +2（§8：不发热=散热好）
    factionId: 'apple',
    skillName: '能效比',
    skillId: 'efficiency',
    cost: HERO_POWER_COST,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'gainArmor', player: 'sourceOwner', amount: 2 }],
    },
  },
  {
    // TOPS 营销：随机己方随从 buff +1/+1（§8：AI PC，TOPS 即正义）。
    // random 选择器经引擎种子 RNG 在 ownUnits 池（board 序）恰取一枚；
    // 己方空场时池空不消耗 RNG、无事发生（§5 既定随机语义），无 chosen 步骤
    // 故无目标闸门——与 DLSS（chosen 池空则动作不存在）的边界差异，见 factionsM4.test.ts。
    factionId: 'qualcomm',
    skillName: 'TOPS 营销',
    skillId: 'tops_marketing',
    cost: HERO_POWER_COST,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'buff', target: { kind: 'random', pool: 'ownUnits' }, attack: 1, health: 1 }],
    },
  },
  {
    // 公版方案：召唤 1/1 亮机卡 token（§8：公版小核）。token 定义
    // arm-mali-reference 由 content 批次按 §4 schema 落盘注册（M4-CNT5 约定：
    // cardId=arm-mali-reference / name=公版亮机卡 / cost=100 / 1/1 / gpu / arm /
    // common / 无效果字段），core 不 import content——summon 原语对未注册 cardId
    // 响亮抛错（effects.ts），注册表缺失属宿主装配缺陷；场满静默截断（§5 既定）。
    factionId: 'arm',
    skillName: '公版方案',
    skillId: 'reference_design',
    cost: HERO_POWER_COST,
    effect: {
      trigger: 'onPlay',
      steps: [{ op: 'summon', cardId: 'arm-mali-reference', count: 1 }],
    },
  },
]
