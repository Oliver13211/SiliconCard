/**
 * 教程关卡数据（P2-EDU1）—— 五关 + 关3 七节的全部教学内容。
 *
 * 数据驱动铁律（任务书）：卡组 id / seed / 脚本行为档案 / 气泡文案 / 白名单 /
 * 过关判定全部集中在本文件，改动教学内容不碰 controller / bridge / UI。
 * 判定函数体在 objectives.ts（纯事件流），这里只引用。
 *
 * seed 选取：固定 seed + 固定卡组 → 引擎确定性保证整关可复现（flow.test.ts
 * 对每个 seed 跑一遍引导路径兜底验证）。教学卡组关键词素材高密度投放，
 * 脚本对手按规则迟到补位——对 P2 起手扰动（如 P2-ENG1 电费抵扣券）防御。
 */

import type { GameEvent, PlayerView } from '@siliconcard/core'
import {
  level1Objective,
  level2Objective,
  level4Objective,
  playsInCurrentPlayerTurn,
  playerHeroPowerUses,
  sectionChargeObjective,
  sectionDeathrattleObjective,
  sectionOverloadObjective,
  sectionShieldObjective,
  sectionStealthObjective,
  sectionTauntObjective,
  sectionWindfuryObjective,
} from './objectives'
import type { TutorialLevel, TutorialSection } from './types'

const SCRIPT_DECK = 'tutorial-script-dummy'

/** 手牌里是否已有指定卡且付得起功耗（视图投影，白名单谓词用） */
function affordable(view: PlayerView, cardId: string): boolean {
  const card = view.you.hand.find((entry) => entry.cardId === cardId)
  return card !== undefined && card.cost <= view.you.mana
}

function playedAlready(events: readonly GameEvent[], cardId: string): boolean {
  return events.some((event) => event.type === 'CARD_PLAYED' && event.playerId === 'P1' && event.cardId === cardId)
}

/** 组合谓词：素材到手且付得起 → 结束回合先拦下（教学聚焦），否则放行防死局 */
function holdEndTurnUntilAffordable(cardId: string) {
  // 少参函数可赋给 (view, events) 谓词类型：本谓词只看手牌功耗
  return (view: PlayerView) => !affordable(view, cardId)
}

/** 组合谓词：素材已打出前不许收工（付不起电时放行，防死局） */
function holdEndTurnUntilPlayed(cardId: string) {
  return (view: PlayerView, events: readonly GameEvent[]) => !affordable(view, cardId) || playedAlready(events, cardId)
}

// —— 固定 seed（flow.test.ts 对每个 seed 跑引导路径兜底验证；
// 引导流在下列 seed 上实测可完成，含 P2 起手扰动防御性补位）——
export const TUTORIAL_SEEDS = {
  level1: 20261001,
  level2: 20261000,
  s1: 20261000,
  s2: 20261000,
  s3: 20261000,
  s4: 20261000,
  s5: 20261000,
  s6: 20261000,
  s7: 20261000,
  level4: 20261000,
} as const

// —— 关3：关键词七连 ——

const sectionTaunt: TutorialSection = {
  id: 's1',
  keyword: 'taunt',
  keywordLabel: '信仰充值',
  name: '信仰充值（嘲讽）',
  brief: '嘲讽关键词：敌方必须先砍你的嘲讽单位，绕不过去。素材：i9-9900K（100W 2/6）——14nm 老将焊死在主板上，谁也别想绕开它。',
  objectiveLabel: '让对面的刀落在 9900K 身上',
  seed: TUTORIAL_SEEDS.s1,
  playerDeckId: 'tutorial-l3-s1-taunt',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'aggressive', cardId: 'intel-arc-a380' },
  steps: [
    {
      id: 'play',
      bubble: {
        title: '上信仰充值卡',
        body: '第 1 回合把「i9-9900K」插上去（100W，2/6）。带信仰充值（taunt）的单位站上场后，对面的刀必须先落在它身上。',
      },
      gate: {
        allowPlayCardIds: ['intel-i9-9900k'],
        allowEndTurn: holdEndTurnUntilAffordable('intel-i9-9900k'),
        blockCopy: '这一节先专心把「i9-9900K」上机',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'intel-i9-9900k',
    },
    {
      id: 'watch',
      bubble: {
        title: '看住全场',
        body: '结束回合等对面动手。注意战报：它的攻击会被迫落在 9900K 上——这就是嘲讽的意义，你的 CPU 不再挨打。',
      },
    },
  ],
  objective: sectionTauntObjective,
  summary:
    '看到了吗？对面那刀没得选。嘲讽 = 替全队挡刀。顺便：更贵的垃圾桶 Mac Pro 2013 也是信仰充值（2/9，450W），但它贵到本教程都舍不得让你买。',
}

