/**
 * 平衡数据加载（P2-UI4）—— packages/client/public/data/balance-stats.json
 * （P2-DATA1 数值管线产物）。图鉴详情按 cardId 命中出场率与出场胜率；
 * 无记录的卡显示「暂无出场记录」。fetch 失败一律降级为空表，图鉴主功能不受影响。
 */

export interface CardBalanceStat {
  /** 出场率（0–1） */
  played: number
  /** 出场时胜率（0–1） */
  playedWinRate: number
}

export type BalanceStatTable = Record<string, CardBalanceStat>

interface BalanceStatsFile {
  cards?: { cardId?: unknown; played?: unknown; playedWinRate?: unknown }[]
}

/** 拉取平衡数据并按 cardId 建索引；任何异常（离线 / 404 / 结构不符）返回空表 */
export async function fetchBalanceStats(url?: string): Promise<BalanceStatTable> {
  try {
    const target = url ?? `${import.meta.env.BASE_URL}data/balance-stats.json`
    const res = await fetch(target)
    if (!res.ok) return {}
    const data = (await res.json()) as BalanceStatsFile
    const table: BalanceStatTable = {}
    for (const entry of data.cards ?? []) {
      if (
        typeof entry.cardId === 'string' &&
        typeof entry.played === 'number' &&
        typeof entry.playedWinRate === 'number'
      ) {
        table[entry.cardId] = { played: entry.played, playedWinRate: entry.playedWinRate }
      }
    }
    return table
  } catch {
    return {}
  }
}

/** 出场率显示（0.6397 → 64.0%）；无记录返回 null（调用方显示「暂无出场记录」） */
export function playedRateLabel(stat: CardBalanceStat | undefined): string | null {
  if (!stat || !Number.isFinite(stat.played)) return null
  return `${(stat.played * 100).toFixed(1)}%`
}

/** 出场胜率显示（0.5639 → 56.4%）；无记录返回 null */
export function winRateLabel(stat: CardBalanceStat | undefined): string | null {
  if (!stat || !Number.isFinite(stat.playedWinRate)) return null
  return `${(stat.playedWinRate * 100).toFixed(1)}%`
}
