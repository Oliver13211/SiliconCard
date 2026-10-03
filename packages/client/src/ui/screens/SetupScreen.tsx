/**
 * 开局配置（M1-UI3）：选派系 → 选卡组 → 对手派系 → 上电开打。
 * 派系可用性以 core 技能注册表为准（getFactionSkill）；卡组来自 content/decks，
 * 未就位时优雅降级为随机 demo 牌组（deckLoader）。
 */

import type { CSSProperties } from 'react'
import { getFactionSkill } from '@siliconcard/core'
import { useGameStore } from '../store/gameStore'
import { FACTION_DISPLAY } from '../game/fallbackContent'

export function SetupScreen() {
  const draftFaction = useGameStore((s) => s.draftFaction)
  const draftDeckId = useGameStore((s) => s.draftDeckId)
  const draftOpponentFaction = useGameStore((s) => s.draftOpponentFaction)
  const deckList = useGameStore((s) => s.deckList)
  const setDraftFaction = useGameStore((s) => s.setDraftFaction)
  const setDraftDeck = useGameStore((s) => s.setDraftDeck)
  const setDraftOpponentFaction = useGameStore((s) => s.setDraftOpponentFaction)
  const startBattle = useGameStore((s) => s.startBattle)
  const goto = useGameStore((s) => s.goto)

  const degraded = deckList.some((d) => d.degraded)

  return (
    <div className="sc-setup">
      <h1 className="sc-screen-title">开一局</h1>

      <section className="sc-setup-section">
        <h2>1 · 选你的派系（= 英雄技能）</h2>
        <div className="sc-faction-grid">
          {FACTION_DISPLAY.map((faction) => {
            const skill = getFactionSkill(faction.id)
            return (
              <button
                key={faction.id}
                type="button"
                className={`sc-faction-card${draftFaction === faction.id ? ' is-active' : ''}`}
                style={{ '--accent': faction.color } as CSSProperties}
                disabled={!skill}
                onClick={() => setDraftFaction(faction.id)}
              >
                <span className="sc-faction-name">{faction.name}</span>
                <span className="sc-faction-skill">
                  {skill ? `${skill.skillName}（${skill.cost}W）` : '技能未注册（等待 content）'}
                </span>
                <span className="sc-faction-blurb">{faction.blurb}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section className="sc-setup-section">
        <h2>2 · 选卡组</h2>
        <div className="sc-deck-picker">
          <select value={draftDeckId} onChange={(e) => setDraftDeck(e.target.value)}>
            {deckList.map((deck) => (
              <option key={deck.id} value={deck.id}>
                {deck.name}
                {deck.degraded ? '（降级）' : ''}
              </option>
            ))}
          </select>
          {degraded ? (
            <p className="sc-setup-note">
              content 卡组尚未就位（packages/content/decks/ 为空）：先用随机 demo 牌组开闭环，
              正式卡组由集成侧接入后此下拉会自动多出真实选项。
            </p>
          ) : null}
        </div>
      </section>

      <section className="sc-setup-section">
        <h2>3 · 对面派系</h2>
        <div className="sc-deck-picker">
          <select
            value={draftOpponentFaction}
            onChange={(e) => setDraftOpponentFaction(e.target.value as typeof draftOpponentFaction)}
          >
            <option value="random">随机（看脸）</option>
            {FACTION_DISPLAY.map((faction) => (
              <option key={faction.id} value={faction.id}>
                {faction.name}
              </option>
            ))}
          </select>
          <p className="sc-setup-note">
            对面由「简易托管」代打（占位，正式内置人机为 M1-AI1）：只走引擎公开接口，能出就出、能打就打。
          </p>
        </div>
      </section>

      <div className="sc-setup-actions">
        <button type="button" className="sc-btn sc-btn--primary" onClick={() => startBattle()}>
          上电开打
        </button>
        <button type="button" className="sc-btn" onClick={() => goto('menu')}>
          返回主菜单
        </button>
      </div>
    </div>
  )
}
