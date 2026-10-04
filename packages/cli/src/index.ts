/**
 * @siliconcard/cli — Agent 对战接口（M3-AGT1..4）。
 *
 * 硬约束：站在"从没见过这个游戏的外部 agent"视角设计——
 * 状态输出自解释（viewFor 视图 + legalActions 带语义 + cardGlossary 图鉴 + help 块），
 * 非法动作错误带 code/detail/hint 纠正指引，agent 看一条消息即可自行重试。
 *
 * 双模式协议（同一套消息结构，见 protocol.ts）：
 * - file 模式：turn.json / action.json / gameover.json 轮转（modes/file.ts）
 * - stdio 模式：stdin/stdout 每行一个 JSON 消息（modes/stdio.ts）
 * 另有 MCP server（AGT4，零新增依赖）：src/mcp.ts（stdio JSON-RPC，initialize/tools/list/tools/call）
 *
 * 一行上手（与 docs/agent-skill.md / --help 写死一致）：
 *   yarn workspace @siliconcard/cli play --mode file --seed 42
 *   yarn workspace @siliconcard/cli demo --seed 42
 */

export { CLI_VERSION, PLAY_USAGE, DEMO_USAGE, parsePlayArgs, parseDemoArgs, type PlayArgs, type DemoArgs } from './args'
export { loadContent, resolveDeckChoice, assertFactionPlayable, defaultContentDir, UsageError, type ContentData, type DeckChoice, type DeckFile } from './content'
export { AgentMatch, AGENT_PLAYER, AI_PLAYER, type AgentMatchOptions, type AgentActionOutcome } from './driver'
export { runFileMode, type FileModeOptions } from './modes/file'
export { runStdioMode, type StdioModeOptions } from './modes/stdio'
export {
  FILE_PROTOCOL,
  STDIO_PROTOCOL,
  CLI_PROTOCOL_VERSION,
  PROTOCOL_HELP,
  ERROR_HINTS,
  buildStateMessage,
  buildGameOverMessage,
  parseAgentAction,
  toProtocolError,
  eventsToLog,
  type StateMessage,
  type GameOverMessage,
  type ProtocolError,
  type LastSettledInfo,
  type CardGlossary,
} from './protocol'
export {
  describeAction,
  describeLegalActions,
  effectText,
  eventToLine,
  glossaryEntry,
  heroPowerEntry,
  KEYWORD_GLOSSARY,
  type GlossaryEntry,
  type LegalActionEntry,
} from './describe'
export { runDemoMatch, type DemoConfig, type DemoResult } from './demoRun'
