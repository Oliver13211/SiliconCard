/**
 * 效果白话解释渲染器（P2-UI4 图鉴详情用）—— 与 core 参考实现
 * `packages/core/src/content-tests/glossary.test.ts` 的 matchStep 同语义。
 *
 * 数据源 = packages/content/glossary/effects-glossary.json（纯声明式规则表，本文件零词条）。
 * 语义基准（与 matchStep 逐一对应，glossary/README.md「匹配优先级」小节）：
 *   1. special 整步覆盖优先（命中且含必需数值占位符即采用，不再走 ops）：
 *      光环 → special['aura|stat|scope']；revive → special['revive|pick']；
 *      player 型步骤（draw/gainArmor/lockMana）→ special['<op>|<player>']；
 *      target 型步骤 → special['<op>|<kind>|<pool>|<tag>'] 退 special['<op>|<kind>|<pool>']。
 *   2. ops 通用模板：handler 步骤只查 handlers[step.name]（ops.handler 仅为键集完备占位）；
 *      其余取 ops[op].template，{target} 按 selectors['kind|pool|tag'] → selectors['kind|pool']
 *      兜底（tag 条目缺失时补注「限标签：<tag>」）；{player}/{pick}/{to} 查 ops[op].params 子表；
 *      {keyword} 查 keywords；{cardId} 由卡牌注册表解析为卡名（注入 resolveCardName）。
 *   3. 必需数值占位符：步骤写了 amount/count/attack/health 就必须出现在短语里
 *      （special 与 ops 通路同规则）；buff 未写的维度渲染为「不变」。
 *
 * 每一步 / 光环 / spec 级 handler 的问题都进 problems：ok=false 时 UI 明示
 * 「翻译缺词条」而不是静默吞掉（新卡入池若 glossary 漏条目会立刻可见）。
 */

import type { EffectSpec, EffectStep, Keyword } from '@siliconcard/core'
import glossaryJson from '../../../../content/glossary/effects-glossary.json'

// —— 契约词汇表类型（与 core 测试的契约常量同构；JSON 无类型，结构以此为准） ——

interface OpEntry {
  template: string
  params?: Record<string, Record<string, string>>
}

export interface EffectsGlossary {
  version: number
  triggers: Record<string, string>
  selectors: Record<string, string>
  ops: Record<string, OpEntry>
  keywords: Record<string, string>
  handlers: Record<string, string>
  special: Record<string, string>
}

export const glossary = glossaryJson as unknown as EffectsGlossary

/** 非空词条收窄：空 / 缺失一律折叠为 null（调用处可安全赋值与判支） */
function phraseOf(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** {token} 替换：未提供的 token 原样保留（渲染端一眼可见漏了什么） */
function renderTemplate(template: string, replacements: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, token: string) => replacements[token] ?? whole)
}

/** 带符号数值（光环 delta 可负）：+1 / -1 / 0 */
function formatSigned(n: number): string {
  return n >= 0 ? `+${n}` : String(n)
}

/** 该步骤要求短语必须携带的数值占位符（与 matchStep 的 placeholdersRequired 同语义） */
function placeholdersRequired(step: EffectStep): string[] {
  const required: string[] = []
  if ('amount' in step) required.push('{amount}')
  if ('count' in step) required.push('{count}')
  if ('attack' in step && step.attack !== undefined) required.push('{attack}')
  if ('health' in step && step.health !== undefined) required.push('{health}')
  return required
}

/** special 候选键（从具体到通用；与 matchStep 的 specialKeys 同语义） */
function specialKeys(step: EffectStep): string[] {
  if (step.op === 'handler') return []
  if (step.op === 'revive') return [`revive|${step.pick}`]
  if ('player' in step) return [`${step.op}|${step.player}`]
  if ('target' in step) {
    const { kind, pool, tag } = step.target
    return tag !== undefined
      ? [`${step.op}|${kind}|${pool}|${tag}`, `${step.op}|${kind}|${pool}`]
      : [`${step.op}|${kind}|${pool}`]
  }
  return []
}

