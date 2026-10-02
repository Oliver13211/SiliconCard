/**
 * initGame —— 开局构建（docs/rules.md §2.1）。
 *
 * 顺序：卡组校验（总数 = DECK_SIZE、cardId 已注册且定义合法，否则 DECK_INVALID）
 * → 按 seed 洗双方牌库（先 P1 后 P2）→ 交替发起手（P1 先抽，各 OPENING_HAND_SIZE 张）
 * → GAME_START → 进入 P1 的第 1 回合。
 *
 * 注：M0 引擎接口 `initGame(setup): GameState` 不携带事件流，因此 GAME_START 与首个
 * TURN_START（turn 1, drawCount 0）仅按序内部构造、不对外发出；消费方可由初始 state
 * 合成（seed / turn / activePlayer / maxMana 等字段齐备）。接口是否改为返回事件流
 * 属契约级决策，留待 M1-ENG7（回放序列化）一并裁决。
 */

import {
  DECK_SIZE,
  FIRST_PLAYER,
  HERO_MAX_HEALTH,
  OPENING_HAND_SIZE,
} from '../constants'
import { RuleError } from '../engine'
import type { GameEvent } from '../types/events'
import type { DeckEntry, GameSetup, GameState, PlayerSetup, PlayerState } from '../types/state'
import { beginTurn, drawCard } from './turn'
import type { Rng } from './prng'
import { createRng } from './prng'
import { findCardDefinitionIssues, getCardDefinition } from './registry'

export function initGame(setup: GameSetup): GameState {
  if (!setup || !setup.players || setup.players.length !== 2) {
    throw new RuleError('DECK_INVALID', '对局配置需要恰好两名玩家')
  }
  const [p1Setup, p2Setup] = setup.players
  validateSetupPosition(p1Setup, 'P1')
  validateSetupPosition(p2Setup, 'P2')
  validateDeck(p1Setup)
  validateDeck(p2Setup)

  const events: GameEvent[] = []
  const rng = createRng(setup.seed >>> 0)

  const state: GameState = {
    turn: 0,
    activePlayer: FIRST_PLAYER,
    phase: 'main',
    players: {
      P1: buildPlayerState(p1Setup, rng),
      P2: buildPlayerState(p2Setup, rng),
    },
    board: [],
    nextInstanceId: 1,
    rng: { state: rng.getState() },
    winner: null,
    endReason: null,
  }

  dealOpeningHands(state, events)
  events.push({ type: 'GAME_START', seed: setup.seed, firstPlayer: FIRST_PLAYER })
  // 进入 P1 的第 1 回合：复用回合开始序列（turn 0 → 1，P1 首回合不抽牌）
  beginTurn(state, FIRST_PLAYER, events)
  return state
}

function validateSetupPosition(player: PlayerSetup, expected: PlayerSetup['id']): void {
  if (!player || player.id !== expected) {
    throw new RuleError('DECK_INVALID', `players 中的玩家 id 必须按位对应 ${expected}`, {
      expected,
      actual: player?.id,
    })
  }
}

/**
 * 卡组校验（§2.1 + M1-ENG2 registry 补强）：展开后总数必须等于 DECK_SIZE，
 * 每条数量为正整数，且每张 cardId 已注册、定义通过 findCardDefinitionIssues 结构校验。
 */
function validateDeck(player: PlayerSetup): void {
  if (!player.deck || !Array.isArray(player.deck.cards)) {
    throw new RuleError('DECK_INVALID', `${player.id}: 卡组定义缺失`, { playerId: player.id })
  }
  let total = 0
  for (const entry of player.deck.cards) {
    if (!Number.isInteger(entry.count) || entry.count <= 0) {
      throw new RuleError('DECK_INVALID', `${player.id}: 卡牌 ${entry.cardId} 的数量必须为正整数`, {
        playerId: player.id,
        cardId: entry.cardId,
        count: entry.count,
      })
    }
    const def = getCardDefinition(entry.cardId)
    if (!def) {
      throw new RuleError('DECK_INVALID', `${player.id}: 卡牌 ${entry.cardId} 未注册定义`, {
        playerId: player.id,
        cardId: entry.cardId,
        reason: 'unregistered',
      })
    }
    const issue = findCardDefinitionIssues(def)
    if (issue) {
      throw new RuleError('DECK_INVALID', `${player.id}: 卡牌 ${entry.cardId} 定义不合法：${issue}`, {
        playerId: player.id,
        cardId: entry.cardId,
        reason: issue,
      })
    }
    total += entry.count
  }
  if (total !== DECK_SIZE) {
    throw new RuleError('DECK_INVALID', `${player.id}: 卡组总数必须为 ${DECK_SIZE}，实际 ${total}`, {
      playerId: player.id,
      total,
    })
  }
}

function buildPlayerState(player: PlayerSetup, rng: Rng): PlayerState {
  const deck: DeckEntry[] = []
  for (const entry of player.deck.cards) {
    for (let i = 0; i < entry.count; i++) deck.push({ cardId: entry.cardId })
  }
  rng.shuffle(deck)
  return {
    id: player.id,
    faction: player.faction,
    heroName: player.heroName ?? 'CPU',
    health: HERO_MAX_HEALTH,
    maxHealth: HERO_MAX_HEALTH,
    armor: 0,
    mana: 0,
    maxMana: 0,
    lockedMana: 0,
    deck,
    hand: [],
    graveyard: [],
    fatigue: 0,
    heroPowerUsed: false,
  }
}

/** 起手发牌：P1 先抽、双方交替，各 OPENING_HAND_SIZE 张（uid 按发牌顺序全局唯一） */
function dealOpeningHands(state: GameState, events: GameEvent[]): void {
  for (let round = 0; round < OPENING_HAND_SIZE; round++) {
    drawCard(state, 'P1', events)
    drawCard(state, 'P2', events)
  }
}
