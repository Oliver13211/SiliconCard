/**
 * @siliconcard/client ui/preview —— 沙箱效果预览（P2-UI2-2）对外出口。
 *
 * 挂载约定（接线留主控，本模块零状态外泄）：
 *   import { PreviewTrigger } from '.../ui/preview'
 *   <PreviewTrigger def={cardDef} resolveCardName={resolver} label="效果演示" />
 * 或需要自定义触发形态时：
 *   import { PreviewPanel } from '.../ui/preview'
 *   <PreviewPanel def={cardDef} resolveCardName={resolver} onClose={fn} />
 */

export { PreviewPanel, PreviewTrigger } from './PreviewPanel'
export { DemoCanvas } from './DemoCanvas'
export {
  buildDemoDeck,
  buildDemoTimeline,
  getDemoTimeline,
  clearDemoCache,
  type DemoDriverOptions,
  type DemoHeroSnapshot,
  type DemoSnapshot,
  type DemoTimeline,
  type DemoUnitSnapshot,
} from './demoDriver'
