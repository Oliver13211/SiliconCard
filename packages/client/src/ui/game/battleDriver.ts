/**
 * BattleDriver —— 引擎唯一事实源的持有封装（M1-UI1..3）。
 *
 * 职责边界（架构铁律 3）：
 * - 完整 GameState 只在本模块内流转，zustand store / 组件只拿 viewFor 视图、
 *   getLegalActions 合法动作与 GameEvent 事件流，禁止自维护对局事实；
 * - initGame 不携带事件流（rules.md §2.1 签名裁决）：GAME_START 与首个 TURN_START
 *   由本模块按初始 state 合成（§6：无信息增量，字段齐备）。
 */

import {
  createEngine,
  FIRST_PLAYER,
  type Action,
  type Engine,
  type GameEvent,
  type GameSetup,
  type GameState,
  type PlayerId,
  type PlayerView,
} from '@siliconcard/core'

export interface DispatchReport {
  view: PlayerView
  legalActions: readonly Action[]
  events: readonly GameEvent[]
}

export interface OpeningReport extends DispatchReport {
  openingEvents: readonly GameEvent[]
}

let engineInstance: Engine | null = null

function engine(): Engine {
  engineInstance ??= createEngine()
  return engineInstance
}

export class BattleDriver {
  private state: GameState | null = null
  private readonly viewerId: PlayerId

  constructor(viewer: PlayerId = FIRST_PLAYER) {
    this.viewerId = viewer
  }

  /** 开局：构建初始状态 + 合成开局事件（§2.1/§6） */
  start(setup: GameSetup): OpeningReport {
    const state = engine().initGame(setup)
    this.state = state
    const active = state.players[state.activePlayer]
    const openingEvents: GameEvent[] = [
      { type: 'GAME_START', seed: setup.seed, firstPlayer: state.activePlayer },
      {
        type: 'TURN_START',
        turn: state.turn,
        playerId: state.activePlayer,
        maxMana: active.maxMana,
        drawCount: 0,
      },
    ]
    return {
      openingEvents,
      events: openingEvents,
      view: engine().viewFor(state, this.viewerId),
      legalActions: engine().getLegalActions(state, this.viewerId),
    }
  }

  /** 结算一个动作；非法动作原样抛出 RuleError，状态保持不变（引擎保证） */
  dispatch(action: Action): DispatchReport {
    if (!this.state) throw new Error('对局尚未开始，不能结算动作')
    const { state, events } = engine().applyAction(this.state, action)
    this.state = state
    return {
      events,
      view: engine().viewFor(state, this.viewerId),
      legalActions: engine().getLegalActions(state, this.viewerId),
    }
  }

  /** 指定玩家的合法动作（托管占位 bot 用，仍走引擎公开接口） */
  legalActionsFor(playerId: PlayerId): readonly Action[] {
    if (!this.state) return []
    return engine().getLegalActions(this.state, playerId)
  }

  view(): PlayerView | null {
    if (!this.state) return null
    return engine().viewFor(this.state, this.viewerId)
  }

  isEnded(): boolean {
    return this.state?.phase === 'ended'
  }

  get viewer(): PlayerId {
    return this.viewerId
  }

  reset(): void {
    this.state = null
  }
}
