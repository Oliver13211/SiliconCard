/**
 * 局域网对战屏（M2-UI4）：建房 / 加入 / 等待 / 恢复。
 *
 * 发现路径（docs/protocol.md §6，浏览器侧无 mDNS 能力）：
 * - 主路径：手动 IP:port 直连 + 「扫描房间」（HTTP GET /siliconcard/rooms，net 层 fetchLanRooms）；
 * - 硬回退：手输房间码加入——两条路径常驻同一屏，扫描失败不阻塞加入。
 *
 * 等待视图展示房间码与双席位连接状态（seat_update 的 connected 字段，
 * 服务端 60s 宽限期内掉线席位可重连）；开局后帧流经 lanStore → gameStore
 * 复用 BattleScreen，本屏卸载。
 */

import { useEffect, useState } from 'react'
import { getFactionSkill } from '@siliconcard/core'
import { useLanStore } from '../store/lanStore'
import { useGameStore } from '../store/gameStore'
import { FACTION_DISPLAY } from '../game/fallbackContent'
import type { CSSProperties } from 'react'
import type { ProtocolSeat, RoomSummaryDto, SeatInfo } from '../../net'

const PHASE_LABEL: Record<RoomSummaryDto['phase'], string> = {
  lobby: '等待中',
  playing: '对局中',
  ended: '已结束',
}

function seatBadge(info: SeatInfo | null, mine: boolean, emptyLabel: string): { text: string; tone: string } {
  if (!info) return { text: emptyLabel, tone: 'is-empty' }
  if (info.kind === 'ai') return { text: `AI 托管（${info.difficulty ?? 'normal'}）`, tone: 'is-ai' }
  if (mine) return { text: info.connected ? '你 · 已连接' : '你 · 掉线重连中', tone: info.connected ? 'is-online' : 'is-offline' }
  return { text: info.connected ? '已连接' : '掉线（宽限重连中）', tone: info.connected ? 'is-online' : 'is-offline' }
}

export function LanScreen() {
  const step = useLanStore((s) => s.step)
  const goto = useGameStore((s) => s.goto)
  useEffect(() => {
    useLanStore.getState().refreshSavedFlag()
  }, [])

  return (
    <div className="sc-lan">
      <h1 className="sc-screen-title">局域网对战</h1>
      {step === 'form' ? <LanForm /> : null}
      {step === 'connecting' ? <LanConnecting /> : null}
      {step === 'lobby' ? <LanLobbyView /> : null}
      {step === 'reconnecting' ? <LanReconnecting /> : null}
      <div className="sc-setup-actions">
        <button type="button" className="sc-btn" onClick={() => goto('menu')}>
          返回主菜单
        </button>
      </div>
    </div>
  )
}

