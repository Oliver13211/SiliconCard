/**
 * MCP server 入口（M3-AGT4）——stdio JSON-RPC 2.0，每行一个消息。
 *
 * 客户端配置示例（如 Claude/ZCode 的 mcpServers）：
 *   { "command": "yarn", "args": ["workspace", "@siliconcard/cli", "mcp"] }
 *
 * 工具：silicon_start（开局）/ silicon_view（查看）/ silicon_act（出牌）。
 * 实现说明：零新增 npm 依赖，最小 JSON-RPC（initialize / tools/list / tools/call / ping）。
 */

import { createInterface } from 'node:readline'
import { McpServerCore } from './mcpServer'

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
const core = new McpServerCore()

rl.on('line', (line: string) => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  try {
    const response = core.handleMessage(trimmed)
    if (response !== null) process.stdout.write(JSON.stringify(response) + '\n')
  } catch (error) {
    // handleMessage 内部已兜底，此处仅防御性兜底：不让 server 因单行异常退出
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `Internal error: ${String(error)}` } }) + '\n',
    )
  }
})
