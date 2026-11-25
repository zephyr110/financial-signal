import type { WatchlistItem } from './types'

export type WatchlistSort = 'default' | 'change-desc' | 'change-asc'

/**
 * 按涨跌幅排序；待入库/停牌标的没有涨跌幅，升降序都排在最后。
 */
export function sortWatchlistItems(items: WatchlistItem[], sort: WatchlistSort): WatchlistItem[] {
  if (sort === 'default') return items
  const direction = sort === 'change-desc' ? -1 : 1
  return [...items].sort((a, b) => {
    if (a.changePct == null && b.changePct == null) return 0
    if (a.changePct == null) return 1
    if (b.changePct == null) return -1
    return (a.changePct - b.changePct) * direction
  })
}
