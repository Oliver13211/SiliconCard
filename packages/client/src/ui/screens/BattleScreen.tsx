/**
 * 对战界面（M1-UI1 HUD + M1-UI2 出牌/目标选择流 + M2-UI4 联机复用）。
 *
 * 布局：右侧战报日志；主区自上而下 = 对手面板 → 3D 牌桌挂载点（占位，DOM 棋盘
 * 覆盖其上）→ 己方面板 + 手牌 + 技能/回合按钮。
 *
 * 交互语义（全部由 getLegalActions 驱动）：
 * - 手牌点击：无需目标的牌直接打出；需要目标则进入 target 模式（高亮候选）；
 * - 己方单位点击：宣告攻击（进入目标选择）；候选目标点击：确认；
 * - ESC / 取消按钮退出目标选择；非法操作按钮禁用并标注梗化原因；
 * - 单机：对面回合由「简易托管」按节拍自动推进（botTick）；
 * - 联机（remoteMode）：动作经服务端结算、事件由 events 帧推送——botTick 停用，
 *   断线时盖重连提示层（服务端宽限期内 resume 无缝续局），对手掉线时挂提示横幅。
 */

import { useEffect } from 'react'
import { getFactionSkill, type BoardUnit, type PlayerId } from '@siliconcard/core'
import { useGameStore, type TargetingState } from '../store/gameStore'
import { useLanStore } from '../store/lanStore'
import { BattleLog } from '../components/BattleLog'
import { ErrorToast } from '../components/ErrorToast'
import { PlayerPanel } from '../components/PlayerPanel'
import { HandCardView } from '../components/HandCardView'
import { UnitCardView } from '../components/UnitCardView'
import { Table3DMount } from '../components/Table3DMount'
import {
  attackStatusOf,
  endTurnStatus,
  handCardStatus,
  heroPowerStatus,
  targetKey,
  type Interactivity,
} from '../game/legal'
import type { PlayerView, TargetRef } from '@siliconcard/core'

export function BattleScreen() {
  const view = useGameStore((s) => s.view)
  const interactivity = useGameStore((s) => s.interactivity)
  const targeting = useGameStore((s) => s.targeting)
  const contentNotice = useGameStore((s) => s.contentNotice)
  const remoteMode = useGameStore((s) => s.remoteMode)
  const tryPlayCard = useGameStore((s) => s.tryPlayCard)
  const tryAttack = useGameStore((s) => s.tryAttack)
  const tryHeroPower = useGameStore((s) => s.tryHeroPower)
  const endTurn = useGameStore((s) => s.endTurn)
  const concede = useGameStore((s) => s.concede)
  const confirmTarget = useGameStore((s) => s.confirmTarget)
  const cancelTargeting = useGameStore((s) => s.cancelTargeting)
  const openRules = useGameStore((s) => s.openRules)

  // 对面回合：简易托管按节拍推进（每次 view 变化重新调度；P1 回合不挂定时器）。
  // 联机模式停用：对面（人类或服务端 AI）的动作由 events 帧推送，本地不代打。
  useEffect(() => {
    if (remoteMode) return
    if (!view || view.phase === 'ended') return
    if (view.activePlayer === view.viewer) return
    const timer = setTimeout(() => useGameStore.getState().botTick(), 700)
    return () => clearTimeout(timer)
  }, [view, remoteMode])

  // ESC 取消目标选择
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelTargeting()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cancelTargeting])

  if (!view || !interactivity) return null
  return (
    <BattleInner
      view={view}
      interactivity={interactivity}
      targeting={targeting}
      contentNotice={contentNotice}
      remoteMode={remoteMode}
      tryPlayCard={tryPlayCard}
      tryAttack={tryAttack}
      tryHeroPower={tryHeroPower}
      endTurn={endTurn}
      concede={concede}
      confirmTarget={confirmTarget}
      cancelTargeting={cancelTargeting}
      openRules={openRules}
    />
  )
}

