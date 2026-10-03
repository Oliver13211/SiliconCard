/**
 * 效果 handler 注册表单测（M1-QA1 补覆盖率）：
 * registerEffectHandler 参数闸门、同名覆盖语义、clearEffectHandlers /
 * resetEffectHandlers 测试隔离工具。内置 handler（ray_tracing_try / double_attack）
 * 的行为语义已由 engine/heroPower.test.ts 等覆盖，本文件只测注册表本体。
 * vitest 文件间模块默认隔离，afterEach 恢复内置即可保证文件内自洽。
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  clearEffectHandlers,
  getEffectHandler,
  registerEffectHandler,
  resetEffectHandlers,
} from './handlers'

describe('效果 handler 注册表（effects/handlers.ts）', () => {
  afterEach(() => {
    resetEffectHandlers()
  })

  it('registerEffectHandler：name 必须为非空字符串', () => {
    expect(() => registerEffectHandler('', () => {})).toThrow('name 必须为非空字符串')
    expect(() => registerEffectHandler(42 as unknown as string, () => {})).toThrow(
      'name 必须为非空字符串',
    )
  })

  it('registerEffectHandler：handler 必须为函数', () => {
    expect(() => registerEffectHandler('x', undefined as unknown as () => void)).toThrow(
      'handler x 必须为函数',
    )
  })

  it('getEffectHandler：未注册返回 undefined；注册后可取回；同名后写覆盖', () => {
    expect(getEffectHandler('no_such_handler')).toBeUndefined()
    const a = (): void => {}
    const b = (): void => {}
    registerEffectHandler('custom_test_handler', a)
    expect(getEffectHandler('custom_test_handler')).toBe(a)
    registerEffectHandler('custom_test_handler', b)
    expect(getEffectHandler('custom_test_handler')).toBe(b)
  })

  it('clearEffectHandlers：清空后内置与自定义全部不可取', () => {
    registerEffectHandler('custom_test_handler', () => {})
    expect(getEffectHandler('ray_tracing_try')).toBeDefined()
    clearEffectHandlers()
    expect(getEffectHandler('custom_test_handler')).toBeUndefined()
    expect(getEffectHandler('ray_tracing_try')).toBeUndefined()
    expect(getEffectHandler('double_attack')).toBeUndefined()
  })

  it('resetEffectHandlers：清空后恢复内置 handler，且不复活自定义', () => {
    clearEffectHandlers()
    expect(getEffectHandler('ray_tracing_try')).toBeUndefined()
    resetEffectHandlers()
    expect(getEffectHandler('ray_tracing_try')).toBeDefined()
    expect(getEffectHandler('double_attack')).toBeDefined()
  })
})
