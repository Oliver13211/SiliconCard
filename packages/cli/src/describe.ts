/**
 * 语义描述层（M3-AGT1）——把引擎的结构化数据翻译成外部 agent 可直接读懂的中文摘要。
 *
 * 输入只取两类公开信息：
 * - PlayerView（viewFor 裁剪视图，禁读完整 state 的铁律不破）；
 * - 卡牌定义注册表 / 派系技能注册表（content JSON，本就是公开数据）。
 *
 * 用途：legalActions[].summary、cardGlossary[].effectText、log[]（事件流人话版）。
 */

import {
  getCardDefinition,
  getFactionSkill,
  type Action,
  type EffectSpec,
  type EffectStep,
  type GameEvent,
  type Keyword,
  type PlayerId,
  type PlayerView,
  type TargetPool,
  type TargetRef,
} from '@siliconcard/core'

// —— 关键词：稳定 id → 显示名 + 一句话精确规则（docs/rules.md §7） ——

export const KEYWORD_GLOSSARY: Readonly<Record<Keyword, string>> = {
  taunt: '信仰充值（taunt）：敌方攻击必须先打它',
  divine_shield: '三年质保（divine_shield）：抵消下一次受到的任何伤害，触发即消失',
  charge: '超频（charge）：入场当回合即可攻击',
  windfury: '双芯 GPU（windfury）：每回合可攻击 2 次',
  deathrattle: '蓝屏/传家宝（deathrattle）：死亡时触发亡语效果',
  stealth: '无输出亮机（stealth）：它攻击前不可被敌方指定为任何目标',
  overload: '跳闸（overload）：打出后下回合被锁定部分功耗',
}

const KEYWORD_NAMES: Readonly<Record<Keyword, string>> = {
  taunt: '信仰充值',
  divine_shield: '三年质保',
  charge: '超频',
  windfury: '双芯 GPU',
  deathrattle: '蓝屏/传家宝',
  stealth: '无输出亮机',
  overload: '跳闸',
}

// —— 目标池人话 ——

const POOL_TEXT: Readonly<Record<TargetPool, string>> = {
  ownHero: '己方 CPU',
  enemyHero: '敌方 CPU',
  ownUnits: '己方单位',
  enemyUnits: '敌方单位',
  allUnits: '全场单位',
  anyCharacter: '任意单位或 CPU',
  self: '自身',
  sourceOwner: '效果拥有者',
  opposingPlayer: '对手',
}

function poolPhrase(pool: TargetPool, selectorKind: 'chosen' | 'random' | 'all'): string {
  const base = POOL_TEXT[pool] ?? pool
  if (selectorKind === 'chosen') return `指定的${base}`
  if (selectorKind === 'random') return `随机的${base}`
  return `全部${base}`
}

// —— 效果规格 → 一句话 ——

const TRIGGER_LABEL: Readonly<Record<EffectSpec['trigger'], string>> = {
  battlecry: '战吼',
  deathrattle: '亡语',
  onPlay: '出牌时',
  aura: '光环',
  turnStart: '回合开始时',
  turnEnd: '回合结束时',
  onAttack: '攻击时',
  onDamaged: '受伤后',
}

/** 命名 handler 逃生舱的人话对照（core/src/effects/handlers.ts 注册处同步维护） */
const HANDLER_TEXT: Readonly<Record<string, string>> = {
  ray_tracing_try: '70% 概率对指定目标造成 1 点伤害（开光追，可能光追失败无事发生）',
}

function stepText(step: EffectStep): string {
  switch (step.op) {
    case 'damage':
      return `对${poolPhrase(step.target.pool, step.target.kind)}造成 ${step.amount} 点伤害`
    case 'heal':
      return `为${poolPhrase(step.target.pool, step.target.kind)}恢复 ${step.amount} 点体质`
    case 'buff': {
      const parts: string[] = []
      if (step.attack) parts.push(`攻 +${step.attack}`)
      if (step.health) parts.push(`血 +${step.health}`)
      return `为${poolPhrase(step.target.pool, step.target.kind)}施加增益（${parts.join(' ') || '无'}）`
    }
    case 'grantKeyword':
      return `让${poolPhrase(step.target.pool, step.target.kind)}获得「${KEYWORD_NAMES[step.keyword] ?? step.keyword}」`
    case 'removeKeyword':
      return `移除${poolPhrase(step.target.pool, step.target.kind)}的「${KEYWORD_NAMES[step.keyword] ?? step.keyword}」`
    case 'draw':
      return `${step.player === 'sourceOwner' ? '己方' : '对手'}抽 ${step.count} 张牌`
    case 'summon':
      return `召唤 ${step.count} 个「${summonName(step.cardId)}」`
    case 'destroy':
      return `消灭${poolPhrase(step.target.pool, step.target.kind)}`
    case 'revive':
      return `从己方墓地复活一张显卡回场上`
    case 'gainArmor':
      return `${step.player === 'sourceOwner' ? '己方' : '对手'}获得 ${step.amount} 点护甲`
    case 'lockMana':
      return `${step.player === 'sourceOwner' ? '己方' : '对手'}下回合锁定 ${step.amount}W 功耗`
    case 'handler':
      return HANDLER_TEXT[step.name] ?? `特殊效果（handler: ${step.name}）`
  }
}

