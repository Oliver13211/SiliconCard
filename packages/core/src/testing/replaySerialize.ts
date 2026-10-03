/**
 * 回放序列化（M1-ENG7）—— ReplayRecording ⇄ JSON 双向转换（rules.md §12）。
 *
 * 「seed + actions 存档 / 分享 / 回放」的地基：存档格式 = canonicalJson 确定性输出
 * （键递归排序、剔除 undefined、拒绝 Map/Set/NaN/Infinity，见 hash.ts），
 * 同一录制永远产出逐字节相同的 JSON 文本——存档可直接进 git / 经网络传输 /
 * 按内容寻址，回放结果跨端一致。
 *
 * 校验策略（反序列化是总闸门）：
 * - 只做**结构校验**，不做规则校验——卡组总数、派系注册等语义合法性仍由 initGame
 *   的 DECK_INVALID / FACTION_UNREGISTERED 把关（职责分离：存档格式与规则版本解耦）；
 * - 严格拒绝未知字段（含 action / target / player / 卡组条目各层）：拼错字段的存档
 *   静默丢失字段会无声改变回放语义，必须显式报错；
 * - 错误一律为可读 Error，携带 JSON 路径与原因（供 UI 提示 / Agent 自查）；
 *   不抛 RuleError——存档损坏是数据问题，不是对局内可纠正的非法动作。
 *
 * 导出面 additive：既有 recordReplay / runReplay / assertGoldenReplay 语义不变。
 */

import type { Action } from '../types/actions'
import type { GameSetup } from '../types/state'
import { canonicalJson } from './hash'
import type { ReplayRecording } from './replay'

/** 存档 schema 版本：字段结构或校验规则破坏性变化时 +1（v1 = M1-ENG7 定稿） */
export const REPLAY_SCHEMA_VERSION = 1

const PLAYER_IDS = ['P1', 'P2'] as const
const ACTION_TYPES = ['PLAY_CARD', 'ATTACK', 'USE_HERO_POWER', 'END_TURN', 'CONCEDE'] as const

/** 序列化：校验 → canonicalJson。同一录制输出逐字节相同（§12 存档确定性） */
export function serializeReplay(recording: ReplayRecording): string {
  return canonicalJson(validateReplayValue(toSerializedValue(recording), '<recording>'))
}

