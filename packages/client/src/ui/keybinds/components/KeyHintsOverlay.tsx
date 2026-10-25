/**
 * 键位表浮层（P2-UI5 `?` 命令的消费端）——当前键位表的人类可读速查。
 * `?` 键位表与实际行为一致：行数据直接来自命令注册表 + 当前 binds，
 * 不存在第二份文案。对局屏传 scope="battle"（对局+通用），编辑器内传
 * "all"（全部组，含回放）。
 */

import { useEffect } from 'react'
import '../../styles/keybinds.css'
import { COMMAND_DEFS, PLAY_SLOT_COMMANDS, REPLAY_COMMANDS, type CommandId, type KeyScope } from '../commands'
import { formatCombo } from '../combo'
import { useKeybinds } from '../keybindsStore'

interface HintRow {
  id: string
  label: string
  comboText: string
}

function rowsFor(scope: KeyScope | 'all', binds: Record<CommandId, string>): { group: string; rows: HintRow[] }[] {
  const want = (def: { scopes: readonly KeyScope[] }) =>
    scope === 'all' || def.scopes.includes(scope) || def.scopes.includes('global')

  // 出牌槽 1..10 聚合成一行（十个同名行没有信息量）
  const playRow: HintRow = {
    id: 'play_slots',
    label: '出牌槽 1–9 / 0',
    comboText: PLAY_SLOT_COMMANDS.map((id) => formatCombo(binds[id])).join(' '),
  }
  const battleRows: HintRow[] = COMMAND_DEFS.filter(
    (def) => def.scopes.includes('battle') && !PLAY_SLOT_COMMANDS.includes(def.id) && want(def),
  ).map((def) => ({ id: def.id, label: def.label, comboText: formatCombo(binds[def.id]) }))
  const playGroup = PLAY_SLOT_COMMANDS.length > 0 && want({ scopes: ['battle'] }) ? [playRow] : []
  const replayRows: HintRow[] = COMMAND_DEFS.filter(
    (def) => REPLAY_COMMANDS.includes(def.id) && want(def),
  ).map((def) => ({ id: def.id, label: def.label, comboText: formatCombo(binds[def.id]) }))
  const globalRows: HintRow[] = COMMAND_DEFS.filter((def) => def.scopes.includes('global')).map((def) => ({
    id: def.id,
    label: def.label,
    comboText: formatCombo(binds[def.id]),
  }))

  const groups: { group: string; rows: HintRow[] }[] = [
    { group: '对局', rows: [...playGroup, ...battleRows] },
    { group: '回放', rows: replayRows },
    { group: '通用', rows: globalRows },
  ]
  return groups.filter(({ rows }) => rows.length > 0)
}

export function KeyHintsOverlay({ onClose, scope = 'battle' }: { onClose: () => void; scope?: KeyScope | 'all' }) {
  const binds = useKeybinds((s) => s.binds)
  const groups = rowsFor(scope, binds)

  // 浮层自兜底：Esc 关闭（对局屏的 cancel 命令也会先关浮层，双保险）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="sc-key-overlay" role="dialog" aria-modal="true" aria-label="快捷键速查" onClick={onClose}>
      <div className="sc-key-overlay-card" onClick={(event) => event.stopPropagation()}>
        <header className="sc-key-overlay-head">
          <h3>快捷键速查</h3>
          <button type="button" className="sc-btn sc-btn--small" onClick={onClose}>
            关闭（Esc）
          </button>
        </header>
        {groups.map(({ group, rows }) => (
          <section key={group} className="sc-key-overlay-group">
            <h4>{group}</h4>
            <table className="sc-key-table">
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.label}</th>
                    <td>
                      <kbd>{row.comboText}</kbd>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
        <p className="sc-key-overlay-foot">改键去「开局配置 → 键位设置」，改完立即生效并记住。</p>
      </div>
    </div>
  )
}
