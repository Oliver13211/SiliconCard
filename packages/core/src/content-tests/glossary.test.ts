/**
 * P2-UI2-1 效果白话翻译器 —— 数据契约验收（packages/content/glossary/effects-glossary.json）。
 *
 * 验收口径（phase2-plan §P2-UI2-1）：
 * 1. glossary 自身闸门：七大区块齐全、词条非空、占位符全部在契约白名单内；
 * 2. 静态全覆盖：8 触发时点 / 12 效果原语 / 27 种 kind|pool 选择器组合 / 7 关键词全部有条目；
 * 3. handlers 双向对齐：glossary.handlers 每个键都已在引擎注册（无僵尸条目），引擎内置 handler 全有条目；
 * 4. special 键全部合法且均可被 matchStep 命中（构造合成 EffectSpec 验证）；
 * 5. 零漏网：扫描 content 包全部效果来源（cards/ 下全部卡 + 内置派系技能 + 其余 JSON 的 effect 闸门），
 *    断言每个 EffectSpec 都能被 matchStep 解释（新卡入池自动纳入扫描，无需改本文件）；
 * 6. 匹配器非空洞：负向对照（删词条 → 匹配失败）与未来卡路径（合成 opposingPlayer 抽牌 → 匹配成功）。
 *
 * —— matchStep 语义注释（客户端渲染器按同一语义实现；详见 glossary/README.md）——
 * matchStep(spec, glossary) → boolean，对 EffectSpec 的四个面逐一校验：
 *   a. trigger：glossary.triggers[spec.trigger] 非空；
 *   b. spec.handler：glossary.handlers[spec.handler] 非空；
 *   c. spec.aura：glossary.special['aura|<stat>|<scope>'] 非空（光环仅此一条通路）；
 *   d. steps 每步：先试 special 整步覆盖（命中即通过，短语还须含该步数值占位符），
 *      候选键按 op 形态生成：
 *        - revive        → 'revive|<pick>'
 *        - player 型步骤（draw/gainArmor/lockMana）→ '<op>|<player>'
 *        - target 型步骤 → '<op>|<kind>|<pool>|<tag>'，再退 '<op>|<kind>|<pool>'
 *      special 未命中走 ops 通用路径：ops[op].template 非空且含该步数值占位符；
 *      {target} 查 selectors['kind|pool|tag'] → selectors['kind|pool'] 兜底；
 *      {player}/{pick}/{to} 查 ops[op].params 子表；{keyword} 查 glossary.keywords；
 *      handler 步骤只查 glossary.handlers[step.name]（ops.handler 仅为键集完备的占位兜底）；
 *      {cardId} 由客户端卡牌注册表解析，不做词汇校验。
 * 本文件只读 content JSON 与引擎注册表；不修改 content/glossary 之外的任何文件。
 */

import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getEffectHandler } from '../effects/handlers'
import { BUILTIN_FACTION_SKILLS } from '../factions/builtin'
import type {
  AuraSpec,
  CardDefinition,
  EffectPlayer,
  EffectSpec,
  EffectStep,
  EffectTrigger,
  Keyword,
  TargetPool,
} from '../types/cards'
import glossaryJson from '../../../content/glossary/effects-glossary.json'

// —— 契约词汇表类型（JSON 无类型，结构以此为准）——

interface OpEntry {
  template: string
  params?: Record<string, Record<string, string>>
}

interface EffectsGlossary {
  version: number
  triggers: Record<string, string>
  selectors: Record<string, string>
  ops: Record<string, OpEntry>
  keywords: Record<string, string>
  handlers: Record<string, string>
  special: Record<string, string>
}

const glossary = glossaryJson as unknown as EffectsGlossary

// —— 契约常量（与 types/cards.ts 的字面量并集逐一对应）——