/** 反序列化：JSON.parse → 结构校验 → ReplayRecording；错误消息可读、带路径 */
export function deserializeReplay(json: string): ReplayRecording {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (error) {
    throw new Error(`回放反序列化失败：非法 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
  const validated = validateReplayValue(value, '<root>')
  return {
    seed: validated.seed,
    players: validated.players as GameSetup['players'],
    actions: validated.actions as readonly Action[],
  }
}

// —— 内部：以「已校验」形态在 validate 与 canonicalJson 间传递 ——

interface SerializedReplayValue {
  schemaVersion: number
  seed: number
  players: readonly unknown[]
  actions: readonly unknown[]
}

function toSerializedValue(recording: ReplayRecording): SerializedReplayValue {
  return {
    schemaVersion: REPLAY_SCHEMA_VERSION,
    seed: recording.seed,
    players: recording.players,
    actions: recording.actions,
  }
}

function fail(path: string, reason: string): never {
  throw new Error(`回放反序列化失败（${path}）：${reason}`)
}

function asObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, '应为对象')
  }
  return value as Record<string, unknown>
}

/** 严格未知字段拒绝：存档字段拼错必须显式失败，不允许静默丢弃。
 * 值为 undefined 的键视为不存在（与 canonicalJson 的 undefined 剔除语义一致，
 * 保证「内存对象显式携带 target: undefined」与「不携带该键」序列化等价）。 */
function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) continue
    if (!allowed.includes(key)) {
      fail(path, `未知字段「${key}」（允许：${allowed.join('、')}）`)
    }
  }
}

function asNonEmptyString(value: unknown, path: string, field: string): string {
  if (typeof value !== 'string' || !value) fail(path, `${field} 必须为非空字符串`)
  return value
}

function asUint32(value: unknown, path: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail(path, `${field} 必须为 0..4294967295 的整数`)
  }
  return value
}

/**
 * 结构校验入口：接受任意来源（JSON.parse 产物 / 录制对象），完整校验后原样返回。
 * 只校验结构与字面量域，不校验规则语义（见文件头职责分离说明）。
 */
function validateReplayValue(value: unknown, path: string): SerializedReplayValue {
  const root = asObject(value, path)
  checkKeys(root, ['schemaVersion', 'seed', 'players', 'actions'], path)

  const schemaVersion = root.schemaVersion
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) {
    fail(`${path}.schemaVersion`, '必须为整数')
  }
  if (schemaVersion !== REPLAY_SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `不支持的存档版本 ${schemaVersion}（当前支持 ${REPLAY_SCHEMA_VERSION}；请升级 core 或使用对应版本回放）`)
  }

  const seed = asUint32(root.seed, `${path}.seed`, 'seed')

  const rawPlayers = root.players
  if (!Array.isArray(rawPlayers) || rawPlayers.length !== 2) {
    fail(`${path}.players`, '必须为恰好两名玩家的数组')
  }
  const players = rawPlayers.map((player, index) =>
    validatePlayer(player, `${path}.players[${index}]`, PLAYER_IDS[index] as string),
  )

  const rawActions = root.actions
  if (!Array.isArray(rawActions)) fail(`${path}.actions`, '必须为数组')
  const actions = rawActions.map((action, index) => validateAction(action, `${path}.actions[${index}]`))

  return { schemaVersion, seed, players, actions }
}

function validatePlayer(value: unknown, path: string, expectedId: string): unknown {
  const player = asObject(value, path)
  checkKeys(player, ['id', 'faction', 'heroName', 'deck'], path)
  const id = asNonEmptyString(player.id, `${path}.id`, 'id')
  if (id !== expectedId) fail(`${path}.id`, `玩家 id 必须按位对应 ${expectedId}，收到 ${id}`)
  asNonEmptyString(player.faction, `${path}.faction`, 'faction')
  if (player.heroName !== undefined) asNonEmptyString(player.heroName, `${path}.heroName`, 'heroName')
  const deck = asObject(player.deck, `${path}.deck`)
  checkKeys(deck, ['cards'], `${path}.deck`)
  if (!Array.isArray(deck.cards)) fail(`${path}.deck.cards`, '必须为数组')
  deck.cards.forEach((card, index) => {
    const entry = asObject(card, `${path}.deck.cards[${index}]`)
    checkKeys(entry, ['cardId', 'count'], `${path}.deck.cards[${index}]`)
    asNonEmptyString(entry.cardId, `${path}.deck.cards[${index}].cardId`, 'cardId')
    const count = entry.count
    if (typeof count !== 'number' || !Number.isInteger(count) || count <= 0) {
      fail(`${path}.deck.cards[${index}].count`, 'count 必须为正整数')
    }
  })
  return player
}

function validateAction(value: unknown, path: string): unknown {
  const action = asObject(value, path)
  const type = action.type
  if (typeof type !== 'string' || !(ACTION_TYPES as readonly string[]).includes(type)) {
    fail(`${path}.type`, `未知动作类型 ${JSON.stringify(type) ?? 'undefined'}（允许：${ACTION_TYPES.join('、')}）`)
  }
  const playerId = action.playerId
  if (typeof playerId !== 'string' || !(PLAYER_IDS as readonly string[]).includes(playerId)) {
    fail(`${path}.playerId`, `playerId 必须为 ${PLAYER_IDS.join('或')}`)
  }
  switch (type) {
    case 'PLAY_CARD':
      checkKeys(action, ['type', 'playerId', 'uid', 'target'], path)
      asNonEmptyString(action.uid, `${path}.uid`, 'uid')
      if (action.target !== undefined) validateTarget(action.target, `${path}.target`)
      break
    case 'ATTACK':
      checkKeys(action, ['type', 'playerId', 'attackerId', 'target'], path)
      asNonEmptyString(action.attackerId, `${path}.attackerId`, 'attackerId')
      if (action.target === undefined) fail(`${path}.target`, 'ATTACK 必须携带 target')
      validateTarget(action.target, `${path}.target`)
      break
    case 'USE_HERO_POWER':
      checkKeys(action, ['type', 'playerId', 'target'], path)
      if (action.target !== undefined) validateTarget(action.target, `${path}.target`)
      break
    case 'END_TURN':
    case 'CONCEDE':
      checkKeys(action, ['type', 'playerId'], path)
      break
  }
  return action
}

function validateTarget(value: unknown, path: string): void {
  const target = asObject(value, path)
  const kind = target.kind
  if (kind === 'unit') {
    checkKeys(target, ['kind', 'instanceId'], path)
    asNonEmptyString(target.instanceId, `${path}.instanceId`, 'instanceId')
    return
  }
  if (kind === 'hero') {
    checkKeys(target, ['kind', 'playerId'], path)
    const playerId = target.playerId
    if (typeof playerId !== 'string' || !(PLAYER_IDS as readonly string[]).includes(playerId)) {
      fail(`${path}.playerId`, `playerId 必须为 ${PLAYER_IDS.join('或')}`)
    }
    return
  }
  fail(`${path}.kind`, `未知目标类型 ${JSON.stringify(kind) ?? 'undefined'}（允许：unit、hero）`)
}
