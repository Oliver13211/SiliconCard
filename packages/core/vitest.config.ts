/**
 * core 测试与覆盖率门禁（M1-QA1，task-breakdown：core 单测覆盖率 ≥85%，CI 强制）。
 * provider 与 vitest 主版本匹配（vitest 3.x ↔ @vitest/coverage-v8 ^3.x）。
 * 计入产品代码（src/**），排除测试文件本身、__golden__ 测试基建（fixtures 是基线卡池夹具，
 * 不是被测对象）与 types/**（纯类型声明、无运行时代码，v8 无执行样本可归因）。
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/__golden__/**', 'src/types/**'],
      thresholds: {
        statements: 85,
        branches: 85,
        functions: 85,
        lines: 85,
      },
    },
  },
})
