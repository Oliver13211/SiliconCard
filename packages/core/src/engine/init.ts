/**
 * initGame —— 开局构建（docs/rules.md §2.1）。
 *
 * 顺序：卡组校验（总数 = DECK_SIZE、cardId 已注册且定义合法，否则 DECK_INVALID）
 * → 派系技能校验（双方 faction 均已注册且定义合法，M1-ENG5，见 factions.ts）
 * → 按 seed 洗双方牌库（先 P1 后 P2）→ 交替发起手（P1 先抽，各 OPENING_HAND_SIZE 张）
 * → GAME_START → 进入 P1 的第 1 回合。
 *
 * 注（initGame 签名裁决，M1-ENG7 契约评审定稿）：**维持 `initGame(setup): GameState`
 * 只返回 state、不携带事件流**——GAME_START 与首个 TURN_START（turn 1, drawCount 0）
 * 仅按序内部构造、不对外发出。裁决理由（详见 M1-ENG7 汇报与 rules.md §2.1/§6）：
 * ① 四函数接口是架构铁律级稳定契约，server/cli/ai 均按现签名消费，破坏性变更收益不成比例；
 * ② GAME_START 所需字段（seed / firstPlayer / activePlayer / turn）与首个 TURN_START 的
 *    maxMana/drawCount 在初始 state 齐备，消费方可按 §2.2 恒等式合成，无信息增量；
 * ③ 回放序列化（M1-ENG7 交付）以 seed+actions 为唯一存档事实，开局事件可由回放器确定性重建。
 * rules.md §6 GAME_START「发出时机」按此裁定解读为语义时点（initGame 完成），非 API 承诺。
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
import { findFactionSkillIssues, getFactionSkill } from './factions'
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
  validateFactionSkill(p1Setup)
  validateFactionSkill(p2Setup)

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
  // 进入 P1 的第 1 回合：复用回合开始序列（turn 0 → 1，P1 首回合不抽牌；
  // 场上无单位，turnStart 触发自然为空）
  beginTurn(state, FIRST_PLAYER, events, rng)
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

/**
 * 派系技能校验（§4「派系技能不是卡牌」+ §3 USE_HERO_POWER，M1-ENG5）：
 * 双方 faction 必须已注册技能且定义通过 findFactionSkillIssues 结构校验，否则开局拒绝。
 * 错误码（M1-ENG7 additive 扩容，契约评审授权项）：未注册 → 专属 FACTION_UNREGISTERED
 * （替换 ENG5 对 DECK_INVALID 的语义借位，detail.reason='faction_skill_unregistered' 机读兼容）；
 * 已注册但定义不合法仍为 DECK_INVALID{reason:'faction_skill_invalid'}（结构校验属卡组数据问题）。
 */
function validateFactionSkill(player: PlayerSetup): void {
  const skill = getFactionSkill(player.faction)
  if (!skill) {
    throw new RuleError(
      'FACTION_UNREGISTERED',
      `${player.id}: 派系 ${player.faction} 未注册派系技能（宿主需先 registerFactionSkills）`,
      { playerId: player.id, factionId: player.faction, reason: 'faction_skill_unregistered' },
    )
  }
  const issue = findFactionSkillIssues(skill)
  if (issue) {
    throw new RuleError('DECK_INVALID', `${player.id}: 派系 ${player.faction} 技能定义不合法：${issue}`, {
      playerId: player.id,
      factionId: player.faction,
      reason: 'faction_skill_invalid',
      issue,
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