const ALL_TRIGGERS: readonly EffectTrigger[] = [
  'battlecry',
  'deathrattle',
  'onPlay',
  'aura',
  'turnStart',
  'turnEnd',
  'onAttack',
  'onDamaged',
]
const ALL_POOLS: readonly TargetPool[] = [
  'ownHero',
  'enemyHero',
  'ownUnits',
  'enemyUnits',
  'allUnits',
  'anyCharacter',
  'self',
  'sourceOwner',
  'opposingPlayer',
]
const ALL_KINDS = ['chosen', 'random', 'all'] as const
const ALL_KEYWORDS: readonly Keyword[] = [
  'taunt',
  'divine_shield',
  'charge',
  'windfury',
  'deathrattle',
  'stealth',
  'overload',
]
const ALL_OPS = [
  'damage',
  'heal',
  'buff',
  'grantKeyword',
  'removeKeyword',
  'draw',
  'summon',
  'destroy',
  'revive',
  'gainArmor',
  'lockMana',
  'handler',
] as const
const PLAYER_OPS = ['draw', 'gainArmor', 'lockMana'] as const
const ALL_PLAYERS: readonly EffectPlayer[] = ['sourceOwner', 'opposingPlayer']
const AURA_STATS = ['attack', 'health', 'cost'] as const
const AURA_SCOPES = ['ownUnits', 'enemyUnits', 'allUnits'] as const
/** 引擎内置 handler 清单（effects/handlers.ts 注册；引擎未导出枚举 API，故此处显式对照） */
const BUILTIN_HANDLERS = ['ray_tracing_try', 'double_attack'] as const
/** 模板/special 短语允许出现的占位符全集（glossary/README.md「占位符」小节） */
const ALLOWED_PLACEHOLDERS = new Set([
  'target',
  'amount',
  'count',
  'attack',
  'health',
  'keyword',
  'player',
  'pick',
  'to',
  'cardId',
  'delta',
  'handler',
])

// —— content 包效果来源扫描（fs 遍历：新卡入池自动纳入，无需改本文件）——

const CONTENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../content')

function listJsonFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listJsonFiles(path.join(dir, entry.name))
      : entry.name.endsWith('.json')
        ? [path.join(dir, entry.name)]
        : [],
  )
}

const cardDefs: CardDefinition[] = listJsonFiles(path.join(CONTENT_ROOT, 'cards')).map(
  (file) => JSON.parse(readFileSync(file, 'utf8')) as CardDefinition,
)

interface EffectSource {
  id: string
  spec: EffectSpec
}

/** cards/ 全部卡 + 内置派系技能；其余 content JSON（decks 等）不得携带 effect 字段（另测闸门） */
const EFFECT_SOURCES: EffectSource[] = [
  ...cardDefs
    .filter((def): def is CardDefinition & { effect: EffectSpec } => def.effect !== undefined)
    .map((def) => ({ id: def.id, spec: def.effect })),
  ...BUILTIN_FACTION_SKILLS.map((skill) => ({ id: `skill:${skill.skillId}`, spec: skill.effect })),
]

// —— matchStep：契约语义的最小参考实现（语义注释见文件头；explain* 为带诊断信息的同语义内实现）——

const nonEmpty = (value: string | undefined): boolean => typeof value === 'string' && value.length > 0

/** 该步骤要求模板/special 短语必须携带的数值占位符（验收「翻译含关键数值」） */
function placeholdersRequired(step: EffectStep): string[] {
  const required: string[] = []
  if ('amount' in step) required.push('{amount}')
  if ('count' in step) required.push('{count}')
  if ('attack' in step && step.attack !== undefined) required.push('{attack}')
  if ('health' in step && step.health !== undefined) required.push('{health}')
  return required
}

/** special 候选键（按优先级从具体到通用；空数组 = 该步骤形态无 special 通路） */
function specialKeys(step: EffectStep): string[] {
  if (step.op === 'handler') return []
  if (step.op === 'revive') return [`revive|${step.pick}`]
  if ('player' in step) return [`${step.op}|${step.player}`]
  if ('target' in step) {
    const { kind, pool, tag } = step.target
    return tag ? [`${step.op}|${kind}|${pool}|${tag}`, `${step.op}|${kind}|${pool}`] : [`${step.op}|${kind}|${pool}`]
  }
  return []
}

