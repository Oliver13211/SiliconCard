/**
 * 主菜单（M1-UI3 闭环起点）。
 * UI 现代化：标题渐变辉光/按钮抬升见样式层；页脚附动效偏好开关（auto → on → off 循环）。
 */

import { useGameStore } from '../store/gameStore'
import { useUiPrefs, type MotionPref } from '../store/uiPrefsStore'

const MOTION_LABEL: Record<MotionPref, string> = {
  auto: '动效：跟随系统',
  on: '动效：全开',
  off: '动效：关闭',
}

function nextMotionPref(current: MotionPref): MotionPref {
  return current === 'auto' ? 'on' : current === 'on' ? 'off' : 'auto'
}

export function MainMenu() {
  const goto = useGameStore((s) => s.goto)
  const openRules = useGameStore((s) => s.openRules)
  const motion = useUiPrefs((s) => s.motion)
  const setMotion = useUiPrefs((s) => s.setMotion)
  return (
    <div className="sc-menu">
      <p className="sc-eyebrow">SILICONCARD · 显卡与硬件梗主题 1V1 卡牌对战</p>
      <h1 className="sc-menu-title">硅牌</h1>
      <p className="sc-menu-sub">5090 烧接口 · A 卡光追 · 矿卡传家宝 —— 把装机圈的全部爱恨装进一副牌。</p>
      <div className="sc-menu-actions">
        <button type="button" className="sc-btn sc-btn--primary" onClick={() => goto('setup')}>
          上电开打
        </button>
        <button type="button" className="sc-btn" onClick={() => goto('lan')}>
          局域网对战
        </button>
        <button type="button" className="sc-btn" onClick={() => openRules()}>
          规则书（5 分钟上手）
        </button>
      </div>
      <p className="sc-menu-foot">
        <span>无头规则内核 · seed + 动作序列可复现整局 · 引擎是唯一事实源</span>
        <button
          type="button"
          className="sc-btn sc-btn--small sc-motion-toggle"
          title="界面动效偏好（跟随系统 / 强制全开 / 强制关闭，自动记忆）"
          onClick={() => setMotion(nextMotionPref(motion))}
        >
          {MOTION_LABEL[motion]}
        </button>
      </p>
    </div>
  )
}