const sectionShield: TutorialSection = {
  id: 's2',
  keyword: 'divine_shield',
  keywordLabel: '三年质保',
  name: '三年质保（圣盾）',
  brief: '三年质保：抵消下一次任意金额的伤害，挡完即碎（重复获得不叠层）。素材：AppleCare+（300W 配件，战吼给一台己方显卡上质保）。',
  objectiveLabel: '用三年质保真实挡下一刀',
  seed: TUTORIAL_SEEDS.s2,
  playerDeckId: 'tutorial-l3-s2-shield',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'shieldDemo', cardId: 'intel-arc-a380' },
  steps: [
    {
      id: 'board',
      bubble: {
        title: '先上一台裸机',
        body: '第 1 回合把「RX 550」插上（50W，2/2）——它是待会儿要被保护的对象。',
      },
      gate: {
        allowPlayCardIds: ['amd-rx-550', 'apple-applecare-plus'],
        allowEndTurn: holdEndTurnUntilAffordable('amd-rx-550'),
        blockCopy: '这一节先专心上「RX 550」站场',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'amd-rx-550',
    },
    {
      id: 'warranty',
      bubble: {
        title: '上 AppleCare+',
        body: '第 3 回合余电 300W 时打「AppleCare+」——战吼会请你指定一台己方显卡，选你的 RX 550，给它上三年质保。',
      },
      gate: {
        allowPlayCardIds: ['amd-rx-550', 'apple-applecare-plus'],
        allowEndTurn: holdEndTurnUntilPlayed('apple-applecare-plus'),
        blockCopy: '先别收工——AppleCare+ 已经付得起电了，上质保',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'apple-applecare-plus',
    },
    {
      id: 'absorb',
      bubble: {
        title: '挡一刀',
        body: '结束回合。对面会照着你的质保单位砍——战报会打出「三年质保险抵挡」：伤害归零，护盾碎裂。',
      },
    },
  ],
  objective: sectionShieldObjective,
  summary:
    '质保挡下了这一刀。规矩记牢：只挡"下一次伤害"，金额不限、挡完就没了；且不挡"整卡销毁"类效果——人为损坏除外，AppleCare 条款诚不欺我。',
}

const sectionCharge: TutorialSection = {
  id: 's3',
  keyword: 'charge',
  keywordLabel: '超频',
  name: '超频（冲锋）',
  brief: '超频：入场当回合就能攻击——别的卡要"点亮"一回合，超频卡出厂即战。素材：天玑 9300（150W 4/4，全大核不墨迹）。',
  objectiveLabel: '天玑 9300 入场当回合完成攻击',
  seed: TUTORIAL_SEEDS.s3,
  playerDeckId: 'tutorial-l3-s3-charge',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'spawner', cardId: 'intel-arc-a380' },
  steps: [
    {
      id: 'play',
      bubble: {
        title: '上超频卡',
        body: '第 3 回合余电 200W 时把「天玑 9300」插上（150W）。普通显卡刚插上要等一回合"点亮"，超频卡不用——先攒电，别急着收工。',
      },
      gate: {
        allowPlayCardIds: ['arm-dimensity-9300'],
        allowEndTurn: holdEndTurnUntilAffordable('arm-dimensity-9300'),
        blockCopy: '这一节先专心攒电上「天玑 9300」',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'arm-dimensity-9300',
    },
    {
      id: 'strike',
      bubble: {
        title: '上场即战',
        body: '现在就点它攻击！对面靶机是台 A380（2/3），你 4 攻一刀带走。超频的英文叫 charge——冲锋。',
      },
      gate: {
        allowAttackCardIds: ['arm-dimensity-9300'],
        blockCopy: '这一节用「天玑 9300」来开刀',
      },
    },
  ],
  objective: sectionChargeObjective,
  summary:
    '上场即战！对比记忆：没超频的卡入场当回合是"召唤失调"，攻击按钮是灰的——整机圈管这叫"新卡烤机"，超频卡出厂就烤好了。',
}

const sectionWindfury: TutorialSection = {
  id: 's4',
  keyword: 'windfury',
  keywordLabel: '双芯 GPU',
  name: '双芯 GPU（风怒）',
  brief: '双芯 GPU：每回合攻击两次。素材：M1 Ultra（370W 5/7）——两颗 M1 Max 官方胶水粘合，风怒那两刀是胶水在替你发力。',
  objectiveLabel: 'M1 Ultra 同一回合砍出两刀',
  seed: TUTORIAL_SEEDS.s4,
  playerDeckId: 'tutorial-l3-s4-windfury',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'spawner', cardId: 'intel-arc-a380' },
  steps: [
    {
      id: 'save',
      bubble: {
        title: '攒钱上大件',
        body: 'M1 Ultra 要 370W：供电 100 → 200 → 300 → 400，第 4 回合上机。期间低费卡随便热身（攻击先别急，等双芯到场）。',
      },
      gate: {
        allowPlayCardIds: 'all',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'apple-m1-ultra',
    },
    {
      id: 'double',
      bubble: {
        title: '一回合两刀',
        body: '点 M1 Ultra 连续攻击两次：先砍靶机（A380，2/3），再砍 CPU 也行。两刀出完才算真正"UltraFusion 融合"。',
      },
      gate: {
        allowAttackCardIds: ['apple-m1-ultra'],
        // 双芯还有攻击余量时不许收工（两刀打满才放行结束回合）
        allowEndTurn: (view) => {
          const ultra = view.board.find((unit) => unit.ownerId === view.viewer && unit.cardId === 'apple-m1-ultra')
          return !(ultra && ultra.attacksRemaining > 0)
        },
        blockCopy: '双芯还有余力——把两刀都砍完再收工',
      },
    },
  ],
  objective: sectionWindfuryObjective,
  summary: '双芯威力见到：一回合两刀。全游戏攻击两次的关键词只有它和 Exynos 8895——都是"胶水粘出来的暴力"。',
}

const sectionDeathrattle: TutorialSection = {
  id: 's5',
  keyword: 'deathrattle',
  keywordLabel: '蓝屏/传家宝',
  name: '蓝屏/传家宝（亡语）',
  brief: '蓝屏/传家宝：死亡时触发遗言，一次死亡只触发一次。素材：Helio G99（100W 2/2，亡语召唤 1/1 公版亮机卡）——百元神 U，死也要留遗产。',
  objectiveLabel: '让 G99 战死并留下亡语遗产',
  seed: TUTORIAL_SEEDS.s5,
  playerDeckId: 'tutorial-l3-s5-deathrattle',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'spawner', cardId: 'amd-rx-550' },
  steps: [
    {
      id: 'play',
      bubble: {
        title: '上传家宝',
        body: '第 1 回合把「Helio G99」插上（100W，2/2）。它带着"蓝屏/传家宝"关键词——死了也要干活。',
      },
      gate: {
        allowPlayCardIds: ['arm-helio-g99'],
        allowEndTurn: holdEndTurnUntilAffordable('arm-helio-g99'),
        blockCopy: '这一节先专心把「Helio G99」上机',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'arm-helio-g99',
    },
    {
      id: 'trade',
      bubble: {
        title: '送它上路',
        body: '第 3 回合用它攻击对面靶机（RX 550，2/2）：同归于尽！盯紧战报——G99 蓝屏退场后，亡语立刻召唤一台 1/1 公版亮机卡顶班。',
      },
      gate: {
        allowAttackCardIds: ['arm-helio-g99'],
        blockCopy: '这一节用「Helio G99」亲自送葬',
      },
    },
  ],
  objective: sectionDeathrattleObjective,
  summary: '传家宝名不虚传：人没了，遗产还在。亡语在它"被销毁"时同样触发；一次死亡只触发一次——街道办刷机摊认证。',
}

const sectionStealth: TutorialSection = {
  id: 's6',
  keyword: 'stealth',
  keywordLabel: '无输出亮机',
  name: '无输出亮机（潜行）',
  brief: '无输出亮机：没攻击之前，对面点不到它（攻击和技能都选不中）。素材：MacBook Air M2（100W 2/3）——跑分安静得像没开机。',
  objectiveLabel: '亲眼看它躲过一刀，再主动现身',
  seed: TUTORIAL_SEEDS.s6,
  playerDeckId: 'tutorial-l3-s6-stealth',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'aggressive', cardId: 'intel-arc-a380' },
  steps: [
    {
      id: 'play',
      bubble: {
        title: '上无输出卡',
        body: '第 1 回合插上「MacBook Air M2」（100W）。它带着"无输出亮机"入场——在对面眼里，你场上像啥也没插。',
      },
      gate: {
        allowPlayCardIds: ['apple-macbook-air-m2'],
        allowEndTurn: holdEndTurnUntilAffordable('apple-macbook-air-m2'),
        blockCopy: '这一节先专心把「MacBook Air M2」上机',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'apple-macbook-air-m2',
    },
    {
      id: 'hide',
      bubble: {
        title: '静观其变',
        body: '结束回合。对面那台 A380 会发现点不到你的 Air（无输出亮机中）——只能干瞪眼砍你的 CPU。',
      },
      gate: {
        // 空数组 = 本步禁攻：潜行的"躲过一刀"必须先上演，现身要等下一步
        allowAttackCardIds: [],
        blockCopy: '先别动手——让对面先体验一下点不到你的绝望',
      },
      advanceOn: (event) => event.type === 'DAMAGE_DEALT' && event.target.kind === 'hero' && event.target.playerId === 'P1',
    },
    {
      id: 'reveal',
      bubble: {
        title: '主动现身',
        body: '现在用 Air 攻击一次：无输出亮机立即解除。潜行是保护不是无敌——动了就现原形。',
      },
      gate: {
        allowAttackCardIds: ['apple-macbook-air-m2'],
        blockCopy: '这一节攻击留给 MacBook Air——现身要亲自来',
      },
    },
  ],
  objective: sectionStealthObjective,
  summary:
    '潜行机制齐活：现身前不可被指定，一动手立刻显形。顺便，MacBook Air 核显顺手把隔壁 GT 1030 做了这事——它从来不上热搜。',
}

const sectionOverload: TutorialSection = {
  id: 's7',
  keyword: 'overload',
  keywordLabel: '跳闸',
  name: '跳闸（过载）',
  brief: '跳闸：这张卡下回合会锁你 100W 供电——力量是有代价的。素材：Exynos 8895（150W 4/2，双芯 GPU + 跳闸）：核心堆到 20 个，温度也 20 份。',
  objectiveLabel: '亲眼看下回合开局跳闸（供电被锁 100W）',
  seed: TUTORIAL_SEEDS.s7,
  playerDeckId: 'tutorial-l3-s7-overload',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'passer' },
  steps: [
    {
      id: 'play',
      bubble: {
        title: '上跳闸卡',
        body: '第 3 回合（余电 200W）插上「Exynos 8895」（150W）。它一上机，下回合就预约了一次跳闸。',
      },
      gate: {
        allowPlayCardIds: ['arm-exynos-8895'],
        allowEndTurn: holdEndTurnUntilAffordable('arm-exynos-8895'),
        blockCopy: '这一节先专心攒电上「Exynos 8895」',
      },
      advanceOn: (event) => event.type === 'CARD_PLAYED' && event.cardId === 'arm-exynos-8895',
    },
    {
      id: 'burn',
      bubble: {
        title: '收工等跳闸',
        body: '结束回合。下回合开局看供电条：上限 300W 只到手 200W——BURN OUT，跳闸冷静一下。',
      },
      advanceOn: (event) => event.type === 'TURN_START' && event.playerId === 'P1',
    },
  ],
  objective: sectionOverloadObjective,
  summary: '跳闸体验完毕：过载锁电只锁"下回合开局"，多张可叠加。顺便它还是双芯 GPU——一回合两刀，就是电费和体温都感人。',
}

