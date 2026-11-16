export const COCKPIT_PANEL_KEYS = ['brief', 'pulse', 'watchlist', 'portfolio', 'tasks'] as const
export type CockpitPanelKey = (typeof COCKPIT_PANEL_KEYS)[number]

export const COCKPIT_PANELS: ReadonlyArray<{ key: CockpitPanelKey; label: string }> = [
  { key: 'brief', label: '今日简报' },
  { key: 'pulse', label: '市场脉搏' },
  { key: 'watchlist', label: '自选异动' },
  { key: 'portfolio', label: '持仓暴露' },
  { key: 'tasks', label: '今日任务' },
]

export const COCKPIT_PANEL_STORAGE_KEY = 'cockpit:visible-panels'

export function isPanelKey(value: unknown): value is CockpitPanelKey {
  return typeof value === 'string' && (COCKPIT_PANEL_KEYS as readonly string[]).includes(value)
}

/** 至少保留一块面板；未知值忽略，输出按固定顺序。 */
export function sanitizePanelKeys(value: unknown): CockpitPanelKey[] {
  if (!Array.isArray(value)) return [...COCKPIT_PANEL_KEYS]
  const picked = new Set(value.filter(isPanelKey))
  if (picked.size === 0) return [...COCKPIT_PANEL_KEYS]
  return COCKPIT_PANEL_KEYS.filter((key) => picked.has(key))
}

export function togglePanelKey(current: readonly CockpitPanelKey[], key: CockpitPanelKey): CockpitPanelKey[] {
  const next = new Set(current)
  if (next.has(key)) {
    if (next.size === 1) return [...current]
    next.delete(key)
  } else {
    next.add(key)
  }
  return COCKPIT_PANEL_KEYS.filter((item) => next.has(item))
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function loadPanelKeys(storage?: StorageLike | null): CockpitPanelKey[] {
  if (!storage) return [...COCKPIT_PANEL_KEYS]
  try {
    const raw = storage.getItem(COCKPIT_PANEL_STORAGE_KEY)
    if (!raw) return [...COCKPIT_PANEL_KEYS]
    return sanitizePanelKeys(JSON.parse(raw))
  } catch {
    return [...COCKPIT_PANEL_KEYS]
  }
}

export function savePanelKeys(storage: StorageLike | null | undefined, keys: readonly CockpitPanelKey[]): void {
  if (!storage) return
  try {
    storage.setItem(COCKPIT_PANEL_STORAGE_KEY, JSON.stringify(sanitizePanelKeys(keys)))
  } catch {
    // 隐私模式等存储不可用时只保留本次会话状态
  }
}
