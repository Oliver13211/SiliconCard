import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from './index'

describe('core smoke', () => {
  it('导出版本号（0.1.1 = P2-ENG1 电费抵扣券 additive 扩展，见 rules.md §13）', () => {
    expect(CORE_VERSION).toBe('0.1.1')
  })
})