/** 单步诊断：null = 可解释，否则返回缺失原因（与 matchStep 同语义） */
function explainOneStep(step: EffectStep, g: EffectsGlossary): string | null {
  if (step.op === 'handler') {
    return nonEmpty(g.handlers[step.name]) ? null : `handler '${step.name}' 无词条`
  }
  const required = placeholdersRequired(step)
  for (const key of specialKeys(step)) {
    const phrase = g.special[key]
    if (typeof phrase === 'string' && phrase.length > 0) {
      const missing = required.filter((placeholder) => !phrase.includes(placeholder))
      return missing.length > 0 ? `special '${key}' 缺数值占位符 ${missing.join(',')}` : null
    }
  }
  const opEntry = g.ops[step.op]
  if (!opEntry || !nonEmpty(opEntry.template)) return `op '${step.op}' 无模板`
  const missing = required.filter((placeholder) => !opEntry.template.includes(placeholder))
  if (missing.length > 0) return `op '${step.op}' 模板缺数值占位符 ${missing.join(',')}`
  if ('target' in step) {
    const { kind, pool, tag } = step.target
    const hit =
      (tag !== undefined && nonEmpty(g.selectors[`${kind}|${pool}|${tag}`])) ||
      nonEmpty(g.selectors[`${kind}|${pool}`])
    if (!hit) return `selector '${kind}|${pool}${tag ? `|${tag}` : ''}' 无词条`
  }
  if ('player' in step && !nonEmpty(opEntry.params?.player?.[step.player])) {
    return `op '${step.op}' 缺 params.player['${step.player}']`
  }
  if ('keyword' in step && !nonEmpty(g.keywords[step.keyword])) return `keyword '${step.keyword}' 无词条`
  if (step.op === 'revive') {
    const pickOk = nonEmpty(opEntry.params?.pick?.[step.pick])
    const toOk = nonEmpty(opEntry.params?.to?.[step.to])
    if (!pickOk || !toOk) {
      return `op 'revive' 缺 params.pick['${step.pick}'] / params.to['${step.to}']`
    }
  }
  return null
}

/** EffectSpec 四面诊断（与 matchStep 同语义，带定位信息） */
function explainSpec(spec: EffectSpec, g: EffectsGlossary): string[] {
  const problems: string[] = []
  if (!nonEmpty(g.triggers[spec.trigger])) problems.push(`trigger '${spec.trigger}' 无词条`)
  if (spec.handler !== undefined && !nonEmpty(g.handlers[spec.handler])) {
    problems.push(`handler '${spec.handler}' 无词条`)
  }
  if (spec.aura !== undefined && !nonEmpty(g.special[`aura|${spec.aura.stat}|${spec.aura.scope}`])) {
    problems.push(`aura '${spec.aura.stat}|${spec.aura.scope}' 无 special 词条`)
  }
  for (const [index, step] of (spec.steps ?? []).entries()) {
    const why = explainOneStep(step, g)
    if (why !== null) problems.push(`steps[${index}](${step.op}): ${why}`)
  }
  return problems
}

/** 契约要求的匹配函数：EffectSpec 能否被 glossary 完整解释（零漏网判定） */
function matchStep(spec: EffectSpec, g: EffectsGlossary): boolean {
  return explainSpec(spec, g).length === 0
}

// —— 为 special 键构造「能命中它」的合成 EffectSpec（验证 special 键均可被匹配函数命中）——

function targetOf(parts: readonly string[]): { kind: 'chosen' | 'random' | 'all'; pool: TargetPool; tag?: string } {
  return {
    kind: parts[1] as 'chosen' | 'random' | 'all',
    pool: parts[2] as TargetPool,
    ...(parts[3] !== undefined ? { tag: parts[3] } : {}),
  }
}

