/**
 * 图鉴屏开关状态（P2-UI4 挂载约定）。
 *
 * 与 ReplayScreen 同模式：不占用 gameStore 的 Screen 路由（避免与对局屏互相踩状态），
 * AppRoot 按 useCodexStore(s => s.open) 分流渲染 <CodexScreen />；
 * 主菜单「图鉴」入口调 openCodex()（接线由主控执行，见 p2-ui4-codex.md 交付 4）。
 */

import { create } from 'zustand'

interface CodexState {
  open: boolean
  openCodex: () => void
  closeCodex: () => void
}

export const useCodexStore = create<CodexState>()((set) => ({
  open: false,
  openCodex: () => set({ open: true }),
  closeCodex: () => set({ open: false }),
}))
