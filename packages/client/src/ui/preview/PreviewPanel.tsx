/**
 * 预览面板（P2-UI2-2）：大图（复用图鉴 face 渲染路径的公开导出 CodexCardFace，
 * 禁复制实现）+ 白话解释（复用 ui/codex/glossaryRender.ts，import 不改）+
 * 关键词解释 + DemoCanvas 沙箱演示 + flavor。
 *
 * 挂载约定（任务书交付 5，接线留主控）：
 * - 本面板已接入图鉴详情（CodexDetail「效果演示」按钮展开）；
 * - 对战屏等其它入口：import { PreviewTrigger } from '../preview'，
 *   <PreviewTrigger def={cardDef} resolveCardName={resolver} label="效果演示" />
 *   —— 自带按钮 + 展开/收起状态，无需宿主管理状态；
 * - 需要自定义触发形态时直接用 PreviewPanel（def 必填，onClose 可选）。
 */

import { useMemo, useState } from 'react'
import type { CardDefinition, Keyword } from '@siliconcard/core'
import { CodexCardFace } from '../codex/CodexCardFace'
import { explainEffectSpec, explainKeyword, type CardNameResolver } from '../codex/glossaryRender'
import { loadCodexCards, makeCardNameResolver } from '../codex/cardPool'
import { getDemoTimeline } from './demoDriver'
import { DemoCanvas } from './DemoCanvas'
import '../styles/preview.css'

export function PreviewPanel({
  def,
  resolveCardName,
  onClose,
}: {
  def: CardDefinition
  /** 卡名解析（{cardId} 占位符渲染）；缺省用图鉴卡池解析 */
  resolveCardName?: CardNameResolver
  /** 关闭按钮（可选；不传则不渲染关闭钮） */
  onClose?: () => void
}) {
  const cards = useMemo(() => loadCodexCards(), [])
  const fallbackResolve = useMemo(() => makeCardNameResolver(cards), [cards])
  const resolve = resolveCardName ?? fallbackResolve
  const timeline = useMemo(() => getDemoTimeline(def.id), [def.id])
  const explain = def.effect ? explainEffectSpec(def.effect, resolve) : null

  // 卡面静态关键词 + 效果步骤涉及的关键词合并去重
  const keywordIds: Keyword[] = [
    ...new Set<Keyword>([...(def.keywords ?? []), ...(explain?.keywords.map((entry) => entry.id) ?? [])]),
  ]

  return (
    <section className="sc-preview" aria-label={`效果演示：${def.name}`}>
      <header className="sc-preview-head">
        <h3 className="sc-preview-title">效果演示 · {def.name}</h3>
        {onClose && (
          <button type="button" className="sc-btn sc-btn--small" onClick={onClose} aria-label="关闭演示">
            收起
          </button>
        )}
      </header>

      <CodexCardFace def={def} className="sc-codex-face sc-codex-face--large" />

      <DemoCanvas timeline={timeline} />

      {!timeline.playable && (
        <p className="sc-preview-note" role="note">
          沙箱无法自动演示该卡（原因见上方演示框）；白话解释仍然有效。
        </p>
      )}
      {timeline.playable && (
        <p className="sc-preview-note">
          演示局面：目标卡 ×2 + 预铺卡 GT 1030 ×2 + 中性卡填满 30 · 确定性种子 {timeline.seed} · 第 {timeline.playTurn} 回合打出 ·
          对手（P2）仅预铺与一次攻击演出（破潜行）。改 content JSON 即自动同步，零手工维护。
        </p>
      )}

      {explain && (
        <div className="sc-preview-explain">
          <p className="sc-codex-explain-trigger">{explain.triggerLabel}</p>
          <ul>
            {explain.sentences.map((sentence, i) => (
              <li key={i}>{sentence}</li>
            ))}
          </ul>
          {!explain.ok && (
            <p className="sc-codex-explain-missing" role="alert">
              白话解释缺词条（glossary 待补）：{explain.problems.join('；')}
            </p>
          )}
        </div>
      )}

      {keywordIds.length > 0 && (
        <div className="sc-preview-keywords">
          <ul>
            {keywordIds.map((id) => (
              <li key={id}>{explainKeyword(id) ?? id}</li>
            ))}
          </ul>
        </div>
      )}

      {def.flavor && <p className="sc-preview-flavor">「{def.flavor}」</p>}
    </section>
  )
}

/**
 * 挂载约定用的最小触发器：按钮 + 展开/收起自带，宿主零状态管理。
 * 对战屏等入口：<PreviewTrigger def={def} resolveCardName={resolver} />；
 * className 可覆盖按钮样式（如沿用宿主的落位类）。
 */
export function PreviewTrigger({
  def,
  resolveCardName,
  label = '效果演示',
  className,
}: {
  def: CardDefinition
  resolveCardName?: CardNameResolver
  label?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={className ? `sc-btn sc-btn--small ${className}` : 'sc-btn sc-btn--small sc-preview-trigger'}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '收起演示' : label}
      </button>
      {open && <PreviewPanel def={def} resolveCardName={resolveCardName} onClose={() => setOpen(false)} />}
    </>
  )
}
