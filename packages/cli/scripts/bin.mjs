#!/usr/bin/env node
/**
 * @siliconcard/cli bin 包装 —— 把 `siliconcard <play|demo|mcp> …` 转发到
 * vite-node 直呼对应 TS 入口（与 ai 包同款 node 直呼方案，无需预编译）。
 * 日常使用推荐 package scripts（yarn workspace @siliconcard/cli play …），
 * 本文件保证 bin 声明真实可用（PATH 里的 `siliconcard` 命令）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url)) // packages/cli/scripts
const pkgRoot = resolve(here, '..')

const commands = new Set(['play', 'demo', 'mcp'])
const requested = process.argv[2]
const entry = commands.has(requested) ? `src/${requested}.ts` : 'src/play.ts'
const passThrough = commands.has(requested) ? process.argv.slice(3) : process.argv.slice(2)

const viteNodeCandidates = [
  join(pkgRoot, '../../node_modules/vite-node/vite-node.mjs'),
  join(pkgRoot, 'node_modules/vite-node/vite-node.mjs'),
]
const viteNode = viteNodeCandidates.find((p) => existsSync(p))
if (!viteNode) {
  process.stderr.write('[siliconcard] 找不到 vite-node：请先在仓库根目录执行 yarn install\n')
  process.exit(1)
}

const child = spawn(process.execPath, [viteNode, join(pkgRoot, entry), ...passThrough], {
  cwd: process.cwd(),
  stdio: 'inherit',
})
child.on('exit', (code) => process.exit(code ?? 1))
