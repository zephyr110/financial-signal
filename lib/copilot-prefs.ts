export const COPILOT_OPEN_KEY = 'cockpit:copilot-open'
export const COPILOT_SEEN_KEY = 'cockpit:copilot-seen'
export const COPILOT_SESSION_KEY = 'agent-session-id'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function resolveCopilotOpen(
  stored: boolean | null,
  firstVisit: boolean,
  isMobile: boolean,
): boolean {
  // 手机端每次默认关闭，收起时不占首屏
  if (isMobile) return false
  if (stored !== null) return stored
  // 桌面端首次进入展开一次，让用户发现它可以问问题
  return firstVisit
}

export function readCopilotPrefs(storage?: StorageLike | null): { stored: boolean | null; firstVisit: boolean } {
  if (!storage) return { stored: null, firstVisit: true }
  try {
    const raw = storage.getItem(COPILOT_OPEN_KEY)
    return {
      stored: raw === '1' ? true : raw === '0' ? false : null,
      firstVisit: storage.getItem(COPILOT_SEEN_KEY) !== '1',
    }
  } catch {
    return { stored: null, firstVisit: true }
  }
}

export function writeCopilotPrefs(storage: StorageLike | null | undefined, open: boolean): void {
  if (!storage) return
  try {
    storage.setItem(COPILOT_OPEN_KEY, open ? '1' : '0')
    storage.setItem(COPILOT_SEEN_KEY, '1')
  } catch {
    // 存储不可用时只影响下次默认状态
  }
}

/** 首次自动展开只记「已见过」，不写入展开偏好，否则下次仍会默认展开。 */
export function markCopilotSeen(storage: StorageLike | null | undefined): void {
  if (!storage) return
  try {
    storage.setItem(COPILOT_SEEN_KEY, '1')
  } catch {
    // 同上
  }
}
