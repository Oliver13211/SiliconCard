/**
 * 快捷键命令注册表（P2-UI5）——命令与键位解耦的"命令"半边。
 *
 * 命令集是固定的（新增命令=改这里 + 默认键位表），键位可自定义；
 * 回放屏尚未落地（P2-UI3），replay_* 命令在此先注册占位，
 * 回放代理只需在自己的屏里挂 useKeyCommands({ replay_play_pause: … }) 即可消费。
 *
 * scope 语义（对战与回放键位分离互不干扰，phase2-plan P2-UI5 §5）：
 * - 同一物理按键允许同时绑定两个 scope 不相交的命令（如 空格=对局结束回合 / 回放播放暂停）；
 * - 冲突检测按 scope 交集判定（见 bindings.ts），global 命令与所有 scope 相交；
 * - 消费端（各屏）只挂自己 scope + global 的 handler，天然互不干扰。
 */

export type CommandId =
  | 'play_slot_1'
  | 'play_slot_2'
  | 'play_slot_3'
  | 'play_slot_4'
  | 'play_slot_5'
  | 'play_slot_6'
  | 'play_slot_7'
  | 'play_slot_8'
  | 'play_slot_9'
  | 'play_slot_10'
  | 'end_turn'
  | 'hero_power'
  | 'cycle_target'
  | 'confirm'
  | 'cancel'
  | 'fast_forward'
  | 'mute'
  | 'toggle_key_hints'
  | 'help'
  | 'replay_play_pause'
  | 'replay_step'
  | 'replay_speed'

/** 命令生效的界面域：battle=对局 / replay=回放 / global=处处生效 */
export type KeyScope = 'battle' | 'replay' | 'global'

export interface CommandDef {
  id: CommandId
  /** 编辑器/键位表里的命令名（梗化但不牺牲可读性） */
  label: string
  /** 一句话说明（键位表 hover / 编辑器行注释） */
  description: string
  scopes: readonly KeyScope[]
}

export const PLAY_SLOT_COMMANDS: readonly CommandId[] = [
  'play_slot_1',
  'play_slot_2',
  'play_slot_3',
  'play_slot_4',
  'play_slot_5',
  'play_slot_6',
  'play_slot_7',
  'play_slot_8',
  'play_slot_9',
  'play_slot_10',
]

export const REPLAY_COMMANDS: readonly CommandId[] = [
  'replay_play_pause',
  'replay_step',
  'replay_speed',
]

/** 固定命令注册表：顺序即编辑器/键位表的展示顺序 */
export const COMMAND_DEFS: readonly CommandDef[] = [
  ...PLAY_SLOT_COMMANDS.map((id, index) => ({
    id,
    label: `出牌槽 ${index + 1}`,
    description: index === 9 ? '打出手牌第 10 张（默认 0）' : `打出手牌第 ${index + 1} 张`,
    scopes: ['battle'] as const,
  })),
  { id: 'end_turn', label: '结束回合', description: '把回合交给对面（空格）', scopes: ['battle'] },
  { id: 'hero_power', label: '英雄技能', description: '释放派系技能（H）', scopes: ['battle'] },
  { id: 'cycle_target', label: '循环选目标', description: '在候选目标间轮流切换（Tab）', scopes: ['battle'] },
  { id: 'confirm', label: '确认', description: '敲定当前选中的目标（Enter）', scopes: ['battle'] },
  { id: 'cancel', label: '取消', description: '退出目标选择 / 关闭浮层（Esc）', scopes: ['battle'] },
  { id: 'fast_forward', label: '快进', description: '回放快进（对局中无消费方）', scopes: ['replay'] },
  { id: 'mute', label: '静音', description: '主音量静音开关（M）', scopes: ['global'] },
  { id: 'toggle_key_hints', label: '键位角标开关', description: '手牌槽位键位角标显示/隐藏（K）', scopes: ['global'] },
  { id: 'help', label: '键位表', description: '弹出快捷键速查浮层（?）', scopes: ['global'] },
  { id: 'replay_play_pause', label: '回放 播放/暂停', description: '回放播放器播放与暂停', scopes: ['replay'] },
  { id: 'replay_step', label: '回放 步进', description: '回放逐事件步进', scopes: ['replay'] },
  { id: 'replay_speed', label: '回放 变速', description: '回放 0.5×/1×/2×/4× 循环', scopes: ['replay'] },
]

const DEFS_BY_ID = new Map<string, CommandDef>(COMMAND_DEFS.map((def) => [def.id, def]))

/** 未知 id 一律 undefined（容错解析侧用） */
export function commandDefOf(id: string): CommandDef | undefined {
  return DEFS_BY_ID.get(id)
}

export function isCommandId(id: string): id is CommandId {
  return DEFS_BY_ID.has(id)
}

/** 两命令生效域是否相交（相交 = 可能在同一界面同时生效 = 视为冲突）。
    global 命令处处生效，与任何 scope 都相交；battle 与 replay 互不相交。 */
export function scopesIntersect(a: readonly KeyScope[], b: readonly KeyScope[]): boolean {
  if (a.includes('global') || b.includes('global')) return true
  return a.some((scope) => b.includes(scope))
}
