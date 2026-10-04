/**
 * MCP server（AGT4）契约：initialize / tools/list / tools/call（开局/查看/出牌）
 * 最小 JSON-RPC 往返；错误路径（未知方法 / 解析错误 / 工具拒绝）。
 */

import { describe, expect, it } from 'vitest'
import { McpServerCore, MCP_TOOLS, MCP_SERVER_INFO } from './mcpServer'
import { loadContent } from './content'

function call(core: McpServerCore, id: number, method: string, params?: unknown): { jsonrpc: string; id: number; result?: Record<string, unknown>; error?: { code: number; message: string } } {
  return core.handleMessage(JSON.stringify({ jsonrpc: '2.0', id, method, params })) as never
}

/** 发起 tools/call 并解开 JSON-RPC 信封与 content[0].text，返回工具载荷 */
function toolCall(core: McpServerCore, id: number, name: string, args?: unknown): Record<string, unknown> {
  const res = call(core, id, 'tools/call', { name, arguments: args })
  const result = res.result as { isError: boolean; content: { type: string; text: string }[] }
  expect(result.isError).toBe(false)
  expect(result.content[0]?.type).toBe('text')
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('MCP 最小 JSON-RPC 三件套', () => {
  const core = new McpServerCore(loadContent())

  it('initialize：回协议版本与 serverInfo；notifications/initialized 不回包', () => {
    const res = call(core, 1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } })
    expect(res.result?.protocolVersion).toBe('2024-11-05')
    expect(res.result?.serverInfo).toEqual(MCP_SERVER_INFO)
    expect(core.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).toBeNull()
  })

  it('tools/list：三个工具（开局/查看/出牌），schema 齐备', () => {
    const res = call(core, 2, 'tools/list')
    const tools = res.result?.['tools'] as { name: string }[]
    expect(tools.map((t) => t.name)).toEqual(['silicon_start', 'silicon_view', 'silicon_act'])
    expect(MCP_TOOLS.every((t) => typeof t.description === 'string' && t.inputSchema.type === 'object')).toBe(true)
  })

  it('silicon_start → 自解释 StateMessage；silicon_act END_TURN 推进回合；silicon_view 可随时查看', () => {
    const started = toolCall(core, 3, 'silicon_start', { seed: 42 }) as unknown as { message: string; you: string; state: { you: { hand: unknown[] } }; legalActions: { action: { type: string }; summary: string }[] }
    expect(started.message).toBe('state')
    expect(started.you).toBe('P1')
    expect(started.state.you.hand.length).toBe(3)
    expect(started.legalActions.length).toBeGreaterThan(0)

    const endTurn = started.legalActions.find((l) => l.action.type === 'END_TURN')!
    const after = toolCall(core, 4, 'silicon_act', { action: endTurn.action }) as unknown as { message: string; turn: number }
    expect(after.message).toBe('state')
    expect(after.turn).toBeGreaterThan(1)

    const view = toolCall(core, 5, 'silicon_view', {}) as unknown as { message: string; seq: number }
    expect(view.message).toBe('state')
    expect(view.seq).toBeGreaterThan(0)
  })

  it('silicon_act 非法动作：isError 结果携带 code+hint（协议层不崩，可纠正重发）', () => {
    const res = call(core, 6, 'tools/call', { name: 'silicon_act', arguments: { action: { type: 'PLAY_CARD', playerId: 'P1', uid: 'ghost' } } })
    expect(res.error).toBeUndefined()
    const result = res.result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    const payload = JSON.parse(result.content[0]!.text) as { code: string; hint: string }
    expect(payload.code).toBe('CARD_NOT_IN_HAND')
    expect(payload.hint).toMatch(/legalActions/)
  })

  it('未开局 silicon_view 给出指路；未知工具/方法与坏 JSON 有明确错误码', () => {
    const fresh = new McpServerCore(loadContent())
    const viewRes = call(fresh, 1, 'tools/call', { name: 'silicon_view', arguments: {} })
    const payload = JSON.parse((viewRes.result as { content: { text: string }[] }).content[0]!.text) as { error: string }
    expect(payload.error).toMatch(/silicon_start/)
    const badTool = call(fresh, 2, 'tools/call', { name: 'nope', arguments: {} })
    expect(badTool.error).toBeUndefined()
    const badToolResult = badTool.result as { isError: boolean; content: { text: string }[] }
    expect(badToolResult.isError).toBe(true)
    expect(badToolResult.content[0]!.text).toMatch(/silicon_start/)

    const badMethod = call(fresh, 3, 'resources/list')
    expect(badMethod.error?.code).toBe(-32601)

    const badJson = fresh.handleMessage('{oops')
    expect((badJson as { error: { code: number } }).error.code).toBe(-32700)

    expect(call(fresh, 4, 'ping').result).toEqual({})
  })
})
