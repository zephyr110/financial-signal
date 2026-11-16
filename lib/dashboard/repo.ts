import { getPortfolio, getTodayPayload, getWatchlist } from '../cockpit/repo'
import { listTasks } from '../cockpit/tasks'
import { DeskSnapshotNotFoundError, getDeskSnapshot } from '../desk/repo'
import {
  DASHBOARD_SECTION_KEYS,
  collectDashboard,
  type DashboardPayload,
  type DashboardSectionKey,
} from './aggregate'

/** 当天还没有投研快照是正常空态，不是读取失败。 */
async function snapshotOrNull() {
  try {
    return await getDeskSnapshot()
  } catch (err) {
    if (err instanceof DeskSnapshotNotFoundError) return null
    throw err
  }
}

export async function getDashboard(
  keys: readonly DashboardSectionKey[] = DASHBOARD_SECTION_KEYS,
): Promise<DashboardPayload> {
  return collectDashboard(
    {
      today: () => getTodayPayload(),
      snapshot: snapshotOrNull,
      watchlist: () => getWatchlist(),
      portfolio: () => getPortfolio(),
      tasks: () => listTasks(50),
    },
    keys,
  )
}
