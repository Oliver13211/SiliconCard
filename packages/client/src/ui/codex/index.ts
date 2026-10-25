/**
 * ui/codex 对外出口（P2-UI4 全卡图鉴）—— 供 AppRoot 与主菜单接线（主控执行）：
 *
 *   import { CodexScreen, useCodexStore } from './ui/codex'
 *   // AppRoot：{codexOpen && <CodexScreen />}（与 ReplayScreen 分流同模式）
 *   // MainMenu：「图鉴」按钮 onClick={openCodex}
 */

export { CodexScreen } from './CodexScreen'
export { useCodexStore } from './codexStore'