/** 步骤数值 → 占位符替换表（buff 未写维度渲染「不变」） */
function numericReplacements(step: EffectStep): Record<string, string> {
  const map: Record<string, string> = {}
  if ('amount' in step) map.amount = String(step.amount)
  if ('count' in step) map.count = String(step.count)
  if (step.op === 'buff') {
    map.attack = step.attack !== undefined ? formatSigned(step.attack) : '不变'
    map.health = step.health !== undefined ? formatSigned(step.health) : '不变'
  }
  return map
}

export interface StepExplain {
  /** 可解释时为白话短句；null = 有问题（原因在 problem） */
  phrase: string | null
  problem?: string
}

/**
 * 单步解释（与 matchStep 的 explainOneStep 同语义，多产出短句本身）：
 * special 命中即用（短语还须含必需数值占位符）；否则走 ops 通用路径。
 */
function explainOneStep(
  step: EffectStep,
  g: EffectsGlossary,
  resolveCardName: (cardId: string) => string,
): StepExplain {
  const required = placeholdersRequired(step)

  // handler 步骤只查 handlers 表（ops.handler 仅为键集完备的占位兜底）
  if (step.op === 'handler') {
    const phrase = phraseOf(g.handlers[step.name])
    return phrase !== null ? { phrase } : { phrase: null, problem: `handler '${step.name}' 无词条` }
  }

  // 1. special 整步覆盖（命中即用，不再走 ops）
  for (const key of specialKeys(step)) {
    const special = phraseOf(g.special[key])
    if (special !== null) {
      const missing = required.filter((placeholder) => !special.includes(placeholder))
      if (missing.length > 0) {
        return { phrase: null, problem: `special '${key}' 缺数值占位符 ${missing.join(',')}` }
      }
      const map = numericReplacements(step)
      // revive special 短语中的 {count} 恒渲染实际张数（未写按 1，glossary/README.md 约定）
      if (step.op === 'revive') map.count = String(step.count ?? 1)
      return { phrase: renderTemplate(special, map) }
    }
  }

  // 2. ops 通用模板
  const opEntry = g.ops[step.op]
  if (!opEntry) return { phrase: null, problem: `op '${step.op}' 无模板` }
  const template = phraseOf(opEntry.template)
  if (template === null) return { phrase: null, problem: `op '${step.op}' 无模板` }
  const missing = required.filter((placeholder) => !template.includes(placeholder))
  if (missing.length > 0) {
    return { phrase: null, problem: `op '${step.op}' 模板缺数值占位符 ${missing.join(',')}` }
  }

  const replacements = numericReplacements(step)

  if ('target' in step) {
    const { kind, pool, tag } = step.target
    const tagged = tag !== undefined ? phraseOf(g.selectors[`${kind}|${pool}|${tag}`]) : null
    const generic = phraseOf(g.selectors[`${kind}|${pool}`])
    if (tagged !== null) {
      replacements.target = tagged
    } else if (generic !== null) {
      // tag 精确条目缺失：走 kind|pool 兜底并补注标签（glossary/README.md 约定）
      replacements.target = tag !== undefined ? `${generic}（限标签：${tag}）` : generic
    } else {
      return { phrase: null, problem: `selector '${kind}|${pool}${tag !== undefined ? `|${tag}` : ''}' 无词条` }
    }
  }

  if ('player' in step) {
    const phrase = phraseOf(opEntry.params?.player?.[step.player])
    if (phrase === null) return { phrase: null, problem: `op '${step.op}' 缺 params.player['${step.player}']` }
    replacements.player = phrase
  }

  if ('keyword' in step) {
    const phrase = phraseOf(g.keywords[step.keyword])
    if (phrase === null) return { phrase: null, problem: `keyword '${step.keyword}' 无词条` }
    replacements.keyword = phrase
  }

  if (step.op === 'revive') {
    const pick = phraseOf(opEntry.params?.pick?.[step.pick])
    const to = phraseOf(opEntry.params?.to?.[step.to])
    if (pick === null || to === null) {
      return { phrase: null, problem: `op 'revive' 缺 params.pick['${step.pick}'] / params.to['${step.to}']` }
    }
    replacements.pick = pick
    replacements.to = to
  }

  if ('cardId' in step) {
    replacements.cardId = resolveCardName(step.cardId)
  }

  return { phrase: renderTemplate(template, replacements) }
}

