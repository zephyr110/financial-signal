export interface CockpitSelection {
  symbol: string | null
  thread: number | null
}

export const EMPTY_SELECTION: CockpitSelection = { symbol: null, thread: null }

type QueryValue = string | string[] | undefined
export type QueryLike = Record<string, QueryValue | number | undefined>

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) return firstString(value[0])
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** 代码允许字母数字与 ._-（外盘快照用 _SPX 这类符号），长度受限防止脏深链。 */
export function normalizeSymbol(value: unknown): string | null {
  const raw = firstString(value)
  if (!raw || raw.length > 20) return null
  return /^[A-Za-z0-9._-]+$/.test(raw) ? raw : null
}

export function normalizeThread(value: unknown): number | null {
  const raw = firstString(value)
  if (!raw || !/^\d+$/.test(raw)) return null
  const id = Number(raw)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

/** 深链同时带两个参数时以标的为准，避免抽屉内容不确定。 */
export function parseSelectionQuery(query: QueryLike): CockpitSelection {
  const symbol = normalizeSymbol(query.symbol)
  if (symbol) return { symbol, thread: null }
  return { symbol: null, thread: normalizeThread(query.thread) }
}

export function hasSelection(selection: CockpitSelection): boolean {
  return Boolean(selection.symbol || selection.thread)
}

export function withSelectionQuery<T extends QueryLike>(query: T, selection: CockpitSelection): T {
  const next: QueryLike = { ...query }
  delete next.symbol
  delete next.thread
  if (selection.symbol) next.symbol = selection.symbol
  if (selection.thread) next.thread = String(selection.thread)
  return next as T
}
