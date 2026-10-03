/**
 * 卡牌定义注册表单测（M1-QA1 补覆盖率）：targetSelectorIssue 的未知 kind /
 * tag 违例分支（其余 op/aura 分支已由 engine/init.test.ts 等覆盖），以及
 * registerCardDefinitions / getCardDefinition / clearCardDefinitions 基本语义。
 * 校验闸门面向 content JSON 运行期把关，非法输入按契约构造（类型断言绕过编译期）。
 */

import { describe, expect, it } from 'vitest'
import type { CardDefinition, EffectSpec, TargetSelector } from '../types/cards'
import {
  clearCardDefinitions,
  findEffectSpecIssues,
  getCardDefinition,
  registerCardDefinitions,
} from './registry'

const GPU: CardDefinition = {
  id: 't.gpu',
  name: '测试卡',
  faction: 'nvidia',
  type: 'gpu',
  cost: 1,
  attack: 1,
  health: 1,
}

describe('目标选择器校验闸门（engine/registry.ts targetSelectorIssue）', () => {
  it('未知 kind 拒绝', () => {
    const spec: EffectSpec = {
      trigger: 'battlecry',
      steps: [
        {
          op: 'damage',
          target: { kind: 'nope', pool: 'enemyHero' } as unknown as TargetSelector,
          amount: 1,
        },
      ],
    }
    expect(findEffectSpecIssues(spec)).toBe('未知目标选择器 nope')
  })

  it('tag 出现时必须为非空字符串', () => {
    const spec: EffectSpec = {
      trigger: 'battlecry',
      steps: [{ op: 'destroy', target: { kind: 'all', pool: 'enemyUnits', tag: '' } }],
    }
    expect(findEffectSpecIssues(spec)).toBe('目标选择器 tag 必须为非空字符串')
  })
})

describe('卡牌注册表基本语义（engine/registry.ts）', () => {
  it('注册后可查、同 id 后写覆盖、clear 清空', () => {
    registerCardDefinitions([GPU])
    expect(getCardDefinition('t.gpu')).toBe(GPU)
    const v2: CardDefinition = { ...GPU, cost: 2 }
    registerCardDefinitions([v2])
    expect(getCardDefinition('t.gpu')).toBe(v2)
    clearCardDefinitions()
    expect(getCardDefinition('t.gpu')).toBeUndefined()
  })
})