function summonName(cardId: string): string {
  return getCardDefinition(cardId)?.name ?? cardId
}

/** 效果规格 → 一句话文本（无 effect 返回 undefined） */
export function effectText(effect: EffectSpec | undefined): string | undefined {
  if (!effect) return undefined
  const label = TRIGGER_LABEL[effect.trigger] ?? effect.trigger
  const pieces: string[] = []
  for (const step of effect.steps ?? []) pieces.push(stepText(step))
  if (effect.handler) pieces.push(HANDLER_TEXT[effect.handler] ?? `特殊效果（handler: ${effect.handler}）`)
  if (effect.aura) {
    const scope = effect.aura.scope === 'ownUnits' ? '己方单位' : effect.aura.scope === 'enemyUnits' ? '敌方单位' : '全场单位'
    const stat = effect.aura.stat === 'attack' ? '攻击' : effect.aura.stat === 'health' ? '血量' : '功耗'
    pieces.push(`光环：${scope}${stat} ${effect.aura.delta >= 0 ? '+' : ''}${effect.aura.delta}（在场期间持续）`)
  }
  if (pieces.length === 0) return undefined
  return `${label}：${pieces.join('；')}`
}

// —— 卡牌图鉴条目（cardGlossary） ——

export interface GlossaryEntry {
  name: string
  faction: string
  type: 'gpu' | 'driver' | 'accessory'
  cost: number
  attack?: number
  health?: number
  keywords?: { id: Keyword; text: string }[]
  effectText?: string
  flavor?: string
}

/** 卡牌定义 → 图鉴条目（未注册返回 undefined） */
export function glossaryEntry(cardId: string): GlossaryEntry | undefined {
  const def = getCardDefinition(cardId)
  if (!def) return undefined
  return {
    name: def.name,
    faction: def.faction,
    type: def.type,
    cost: def.cost,
    ...(def.type === 'gpu' && def.attack !== undefined ? { attack: def.attack } : {}),
    ...(def.type === 'gpu' && def.health !== undefined ? { health: def.health } : {}),
    ...(def.keywords && def.keywords.length > 0
      ? { keywords: def.keywords.map((k) => ({ id: k, text: KEYWORD_GLOSSARY[k] ?? k })) }
      : {}),
    ...(effectText(def.effect) ? { effectText: effectText(def.effect) } : {}),
    ...(def.flavor ? { flavor: def.flavor } : {}),
  }
}

/** 派系技能 → 图鉴条目（未注册返回 undefined） */
export function heroPowerEntry(faction: string): { skillId: string; name: string; cost: number; effectText?: string } | undefined {
  const skill = getFactionSkill(faction)
  if (!skill) return undefined
  return {
    skillId: skill.skillId,
    name: skill.skillName,
    cost: skill.cost,
    ...(effectText(skill.effect) ? { effectText: effectText(skill.effect) } : {}),
  }
}

// —— 视图内目标的人话 ——

function targetText(view: PlayerView, target: TargetRef | null | undefined): string {
  if (!target) return ''
  if (target.kind === 'hero') {
    return target.playerId === view.viewer ? '己方 CPU' : '敌方 CPU'
  }
  const unit = view.board.find((u) => u.instanceId === target.instanceId)
  if (!unit) return target.instanceId
  const owner = unit.ownerId === view.viewer ? '己方' : '敌方'
  const name = getCardDefinition(unit.cardId)?.name ?? unit.cardId
  return `${owner}「${name}」(${unit.instanceId})`
}

function unitText(view: PlayerView, instanceId: string): string {
  return targetText(view, { kind: 'unit', instanceId })
}

// —— 合法动作 → 摘要 ——

export interface LegalActionEntry {
  /** 原样可回传的引擎动作（外部 agent 照抄即可，无需自行构造） */
  action: Action
  kind: Action['type']
  /** 一句话人话说明 */
  summary: string
}

/** 把一个合法动作翻译成人话（动作必须来自 engine.getLegalActions） */
export function describeAction(view: PlayerView, action: Action): string {
  switch (action.type) {
    case 'PLAY_CARD': {
      const hand = view.you.hand.find((c) => c.uid === action.uid)
      const def = hand ? getCardDefinition(hand.cardId) : undefined
      const name = def?.name ?? hand?.cardId ?? action.uid
      const cost = hand?.cost ?? def?.cost ?? '?'
      let text = `打出「${name}」（功耗 ${cost}W）`
      if (def) {
        if (def.type === 'gpu') text += `，${def.attack ?? 0}/${def.health ?? 0} 上场`
        else if (def.type === 'driver') text += '（驱动事件，结算后不占场）'
        else text += '（配件，0/1 上场占扩展槽）'
        const eff = effectText(def.effect)
        if (eff) text += `；${eff}`
      }
      if (action.target) text += ` → 目标：${targetText(view, action.target)}`
      return text
    }
    case 'ATTACK': {
      const attacker = view.board.find((u) => u.instanceId === action.attackerId)
      return `${unitText(view, action.attackerId)}（攻 ${attacker?.attack ?? '?'}）攻击 → ${targetText(view, action.target)}`
    }
    case 'USE_HERO_POWER': {
      const skill = getFactionSkill(view.you.faction)
      const name = skill?.skillName ?? '派系技能'
      let text = `使用派系技能「${name}」（功耗 ${skill?.cost ?? '?'}W，每回合一次）`
      if (skill) {
        const eff = effectText(skill.effect)
        if (eff) text += `；${eff}`
      }
      if (action.target) text += ` → 目标：${targetText(view, action.target)}`
      return text
    }
    case 'END_TURN':
      return '结束回合（交出行动权）'
    case 'CONCEDE':
      return '认输（立即判负）'
  }
}