function specForSpecialKey(key: string): EffectSpec | null {
  const parts = key.split('|')
  const head = parts[0]
  if (head === 'aura' && parts.length === 3) {
    return {
      trigger: 'aura',
      aura: {
        stat: parts[1] as AuraSpec['stat'],
        delta: 1,
        scope: parts[2] as AuraSpec['scope'],
      },
    }
  }
  if (head === 'revive' && parts.length === 2) {
    const step: EffectStep = {
      op: 'revive',
      pick: parts[1] as 'lastOwnedGpu' | 'random',
      to: 'sourceOwnerBoard',
    }
    return { trigger: 'battlecry', steps: [step] }
  }
  if (head !== undefined && (PLAYER_OPS as readonly string[]).includes(head) && parts.length === 2) {
    const player = parts[1] as EffectPlayer
    let step: EffectStep
    if (head === 'draw') step = { op: 'draw', player, count: 1 }
    else if (head === 'gainArmor') step = { op: 'gainArmor', player, amount: 100 }
    else step = { op: 'lockMana', player, amount: 100 }
    return { trigger: 'onPlay', steps: [step] }
  }
  // target 型 op：'<op>|<kind>|<pool>(|<tag>)'；head 不在 target 型 op 集合内 → 键形态非法
  const TARGETED_OPS = ['damage', 'heal', 'buff', 'destroy', 'grantKeyword', 'removeKeyword']
  if (head === undefined || !TARGETED_OPS.includes(head) || (parts.length !== 3 && parts.length !== 4)) {
    return null
  }
  const target = targetOf(parts)
  let step: EffectStep | null = null
  if (head === 'damage') step = { op: 'damage', target, amount: 1 }
  else if (head === 'heal') step = { op: 'heal', target, amount: 1 }
  else if (head === 'buff') step = { op: 'buff', target, attack: 1 }
  else if (head === 'destroy') step = { op: 'destroy', target }
  else if (head === 'grantKeyword') step = { op: 'grantKeyword', target, keyword: 'taunt' }
  else if (head === 'removeKeyword') step = { op: 'removeKeyword', target, keyword: 'taunt' }
  return step === null ? null : { trigger: 'onPlay', steps: [step] }
}

// —— 测试 ——

