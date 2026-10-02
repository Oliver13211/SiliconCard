/**
 * viewFor —— 视角裁剪（docs/rules.md §10）。
 *
 * - 自己：完整 hand（uid/cardId/cost）+ 全部公开数值；
 * - 对手：仅 PublicPlayerState（handSize/deckSize/graveyardSize 计数，不含内容）；
 * - 双方：board 全量（场上单位本就公开）；
 * - 永不泄露：对手手牌内容、牌库顺序、rng.state。
 */

import type { GameState, PlayerId, PlayerState, PlayerView, PublicPlayerState } from '../types/state'

export function toPublicPlayer(player: PlayerState): PublicPlayerState {
  return {
    id: player.id,
    faction: player.faction,
    heroName: player.heroName,
    health: player.health,
    maxHealth: player.maxHealth,
    armor: player.armor,
    mana: player.mana,
    maxMana: player.maxMana,
    handSize: player.hand.length,
    deckSize: player.deck.length,
    graveyardSize: player.graveyard.length,
    fatigue: player.fatigue,
    heroPowerUsed: player.heroPowerUsed,
  }
}

export function viewFor(state: Readonly<GameState>, playerId: PlayerId): PlayerView {
  const opponentId: PlayerId = playerId === 'P1' ? 'P2' : 'P1'
  const you = state.players[playerId]
  const opponent = state.players[opponentId]
  return {
    viewer: playerId,
    turn: state.turn,
    phase: state.phase,
    activePlayer: state.activePlayer,
    winner: state.winner,
    you: { ...toPublicPlayer(you), hand: you.hand },
    opponent: toPublicPlayer(opponent),
    board: state.board,
  }
}