interface BattleInnerProps {
  view: PlayerView
  interactivity: Interactivity
  targeting: TargetingState | null
  contentNotice: string | null
  remoteMode: boolean
  tryPlayCard: (uid: string) => void
  tryAttack: (attackerId: string) => void
  tryHeroPower: () => void
  endTurn: () => void
  concede: () => void
  confirmTarget: (target: TargetRef) => void
  cancelTargeting: () => void
  openRules: () => void
}

function BattleInner(props: BattleInnerProps) {
  const {
    view,
    interactivity,
    targeting,
    contentNotice,
    remoteMode,
    tryPlayCard,
    tryAttack,
    tryHeroPower,
    endTurn,
    concede,
    confirmTarget,
    cancelTargeting,
    openRules,
  } = props

  const targetKeys = new Set((targeting?.targets ?? []).map(targetKey))
  const ownUnits = view.board.filter((u) => u.ownerId === view.viewer)
  const enemyUnits = view.board.filter((u) => u.ownerId !== view.viewer)
  const ownSlots = `${ownUnits.length}/7`

  // —— 联机状态（M2-UI4）：重连提示层 + 对手掉线横幅（seat_update.connected 数据源） ——
  const lanStep = useLanStore((s) => s.step)
  const lanLobby = useLanStore((s) => s.lobby)
  const reconnectAttempt = useLanStore((s) => s.reconnectAttempt)
  const mySeat = lanLobby?.seat ?? null
  const opponentSeat = mySeat === 'P1' ? 'P2' : mySeat === 'P2' ? 'P1' : null
  const opponentInfo = opponentSeat ? (lanLobby?.seats?.[opponentSeat] ?? null) : null
  const opponentOffline = remoteMode && lanStep === 'lobby' && opponentInfo?.kind === 'human' && !opponentInfo.connected

  const skill = getFactionSkill(view.you.faction)
  const heroPower = heroPowerStatus(view, interactivity)
  const endTurnAvail = endTurnStatus(interactivity)
  const selectedUid = targeting?.kind === 'play' ? targeting.uid : null

  function onUnitClick(unit: BoardUnit) {
    const key = targetKey({ kind: 'unit', instanceId: unit.instanceId })
    if (targeting) {
      if (targetKeys.has(key)) confirmTarget({ kind: 'unit', instanceId: unit.instanceId })
      return
    }
    if (unit.ownerId === view.viewer) tryAttack(unit.instanceId)
  }

  function onHeroClick(playerId: PlayerId) {
    const key = targetKey({ kind: 'hero', playerId })
    if (targeting && targetKeys.has(key)) confirmTarget({ kind: 'hero', playerId })
  }

  function renderUnits(units: readonly BoardUnit[], side: 'own' | 'enemy') {
    if (units.length === 0) {
      return <span className="sc-board-empty">{side === 'own' ? '你的扩展槽空着（0/7）' : '对面扩展槽空着'}</span>
    }
    return units.map((unit) => {
      const key = targetKey({ kind: 'unit', instanceId: unit.instanceId })
      const status =
        unit.ownerId === view.viewer ? attackStatusOf(view, interactivity, unit) : { available: false as const }
      return (
        <UnitCardView
          key={unit.instanceId}
          unit={unit}
          targetable={targetKeys.has(key)}
          selectable={!targeting && unit.ownerId === view.viewer && status.available}
          onClick={() => onUnitClick(unit)}
        />
      )
    })
  }

  return (
    <div className="sc-battle">
      <BattleLog />
      <main className="sc-arena">
        <header className="sc-zone sc-zone--opponent">
          <div
            className={`sc-hero-hitbox${targetKeys.has(targetKey({ kind: 'hero', playerId: view.opponent.id })) ? ' is-targetable' : ''}`}
            onClick={() => onHeroClick(view.opponent.id)}
          >
            <PlayerPanel player={view.opponent} side="opponent" />
          </div>
          <div className={`sc-turn-pill${view.activePlayer === view.viewer ? ' is-mine' : ''}`}>
            {view.phase === 'ended' ? '对局结束' : view.activePlayer === view.viewer ? '你的回合' : '对面回合中…'}
          </div>
        </header>

        <section className="sc-stage">
          <Table3DMount />
          {opponentOffline ? (
            <div className="sc-net-banner" role="status">
              ⚡ 对面掉线了——等 TA 插回电源（服务端宽限 60s，回来自动续局）
            </div>
          ) : null}
          <div className="sc-board" aria-label="扩展槽棋盘（DOM 覆盖层）">
            <div className="sc-board-row is-enemy">{renderUnits(enemyUnits, 'enemy')}</div>
            <div className="sc-board-divider" />
            <div className="sc-board-row is-own">{renderUnits(ownUnits, 'own')}</div>
          </div>
          {contentNotice ? <p className="sc-notice">{contentNotice}</p> : null}
          {targeting ? (
            <div className="sc-target-bar" role="status">
              <span>
                {targeting.kind === 'play' ? '为目标选一个对象' : targeting.kind === 'attack' ? '选攻击目标' : '为技能选目标'}
                （{targeting.targets.length} 个候选）
              </span>
              <button type="button" className="sc-btn sc-btn--small" onClick={cancelTargeting}>
                取消（ESC）
              </button>
            </div>
          ) : null}
        </section>

        <footer className="sc-zone sc-zone--self">
          <div className="sc-self-row">
            <div
              className={`sc-hero-hitbox${targetKeys.has(targetKey({ kind: 'hero', playerId: view.viewer })) ? ' is-targetable' : ''}`}
              onClick={() => onHeroClick(view.viewer)}
            >
              <PlayerPanel player={view.you} side="self" slotUsage={ownSlots} />
            </div>
            <div className="sc-actions">
              <button
                type="button"
                className={`sc-btn sc-btn--power${heroPower.available ? ' is-ready' : ' is-disabled'}`}
                disabled={!heroPower.available}
                title={heroPower.reason ?? `${skill?.skillName ?? '技能'}（${skill?.cost ?? 200}W）`}
                onClick={tryHeroPower}
              >
                <strong>{skill?.skillName ?? '技能'}</strong>
                <span>{view.you.heroPowerUsed ? '已交' : `${skill?.cost ?? 200}W`}</span>
              </button>
              <button
                type="button"
                className="sc-btn sc-btn--primary sc-btn--turn"
                disabled={!endTurnAvail.available}
                title={endTurnAvail.reason}
                onClick={endTurn}
              >
                {view.activePlayer === view.viewer ? '结束回合' : '对面回合中…'}
              </button>
              <button type="button" className="sc-btn sc-btn--small" onClick={openRules}>
                规则
              </button>
              <button
                type="button"
                className="sc-btn sc-btn--small sc-btn--danger"
                onClick={() => {
                  if (window.confirm('确定拔电源认输？')) concede()
                }}
              >
                认输
              </button>
            </div>
          </div>
          <div className="sc-hand" aria-label="手牌">
            {view.you.hand.length === 0 ? (
              <span className="sc-board-empty">手牌空了——等下回合抽卡</span>
            ) : (
              view.you.hand.map((card) => (
                <HandCardView
                  key={card.uid}
                  card={card}
                  status={handCardStatus(view, interactivity, card)}
                  selected={selectedUid === card.uid}
                  onClick={() => tryPlayCard(card.uid)}
                />
              ))
            )}
          </div>
        </footer>
      </main>
      {remoteMode && lanStep === 'reconnecting' ? (
        <div className="sc-net-overlay" role="status">
          <div className="sc-net-overlay-card">
            <p className="sc-net-overlay-title">连接断了——正在重连…（第 {reconnectAttempt} 次尝试）</p>
            <p className="sc-setup-note">
              房间 {lanLobby?.roomCode ?? ''} 还在服务端等你（宽限 60s）。恢复后本局无缝继续，手牌与局势自动对齐。
            </p>
            <div className="sc-net-overlay-actions">
              <button type="button" className="sc-btn sc-btn--small sc-btn--danger" onClick={() => void useLanStore.getState().leaveAndBackToMenu()}>
                放弃对局，回主菜单
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <ErrorToast />
    </div>
  )
}