function LanForm() {
  const host = useLanStore((s) => s.host)
  const discovered = useLanStore((s) => s.discovered)
  const scanStatus = useLanStore((s) => s.scanStatus)
  const scanError = useLanStore((s) => s.scanError)
  const error = useLanStore((s) => s.error)
  const savedSession = useLanStore((s) => s.savedSession)
  const setHost = useLanStore((s) => s.setHost)
  const scanRooms = useLanStore((s) => s.scanRooms)
  const setDraftJoinCode = useLanStore((s) => s.setDraftJoinCode)
  const restoreSaved = useLanStore((s) => s.restoreSaved)

  return (
    <>
      {error ? (
        <p className="sc-lan-error" role="alert">
          ⚠ {error}
          <button type="button" className="sc-btn sc-btn--small" onClick={() => useLanStore.getState().dismissError()}>
            知道了
          </button>
        </p>
      ) : null}

      {savedSession ? (
        <section className="sc-lan-section sc-lan-restore">
          <h2>上次没退干净的房间</h2>
          <p className="sc-setup-note">
            检测到房间 <strong>{savedSession.code}</strong> 的座位凭据（座位 {savedSession.seat}）——页面刷新/意外退出后可无缝续局。
          </p>
          <button type="button" className="sc-btn sc-btn--primary" onClick={() => void restoreSaved()}>
            恢复上次对局
          </button>
        </section>
      ) : null}

      <section className="sc-lan-section">
        <h2>1 · 对方主机地址（服务端 IP:port）</h2>
        <div className="sc-lan-address-row">
          <input
            className="sc-input"
            value={host}
            placeholder="192.168.1.20:49321（或 ws://…）"
            onChange={(e) => setHost(e.target.value)}
            aria-label="服务端地址"
          />
          <button type="button" className="sc-btn" disabled={scanStatus === 'scanning' || host.trim() === ''} onClick={() => void scanRooms()}>
            {scanStatus === 'scanning' ? '扫描中…' : '扫描房间'}
          </button>
        </div>
        {scanError ? <p className="sc-setup-note sc-lan-scan-error">{scanError}</p> : null}
        {scanStatus === 'ok' ? (
          discovered.length === 0 ? (
            <p className="sc-setup-note">这台主机上暂时没有房间——可以直接在下面建一个。</p>
          ) : (
            <ul className="sc-room-list">
              {discovered.map((room) => (
                <li key={room.code} className="sc-room-item">
                  <strong className="sc-room-item-code">{room.code}</strong>
                  <span className="sc-room-item-name">{room.name}</span>
                  <span className={`sc-room-item-phase is-${room.phase}`}>{PHASE_LABEL[room.phase]}</span>
                  <span className="sc-room-item-seats">{room.openSeats} 个空位</span>
                  <button
                    type="button"
                    className="sc-btn sc-btn--small"
                    disabled={room.phase !== 'lobby' || room.openSeats === 0}
                    onClick={() => setDraftJoinCode(room.code)}
                  >
                    填入房间码
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </section>

      <LoadoutSection />

      <div className="sc-lan-columns">
        <CreateSection />
        <JoinSection />
      </div>
    </>
  )
}

/** 出装区：派系 + 卡组（建房与加入共用一套 DeckDto，协议 §3） */
function LoadoutSection() {
  const draftFaction = useLanStore((s) => s.draftFaction)
  const draftDeckId = useLanStore((s) => s.draftDeckId)
  const deckList = useGameStore((s) => s.deckList)
  const setDraftFaction = useLanStore((s) => s.setDraftFaction)
  const setDraftDeck = useLanStore((s) => s.setDraftDeck)
  return (
    <section className="sc-lan-section">
      <h2>2 · 你的出装（建房 / 加入共用）</h2>
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
              <span className="sc-faction-skill">{skill ? `${skill.skillName}（${skill.cost}W）` : '技能未注册'}</span>
            </button>
          )
        })}
      </div>
      <div className="sc-deck-picker sc-lan-deck-picker">
        <select value={draftDeckId} onChange={(e) => setDraftDeck(e.target.value)} aria-label="联机卡组">
          {deckList.map((deck) => (
            <option key={deck.id} value={deck.id}>
              {deck.name}
              {deck.degraded ? '（降级）' : ''}
            </option>
          ))}
        </select>
        <p className="sc-setup-note">卡组结构会先经服务端校验（未注册卡牌会被拒：DECK_INVALID）。</p>
      </div>
    </section>
  )
}

function CreateSection() {
  const draftRoomName = useLanStore((s) => s.draftRoomName)
  const draftFillAi = useLanStore((s) => s.draftFillAi)
  const setDraftRoomName = useLanStore((s) => s.setDraftRoomName)
  const setDraftFillAi = useLanStore((s) => s.setDraftFillAi)
  const createLanRoom = useLanStore((s) => s.createLanRoom)
  return (
    <section className="sc-lan-section sc-lan-panel">
      <h2>3a · 创建新房间（你当房主）</h2>
      <input
        className="sc-input"
        value={draftRoomName}
        placeholder="房间名（可选，如：客厅对战）"
        onChange={(e) => setDraftRoomName(e.target.value)}
        aria-label="房间名"
      />
      <label className="sc-lan-check">
        <input type="checkbox" checked={draftFillAi} onChange={(e) => setDraftFillAi(e.target.checked)} />
        空位自动交给 AI 托管（一个人也能开）
      </label>
      <button type="button" className="sc-btn sc-btn--primary" onClick={() => void createLanRoom()}>
        建房并等待对手
      </button>
    </section>
  )
}

function JoinSection() {
  const draftJoinCode = useLanStore((s) => s.draftJoinCode)
  const setDraftJoinCode = useLanStore((s) => s.setDraftJoinCode)
  const joinLanRoom = useLanStore((s) => s.joinLanRoom)
  return (
    <section className="sc-lan-section sc-lan-panel">
      <h2>3b · 加入房间（硬回退：手输房间码）</h2>
      <input
        className="sc-input sc-input--code"
        value={draftJoinCode}
        placeholder="房间码，如 A4NLN5"
        maxLength={10}
        onChange={(e) => setDraftJoinCode(e.target.value)}
        aria-label="房间码"
      />
      <p className="sc-setup-note">扫描不出来也没关系：让对方把房间码报给你，手动直连永远可用。</p>
      <button
        type="button"
        className="sc-btn sc-btn--primary"
        disabled={draftJoinCode.trim().length < 4}
        onClick={() => void joinLanRoom(draftJoinCode)}
      >
        加入房间
      </button>
    </section>
  )
}

function LanConnecting() {
  const busy = useLanStore((s) => s.busy)
  return (
    <section className="sc-lan-section sc-lan-panel sc-lan-center" role="status">
      <p className="sc-lan-big">{busy ?? '连接中…'}</p>
      <p className="sc-setup-note">正在与主机握手（协议版本校验 + 房间操作）……</p>
    </section>
  )
}

function LanLobbyView() {
  const lobby = useLanStore((s) => s.lobby)
  const busy = useLanStore((s) => s.busy)
  const error = useLanStore((s) => s.error)
  const draftAiDifficulty = useLanStore((s) => s.draftAiDifficulty)
  const setDraftAiDifficulty = useLanStore((s) => s.setDraftAiDifficulty)
  const startLanGame = useLanStore((s) => s.startLanGame)
  const addAiToSeat = useLanStore((s) => s.addAiToSeat)
  const leaveToForm = useLanStore((s) => s.leaveToForm)
  const [copied, setCopied] = useState(false)

  if (!lobby) return null
  const isHost = lobby.seat === 'P1'
  const seats = lobby.seats
  const bothSeated = seats?.P1 != null && seats?.P2 != null
  const hasEmptySeat = seats?.P1 == null || seats?.P2 == null
  const opponentSeat: ProtocolSeat = lobby.seat === 'P1' ? 'P2' : 'P1'
  const opponent = seats?.[opponentSeat] ?? null

  function copyCode() {
    if (!lobby?.roomCode) return
    void navigator.clipboard?.writeText(lobby.roomCode).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <section className="sc-lan-section sc-lan-panel sc-lan-lobby">
      <p className="sc-eyebrow">房间已就绪 · {isHost ? '你是房主' : '你是客座'}</p>
      <div className="sc-lan-code-row">
        <span className="sc-lan-code" aria-label="房间码">
          {lobby.roomCode ?? '——————'}
        </span>
        <button type="button" className="sc-btn sc-btn--small" onClick={copyCode}>
          {copied ? '已复制 ✓' : '复制房间码'}
        </button>
      </div>
      <p className="sc-setup-note">
        让对面打开「局域网对战」，地址填 <strong>{lobby.url.replace(/^ws:\/\//, '')}</strong>，再输入这个房间码即可。
      </p>

      <div className="sc-seat-row">
        {(['P1', 'P2'] as const).map((seat) => {
          const badge = seatBadge(seats?.[seat] ?? null, seat === lobby.seat, '空位')
          return (
            <div key={seat} className={`sc-seat ${badge.tone}${seat === lobby.seat ? ' is-mine' : ''}`}>
              <span className="sc-seat-name">{seat === lobby.seat ? `${seat} · 你` : `${seat} · 对手`}</span>
              <span className="sc-seat-status">{badge.text}</span>
            </div>
          )
        })}
      </div>

      {error ? <p className="sc-lan-error">⚠ {error}</p> : null}

      {isHost ? (
        <div className="sc-lan-host-actions">
          {hasEmptySeat && lobby.phase === 'lobby' ? (
            <>
              <select
                value={draftAiDifficulty}
                onChange={(e) => setDraftAiDifficulty(e.target.value as typeof draftAiDifficulty)}
                aria-label="AI 难度"
              >
                <option value="easy">AI：试试看</option>
                <option value="normal">AI：老装机猿</option>
                <option value="hard">AI：超频狂人</option>
              </select>
              <button type="button" className="sc-btn" disabled={busy !== null} onClick={() => void addAiToSeat()}>
                {busy ?? '让 AI 坐空位'}
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="sc-btn sc-btn--primary"
            disabled={!bothSeated || lobby.phase !== 'lobby' || busy !== null}
            title={bothSeated ? undefined : '等对手就座（或先让 AI 托管空位）'}
            onClick={() => void startLanGame()}
          >
            开始对局
          </button>
        </div>
      ) : (
        <p className="sc-lan-big" role="status">
          {opponent && opponent.kind === 'ai' && !bothSeated
            ? 'AI 托管已就座，等房主开局…'
            : '已入座——等房主点「开始对局」…'}
        </p>
      )}

      <button type="button" className="sc-btn sc-btn--small sc-btn--danger sc-lan-leave" onClick={() => void leaveToForm()}>
        离开房间
      </button>
    </section>
  )
}

function LanReconnecting() {
  const reconnectAttempt = useLanStore((s) => s.reconnectAttempt)
  const lobby = useLanStore((s) => s.lobby)
  const leaveToForm = useLanStore((s) => s.leaveToForm)
  return (
    <section className="sc-lan-section sc-lan-panel sc-lan-center" role="status">
      <p className="sc-lan-big">连接断了——正在重连…（第 {reconnectAttempt} 次尝试）</p>
      <p className="sc-setup-note">
        房间 {lobby?.roomCode ?? ''} 还在服务端等你（宽限期 60 秒）。恢复后自动续局，无需重新加入。
      </p>
      <button type="button" className="sc-btn sc-btn--small sc-btn--danger" onClick={() => void leaveToForm()}>
        放弃并返回
      </button>
    </section>
  )
}
