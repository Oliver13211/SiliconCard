/**
 * 内置派系技能定义（docs/rules.md §8 M1 前四系）—— 引擎基线数据，纯声明式。
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
]