describe('P2-UI2-1 glossary 自身闸门', () => {
  it('version = 1，七大区块齐全，所有词条非空', () => {
    expect(glossary.version).toBe(1)
    for (const block of ['triggers', 'selectors', 'ops', 'keywords', 'handlers', 'special'] as const) {
      expect(Object.keys(glossary[block]).length, `区块 ${block} 不得为空`).toBeGreaterThan(0)
    }
    const blanks: string[] = []
    const check = (where: string, value: string | undefined): void => {
      if (!nonEmpty(value)) blanks.push(where)
    }
    for (const [key, value] of Object.entries(glossary.triggers)) check(`triggers.${key}`, value)
    for (const [key, value] of Object.entries(glossary.selectors)) check(`selectors.${key}`, value)
    for (const [key, value] of Object.entries(glossary.keywords)) check(`keywords.${key}`, value)
    for (const [key, value] of Object.entries(glossary.handlers)) check(`handlers.${key}`, value)
    for (const [key, value] of Object.entries(glossary.special)) check(`special.${key}`, value)
    for (const [key, entry] of Object.entries(glossary.ops)) {
      check(`ops.${key}.template`, entry?.template)
      for (const [paramKey, vocab] of Object.entries(entry?.params ?? {})) {
        for (const [valueKey, value] of Object.entries(vocab)) {
          check(`ops.${key}.params.${paramKey}.${valueKey}`, value)
        }
      }
    }
    expect(blanks).toEqual([])
  })

  it('占位符全部在契约白名单内（防止渲染端遇到未定义的 {token}）', () => {
    const offenders: string[] = []
    const check = (where: string, text: string): void => {
      for (const match of text.matchAll(/\{(\w+)\}/g)) {
        const token = match[1]
        if (token !== undefined && !ALLOWED_PLACEHOLDERS.has(token)) offenders.push(`${where}: {${token}}`)
      }
    }
    for (const [key, value] of Object.entries(glossary.triggers)) check(`triggers.${key}`, value)
    for (const [key, value] of Object.entries(glossary.selectors)) check(`selectors.${key}`, value)
    for (const [key, value] of Object.entries(glossary.keywords)) check(`keywords.${key}`, value)
    for (const [key, value] of Object.entries(glossary.handlers)) check(`handlers.${key}`, value)
    for (const [key, value] of Object.entries(glossary.special)) check(`special.${key}`, value)
    for (const [key, entry] of Object.entries(glossary.ops)) {
      check(`ops.${key}.template`, entry?.template)
      for (const vocab of Object.values(entry?.params ?? {})) {
        for (const [valueKey, value] of Object.entries(vocab)) check(`ops.${key}.params.*.${valueKey}`, value)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('P2-UI2-1 glossary 静态全覆盖（契约字面量并集）', () => {
  it('8 个 EffectTrigger 全有条目', () => {
    for (const trigger of ALL_TRIGGERS) {
      expect(nonEmpty(glossary.triggers[trigger]), `trigger '${trigger}' 缺词条`).toBe(true)
    }
  })

  it('12 个效果原语在 ops 表各有模板；player 型 op 与 revive 的 params 子表完备', () => {
    for (const op of ALL_OPS) {
      expect(nonEmpty(glossary.ops[op]?.template), `op '${op}' 缺模板`).toBe(true)
    }
    for (const op of PLAYER_OPS) {
      for (const player of ALL_PLAYERS) {
        expect(
          nonEmpty(glossary.ops[op]?.params?.player?.[player]),
          `op '${op}' 缺 params.player['${player}']`,
        ).toBe(true)
      }
    }
    for (const pick of ['lastOwnedGpu', 'random'] as const) {
      expect(nonEmpty(glossary.ops.revive?.params?.pick?.[pick]), `revive 缺 params.pick['${pick}']`).toBe(true)
    }
    expect(
      nonEmpty(glossary.ops.revive?.params?.to?.sourceOwnerBoard),
      "revive 缺 params.to['sourceOwnerBoard']",
    ).toBe(true)
  })

  it('3 kind × 9 pool = 27 种选择器组合全有条目', () => {
    for (const kind of ALL_KINDS) {
      for (const pool of ALL_POOLS) {
        expect(nonEmpty(glossary.selectors[`${kind}|${pool}`]), `selector '${kind}|${pool}' 缺词条`).toBe(true)
      }
    }
  })

  it('7 个 Keyword 全有条目', () => {
    for (const keyword of ALL_KEYWORDS) {
      expect(nonEmpty(glossary.keywords[keyword]), `keyword '${keyword}' 缺词条`).toBe(true)
    }
  })

  it('handlers 双向对齐：glossary 无僵尸条目，引擎内置 handler 全有条目', () => {
    for (const name of Object.keys(glossary.handlers)) {
      expect(getEffectHandler(name), `handlers.${name} 未在引擎注册（僵尸词条）`).toBeTypeOf('function')
    }
    for (const name of BUILTIN_HANDLERS) {
      expect(nonEmpty(glossary.handlers[name]), `引擎内置 handler '${name}' 缺词条`).toBe(true)
    }
  })

  it('special 键全部格式合法，且每个键都能被 matchStep 命中（合成 EffectSpec 验证）', () => {
    const problems: string[] = []
    for (const key of Object.keys(glossary.special)) {
      const spec = specForSpecialKey(key)
      if (spec === null) {
        problems.push(`${key}: 无法按契约语义构造命中该键的 EffectSpec（键形态非法）`)
        continue
      }
      const reasons = explainSpec(spec, glossary)
      // 光环特殊情况的通路在 spec.aura（无 steps）；其余在首个 step 的 special 候选键里
      const viaSpecial =
        spec.aura !== undefined
          ? `aura|${spec.aura.stat}|${spec.aura.scope}` === key
          : specialKeys(spec.steps?.[0] ?? { op: 'handler', name: '__none__' }).includes(key)
      if (reasons.length > 0 || !viaSpecial) problems.push(`${key}: ${reasons.join('；') || '未被 special 通路命中'}`)
    }
    expect(problems).toEqual([])
  })

  it('special 覆盖了全部 aura stat × scope 与 revive pick 组合（光环/复活不依赖 ops 通路）', () => {
    for (const stat of AURA_STATS) {
      for (const scope of AURA_SCOPES) {
        expect(
          nonEmpty(glossary.special[`aura|${stat}|${scope}`]),
          `special 缺 'aura|${stat}|${scope}'（光环仅此一条通路）`,
        ).toBe(true)
      }
    }
    for (const pick of ['lastOwnedGpu', 'random'] as const) {
      expect(nonEmpty(glossary.special[`revive|${pick}`]), `special 缺 'revive|${pick}'`).toBe(true)
    }
  })
})

describe('P2-UI2-1 全卡池零漏网扫描', () => {
  it('content/cards 下不少于 90 张卡；带效果的卡与派系技能全部纳入效果来源清单（白板卡不需要词条）', () => {
    expect(cardDefs.length).toBeGreaterThanOrEqual(90)
    const withEffect = cardDefs.filter((d) => d.effect !== undefined)
    const fromCards = EFFECT_SOURCES.filter((s) => !s.id.startsWith('skill:'))
    expect(fromCards.length, '每张带效果卡各一条来源').toBe(withEffect.length)
    expect(new Set(fromCards.map((s) => s.id)).size, '来源无重复').toBe(withEffect.length)
    expect(EFFECT_SOURCES.filter((s) => s.id.startsWith('skill:')).length, '七派系技能全部纳入').toBe(7)
  })

  it('全部卡 + 内置派系技能的每个 EffectSpec 都能被 matchStep 解释', () => {
    const failures = EFFECT_SOURCES.map((source) => ({ id: source.id, reasons: explainSpec(source.spec, glossary) }))
      .filter((entry) => entry.reasons.length > 0)
      .map((entry) => `${entry.id}: ${entry.reasons.join('；')}`)
    expect(failures).toEqual([])
  })

  it('无未纳入扫描的效果来源：cards/glossary 之外的 content JSON 不得携带 effect 字段', () => {
    const outside = listJsonFiles(CONTENT_ROOT).filter(
      (file) => !file.includes(`${path.sep}cards${path.sep}`) && !file.includes(`${path.sep}glossary${path.sep}`),
    )
    const offenders = outside
      .map((file) => ({ file, parsed: JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> }))
      .filter((entry) => 'effect' in entry.parsed)
      .map((entry) => entry.file)
    expect(offenders).toEqual([])
  })
})

describe('P2-UI2-1 匹配器语义对照（渲染器实现基准）', () => {
  it('负向对照：删除对应词条后 matchStep 必须失败（证明非空洞通过）', () => {
    const buffSpec: EffectSpec = {
      trigger: 'battlecry',
      steps: [{ op: 'buff', target: { kind: 'chosen', pool: 'ownUnits' }, attack: 1 }],
    }
    // 克隆词条删除属测试注入，非合法 glossary 形态，故断言用 unknown 双重转接
    const withoutOp = { ...glossary, ops: { ...glossary.ops, buff: undefined } } as unknown as EffectsGlossary
    const withoutSelector = {
      ...glossary,
      selectors: Object.fromEntries(Object.entries(glossary.selectors).filter(([key]) => key !== 'chosen|ownUnits')),
    }
    expect(matchStep(buffSpec, glossary)).toBe(true)
    expect(matchStep(buffSpec, withoutOp)).toBe(false)
    expect(matchStep(buffSpec, withoutSelector)).toBe(false)
  })

  it('special > ops：命中 special 键的步骤不再依赖 ops 通用模板', () => {
    const reviveSpec: EffectSpec = {
      trigger: 'battlecry',
      steps: [{ op: 'revive', pick: 'lastOwnedGpu', to: 'sourceOwnerBoard' }],
    }
    expect(nonEmpty(glossary.special['revive|lastOwnedGpu'])).toBe(true)
    const withoutReviveOp = { ...glossary, ops: { ...glossary.ops, revive: undefined } } as unknown as EffectsGlossary
    expect(matchStep(reviveSpec, withoutReviveOp)).toBe(true)
  })

  it('未来卡自动获得解释：glossary 未被现有卡用到但契约内的组合（opposingPlayer 抽牌 / 随机矿卡过滤）可解释', () => {
    const futureSpec: EffectSpec = {
      trigger: 'onPlay',
      steps: [
        { op: 'draw', player: 'opposingPlayer', count: 2 },
        { op: 'damage', target: { kind: 'random', pool: 'enemyUnits', tag: 'miner' }, amount: 1 },
      ],
    }
    expect(matchStep(futureSpec, glossary)).toBe(true)
  })
})
