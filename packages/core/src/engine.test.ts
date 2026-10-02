import { describe, expect, it } from 'vitest'
import { CORE_VERSION } from './index'

describe('core smoke', () => {
  it('导出版本号', () => {
    expect(CORE_VERSION).toBe('0.0.3')
  })
})
