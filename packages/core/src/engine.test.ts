import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from './index'

describe('core smoke', () => {
  it('导出版本号（0.1.0 = M1-ENG7 引擎链闭环，见 rules.md §13）', () => {
    expect(CORE_VERSION).toBe('0.1.0')
  })
})