/** 白话解释结果：ok=false 时 problems 非空，UI 明示翻译缺口 */
export interface EffectExplain {
  ok: boolean
  /** 触发时点短语（triggers 词条） */
  triggerLabel: string
  /** 每个效果步骤一句（含 spec 级 handler 与光环） */
  sentences: string[]
  /** 步骤中出现的 grantKeyword/removeKeyword 关键词解释（keywords 词条） */
  keywords: readonly { id: Keyword; text: string }[]
  problems: string[]
}

export type CardNameResolver = (cardId: string) => string

const fallbackResolver: CardNameResolver = (cardId) => cardId

/**
 * EffectSpec → 白话解释（与 matchStep 同语义的渲染版）。
 * - spec.trigger 必须有 triggers 词条；
 * - spec.handler（steps 表达不了的特殊逻辑）单独成句；
 * - spec.aura（光环仅此一条通路）用 special['aura|stat|scope']，{delta} 带符号替换；
 * - steps 逐条 explainOneStep。
 */
export function explainEffectSpec(
  spec: EffectSpec,
  resolveCardName: CardNameResolver = fallbackResolver,
  g: EffectsGlossary = glossary,
): EffectExplain {
  const problems: string[] = []
  const sentences: string[] = []

  const triggerLabel = phraseOf(g.triggers[spec.trigger])
  if (triggerLabel === null) problems.push(`trigger '${spec.trigger}' 无词条`)

  if (spec.handler !== undefined) {
    const phrase = phraseOf(g.handlers[spec.handler])
    if (phrase !== null) sentences.push(phrase)
    else problems.push(`handler '${spec.handler}' 无词条`)
  }

  if (spec.aura !== undefined) {
    const key = `aura|${spec.aura.stat}|${spec.aura.scope}`
    const phrase = phraseOf(g.special[key])
    if (phrase !== null) {
      sentences.push(renderTemplate(phrase, { delta: formatSigned(spec.aura.delta) }))
    } else {
      problems.push(`aura '${spec.aura.stat}|${spec.aura.scope}' 无 special 词条`)
    }
  }

  for (const [index, step] of (spec.steps ?? []).entries()) {
    const result = explainOneStep(step, g, resolveCardName)
    if (result.phrase !== null) sentences.push(result.phrase)
    else problems.push(`steps[${index}](${step.op}): ${result.problem ?? '不可解释'}`)
  }

  // 步骤涉及的关键词自动收集（卡面静态关键词另由 explainKeyword 展开全文）
  const collected = new Set<Keyword>()
  for (const step of spec.steps ?? []) {
    if ((step.op === 'grantKeyword' || step.op === 'removeKeyword') && 'keyword' in step) {
      collected.add(step.keyword)
    }
  }
  const keywords = [...collected].map((id) => ({ id, text: g.keywords[id] ?? '' }))

  return {
    ok: problems.length === 0,
    triggerLabel: triggerLabel ?? spec.trigger,
    sentences,
    keywords,
    problems,
  }
}

/** 关键词解释（图鉴关键词行直接取 keywords 词条，带梗全文） */
export function explainKeyword(id: Keyword, g: EffectsGlossary = glossary): string | null {
  return phraseOf(g.keywords[id])
}