// —— 关3 主体 ——

const level3: TutorialLevel = {
  id: 3,
  name: '关键词七连',
  subtitle: '七个关键词逐节拆解，每节"必用该关键词"才过关',
  brief: '硅牌的关键词全部梗化命名，机制对应炉石老规矩。这一关分七节，每节一场迷你对局：先讲机制，再让你亲手用一次。全部七节打完才算毕业。',
  objectiveLabel: '七节全部完成',
  seed: TUTORIAL_SEEDS.s1,
  playerDeckId: 'tutorial-l3-s1-taunt',
  scriptDeckId: SCRIPT_DECK,
  p2Profile: { kind: 'passer' },
  objective: () => null, // 关3 过关以"七节全部完成"为准（进度存取判定，不用事件流）
  summary: '七连全通！从此看卡面右上角的关键词不再是天书。',
  sections: [
    sectionTaunt,
    sectionShield,
    sectionCharge,
    sectionWindfury,
    sectionDeathrattle,
    sectionStealth,
    sectionOverload,
  ],
}

// —— 五关 ——

export const TUTORIAL_LEVELS: readonly TutorialLevel[] = [
  {
    id: 1,
    name: '通电',
    subtitle: '供电 / 回合 / 结束回合',
    brief:
      '欢迎来到硅牌！你是一颗 CPU，对面也是。所有卡牌都要吃电才能跑：功耗（W）就是法力值，每个自己的回合 +100W，打牌扣电，电不够就点不动。这一关学会「出牌」和「结束回合」——目标：一个回合内连打 3 张卡。',
    objectiveLabel: '一个回合内打出 3 张卡',
    objectiveProgress: (events) => ({ done: Math.min(playsInCurrentPlayerTurn(events), 3), total: 3 }),
    seed: TUTORIAL_SEEDS.level1,
    playerDeckId: 'tutorial-l1-power',
    scriptDeckId: SCRIPT_DECK,
    p2Profile: { kind: 'passer' },
    steps: [
      {
        id: 'first-play',
        bubble: {
          title: '通电 · 打出第一张卡',
          body: '点一张亮绿灯的手牌把它插上机——功耗够就打得出去。牌角上的 W 是功耗，你的余电在左下角电源条上。',
        },
        gate: {
          // 起手没有付得起的卡时放行结束回合（防死局；教学卡组低功耗密度下基本不触发）
          allowEndTurn: (view) => !view.you.hand.some((card) => card.cost <= view.you.mana),
          blockCopy: '先打出一张卡，让机器跑起来',
        },
        advanceOn: (event) => event.type === 'CARD_PLAYED' && event.playerId === 'P1',
      },
      {
        id: 'end-turn',
        bubble: {
          title: '结束回合',
          body: '出完牌点「结束回合」就轮到对面。别心疼：回合结束不扣电，下回合供电还涨。',
        },
        advanceOn: (event) => event.type === 'TURN_END' && event.playerId === 'P1',
      },
      {
        id: 'curve',
        bubble: {
          title: '供电曲线',
          body: '每过你一个回合，供电上限 +100W（100 → 200 → 300…）。余电够多时一个回合连打 3 张卡就算过关——低功耗小卡连拍是最好的开机仪式。',
        },
      },
    ],
    objective: level1Objective,
    summary:
      '通电成功！出牌、结束回合、供电曲线你都见了。记住：卡牌功耗取材真实 TDP——5090 要 575W 不是玄学，是它真的吃这么多电。',
  },
  {
    id: 2,
    name: '上机',
    subtitle: '出牌 / 攻击 / 派系技能',
    brief:
      '上机实战三件套：出牌站场、派系技能、宣告攻击。对面会放一台靶机显卡，你的任务是把它拆了——技能削一刀，显卡补一刀，拆掉就过关。',
    objectiveLabel: '摧毁敌方一台显卡',
    seed: TUTORIAL_SEEDS.level2,
    playerDeckId: 'tutorial-l2-boot',
    scriptDeckId: SCRIPT_DECK,
    p2Profile: { kind: 'spawner', cardId: 'intel-arc-a380' },
    steps: [
      {
        id: 'play',
        bubble: {
          title: '出牌站场',
          body: '第 1 回合上「RX 550」（50W，2/2，物美价廉）。显卡上场当回合不能攻击（召唤失调），先站住。',
        },
        gate: {
          allowPlayCardIds: ['amd-rx-550'],
          allowEndTurn: holdEndTurnUntilAffordable('amd-rx-550'),
          blockCopy: '先专心上「RX 550」站场',
        },
        advanceOn: (event) => event.type === 'CARD_PLAYED' && event.playerId === 'P1',
      },
      {
        id: 'power',
        bubble: {
          title: '信仰充值 · 派系技能',
          body: '左下角技能按钮「清灰」（200W）：给任意目标来 1 点伤害，每回合一次。第 3 回合余电 200W 正好交——白嫖的伤害不要白不要。',
        },
        gate: {
          allowEndTurn: (view) => view.you.heroPowerUsed || view.you.mana < 200,
          blockCopy: '技能已经付得起电了——信仰充值一下再收工',
        },
        advanceOn: (event) => event.type === 'HERO_POWER_USED' && event.playerId === 'P1',
      },
      {
        id: 'attack',
        bubble: {
          title: '宣告攻击',
          body: '点你的显卡再点目标确认（防守方会反击，炉石老规矩）。技能削过一刀后，把对面靶机显卡送走就过关。',
        },
        gate: {
          allowAttackCardIds: ['amd-rx-550'],
          blockCopy: '这一刀留给「RX 550」——靶机交给它',
        },
        advanceOn: (event) => event.type === 'ATTACK_DECLARED' && event.attackerId !== '',
      },
    ],
    objective: level2Objective,
    summary: '拆机成功！出牌 → 技能 → 攻击三件套齐活。注：本教程把派系技能叫"信仰充值"——嘲讽关键词也叫这个名，圈内梗就这样，双关二合一。',
  },
  level3,
  {
    id: 4,
    name: '派系对决',
    subtitle: '自选派系打一整局',
    brief:
      '毕业战：自选派系，和脚本陪练打一整局真对局（它不耍花招，跟你硬碰）。目标：整局里交出 3 次派系技能——200W 一发、每回合一次，抽牌/伤害/护甲/召唤都是白嫖收益，技能交得勤是高手的基本素养。',
    objectiveLabel: '善用 3 次派系技能',
    objectiveProgress: (events) => ({ done: Math.min(playerHeroPowerUses(events), 3), total: 3 }),
    seed: TUTORIAL_SEEDS.level4,
    playerDeckId: 'tutorial-l4-faction',
    scriptDeckId: 'tutorial-l4-faction',
    p2Profile: { kind: 'sparring' },
    chooseFaction: true,
    objective: level4Objective,
    summary: '毕业战达标！技能交满三次——现在你知道为什么老玩家回合结束前总会看一眼技能按钮了。',
  },
  {
    id: 5,
    name: '自由实战',
    subtitle: '进真实对局',
    brief:
      '结业课：教程到此为止。真实对局在主菜单「开始对战」——选派系、选卡组、点开始。前几回合你可能会想念气泡，但你已经不需要它了：供电看条、可交互看亮灯、非法操作有解释。去开一局吧。',
    objectiveLabel: '进入真实对局的设置界面',
    seed: 0,
    playerDeckId: 'tutorial-l1-power',
    scriptDeckId: SCRIPT_DECK,
    p2Profile: { kind: 'passer' },
    graduation: true,
    objective: () => null, // 过关 = 进入真实 SetupScreen（控制器导航时直记）
    summary: '结业快乐！欢迎掉进显卡圈的坑——祝你的 5090 永远不烧 12V-2×6。',
  },
]

export function tutorialLevelById(id: number): TutorialLevel | undefined {
  return TUTORIAL_LEVELS.find((level) => level.id === id)
}