/** legalActions → 带语义条目（summary 供 agent 决策，action 原样回传） */
export function describeLegalActions(view: PlayerView, actions: readonly Action[]): LegalActionEntry[] {
  return actions.map((action) => ({ action, kind: action.type, summary: describeAction(view, action) }))
}

// —— 事件 → 日志行 ——

function unitLabel(view: PlayerView, instanceId: string): string {
  return targetText(view, { kind: 'unit', instanceId })
}

/** 事件 → 一行人话日志（渲染层同样消费事件目录，这里只是文本化） */
export function eventToLine(view: PlayerView, event: GameEvent, sideNames?: Readonly<Record<PlayerId, string>>): string {
  const who = (p: PlayerId): string =>
    sideNames?.[p] ?? (p === view.viewer ? `你(${p})` : `对手(${p})`)
  switch (event.type) {
    case 'GAME_START':
      return `对局开始（seed=${event.seed}，先手 ${who(event.firstPlayer)}）`
    case 'TURN_START':
      return `—— 第 ${event.turn} 回合：${who(event.playerId)} 行动（供电上限 ${event.maxMana}W）`
    case 'TURN_END':
      return `${who(event.playerId)} 结束第 ${event.turn} 回合`
    case 'CARD_DRAWN': {
      if (event.source === 'fatigue') return `${who(event.playerId)} 牌库已空，进入疲劳`
      return `${who(event.playerId)} 抽 1 张牌`
    }
    case 'CARD_PLAYED': {
      const def = getCardDefinition(event.cardId)
      return `${who(event.playerId)} 打出「${def?.name ?? event.cardId}」（${event.cost}W）`
    }
    case 'CARD_BURNED':
      return `${who(event.playerId)} 手牌超限，烧掉「${getCardDefinition(event.cardId)?.name ?? event.cardId}」`
    case 'MINION_SUMMONED': {
      const def = getCardDefinition(event.unit.cardId)
      return `「${def?.name ?? event.unit.cardId}」${event.unit.attack}/${event.unit.health} 入场（${event.source === 'play' ? '出牌' : '效果'}）`
    }
    case 'MINION_DIED':
      return `「${getCardDefinition(event.unit.cardId)?.name ?? event.unit.cardId}」阵亡`
    case 'ATTACK_DECLARED':
      return `${unitLabel(view, event.attackerId)} 发起攻击 → ${targetText(view, event.target)}`
    case 'DAMAGE_DEALT': {
      const shield = event.shieldConsumed ? '（三年质保抵挡）' : ''
      const armor = event.armorAbsorbed ? `（护甲吸收 ${event.armorAbsorbed}）` : ''
      return `${targetText(view, event.target)} 受到 ${event.amount} 点伤害，剩余 ${event.remainingHealth}${shield}${armor}`
    }
    case 'HEALING':
      return `${targetText(view, event.target)} 恢复 ${event.amount} 点（现有 ${event.resultingHealth}）`
    case 'KEYWORD_TRIGGERED':
      return `关键词触发：${KEYWORD_GLOSSARY[event.keyword]?.split('：')[0] ?? event.keyword} — ${event.detail}`
    case 'HERO_POWER_USED': {
      const skill = getFactionSkill(event.playerId === view.viewer ? view.you.faction : view.opponent.faction)
      return `${who(event.playerId)} 使用派系技能「${skill?.skillName ?? event.skillId}」`
    }
    case 'FATIGUE':
      return `${who(event.playerId)} 疲劳第 ${event.fatigueCount} 次，受 ${event.damage} 点疲劳伤害`
    case 'BURN_OUT':
      return `${who(event.playerId)} 跳闸！下回合 ${event.lockedMana}W 功耗被锁定`
    case 'ARMOR_GAINED':
      return `${who(event.playerId)} 获得护甲 +${event.amount}（共 ${event.totalArmor}）`
    case 'GAME_END':
      return event.winner
        ? `对局结束：${who(event.winner)} 获胜（${event.reason === 'concede' ? '认输' : '体质归零'}）`
        : `对局结束：平局（${event.reason === 'concede' ? '认输' : '双方同时归零'}）`
  }
}
