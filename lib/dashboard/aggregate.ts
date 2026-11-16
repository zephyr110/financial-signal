import type { PortfolioView, TaskRecord, TodayPayload, WatchlistItem } from '../cockpit/types'
import type { AlertView, DeskSnapshot } from '../desk/types'

export const DASHBOARD_SECTION_KEYS = ['brief', 'pulse', 'watchlist', 'portfolio', 'tasks'] as const
export type DashboardSectionKey = (typeof DASHBOARD_SECTION_KEYS)[number]

/** 首页只取简报的结论区，证据明细仍留在 /today。 */
export interface DashboardBrief {
  tradeDate: string
  issueNo: number
  claim: string
  confidence: TodayPayload['hero']['confidence']
  evidence: TodayPayload['hero']['evidence']
  indices: TodayPayload['indices']
  breadth: TodayPayload['breadth']
  turnover: TodayPayload['turnover']
  impacts: TodayPayload['impacts']
  documents: TodayPayload['documents']
  isDemo: boolean
  generatedAt: string
}

export interface DashboardPulse {
  tradeDate: string | null
  asOf: string
  market: DeskSnapshot['market']
  /** 波动最大的行业，驾驶舱只放迷你热力条 */
  industries: DeskSnapshot['industries']
  overseas: DeskSnapshot['overseas']
  realtime: DeskSnapshot['realtime']
  isDemo: boolean
}

export interface DashboardTasks {
  alerts: AlertView[]
  active: TaskRecord[]
  failed: TaskRecord[]
  latestSucceeded: TaskRecord | null
}

export interface DashboardSectionData {
  brief: DashboardBrief | null
  pulse: DashboardPulse | null
  watchlist: WatchlistItem[]
  portfolio: PortfolioView
  tasks: DashboardTasks
}

export type DashboardSection<K extends DashboardSectionKey> =
  | { ok: true; data: DashboardSectionData[K] }
  | { ok: false; error: string }

export type DashboardSections = { [K in DashboardSectionKey]?: DashboardSection<K> }

export interface DashboardPayload {
  asOf: string
  sections: DashboardSections
}

export interface DashboardSources {
  today: () => Promise<TodayPayload | null>
  snapshot: () => Promise<DeskSnapshot | null>
  watchlist: () => Promise<WatchlistItem[]>
  portfolio: () => Promise<PortfolioView>
  tasks: () => Promise<TaskRecord[]>
}

const SECTION_LABEL: Record<DashboardSectionKey, string> = {
  brief: '今日简报',
  pulse: '市场脉搏',
  watchlist: '自选异动',
  portfolio: '持仓暴露',
  tasks: '今日任务',
}

export function sectionLabel(key: DashboardSectionKey): string {
  return SECTION_LABEL[key]
}

export function isDashboardSectionKey(value: string): value is DashboardSectionKey {
  return (DASHBOARD_SECTION_KEYS as readonly string[]).includes(value)
}

/** `?sections=` 空值或缺省表示全量；非法项忽略，顺序按固定清单。 */
export function parseDashboardSections(raw?: string | null): DashboardSectionKey[] {
  const picked = new Set(
    (raw ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(isDashboardSectionKey),
  )
  if (picked.size === 0) return [...DASHBOARD_SECTION_KEYS]
  return DASHBOARD_SECTION_KEYS.filter((key) => picked.has(key))
}

export function briefFrom(payload: TodayPayload | null): DashboardBrief | null {
  if (!payload) return null
  return {
    tradeDate: payload.tradeDate,
    issueNo: payload.issueNo,
    claim: payload.hero.claim,
    confidence: payload.hero.confidence,
    evidence: payload.hero.evidence,
    indices: payload.indices,
    breadth: payload.breadth,
    turnover: payload.turnover,
    impacts: payload.impacts,
    documents: payload.documents,
    isDemo: payload.isDemo,
    generatedAt: payload.generatedAt,
  }
}

export function pulseFrom(snapshot: DeskSnapshot | null): DashboardPulse | null {
  if (!snapshot) return null
  return {
    tradeDate: snapshot.tradeDate,
    asOf: snapshot.asOf,
    market: snapshot.market,
    industries: [...snapshot.industries]
      .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
      .slice(0, 6),
    overseas: snapshot.overseas.slice(0, 4),
    realtime: snapshot.realtime.slice(0, 6),
    isDemo: snapshot.isDemo,
  }
}

/** 异动优先：涨跌幅绝对值降序，缺价条目排最后，不把缺失画成 0%。 */
export function watchlistMovers(items: WatchlistItem[], limit = 8): WatchlistItem[] {
  const sorted = [...items].sort((a, b) => {
    const av = a.changePct == null ? null : Math.abs(a.changePct)
    const bv = b.changePct == null ? null : Math.abs(b.changePct)
    if (av === null && bv === null) return a.code.localeCompare(b.code)
    if (av === null) return 1
    if (bv === null) return -1
    if (bv !== av) return bv - av
    return a.code.localeCompare(b.code)
  })
  return sorted.slice(0, limit)
}

export function tasksSummary(tasks: TaskRecord[], alerts: AlertView[], limit = 6): DashboardTasks {
  const byTime = (a: TaskRecord, b: TaskRecord) => b.createdAt.localeCompare(a.createdAt)
  const active = tasks.filter((task) => task.status === 'queued' || task.status === 'running').sort(byTime)
  const failed = tasks.filter((task) => task.status === 'failed').sort(byTime)
  const latestSucceeded = tasks.filter((task) => task.status === 'succeeded').sort(byTime)[0] ?? null
  return {
    alerts: alerts.slice(0, 3),
    active: active.slice(0, limit),
    failed: failed.slice(0, 3),
    latestSucceeded,
  }
}

/**
 * 单源失败只标记对应区块；页面其余面板照常展示。
 * 投研快照被脉搏与任务共用，只加载一次，失败时任务面板仍可展示任务队列。
 */
export async function collectDashboard(
  sources: DashboardSources,
  keys: readonly DashboardSectionKey[] = DASHBOARD_SECTION_KEYS,
): Promise<DashboardPayload> {
  const selected = DASHBOARD_SECTION_KEYS.filter((key) => keys.includes(key))
  let snapshotPromise: Promise<DeskSnapshot | null> | undefined
  const snapshot = () => (snapshotPromise ??= sources.snapshot())

  const entries = await Promise.all(
    selected.map(async (key) => {
      try {
        switch (key) {
          case 'brief':
            return [key, { ok: true, data: briefFrom(await sources.today()) } as const] as const
          case 'pulse':
            return [key, { ok: true, data: pulseFrom(await snapshot()) } as const] as const
          case 'watchlist':
            return [key, { ok: true, data: watchlistMovers(await sources.watchlist()) } as const] as const
          case 'portfolio':
            return [key, { ok: true, data: await sources.portfolio() } as const] as const
          case 'tasks': {
            const [tasks, desk] = await Promise.all([
              sources.tasks(),
              snapshot().catch(() => null),
            ])
            return [key, { ok: true, data: tasksSummary(tasks, desk?.alerts ?? []) } as const] as const
          }
        }
      } catch {
        return [key, { ok: false, error: '数据暂时不可用' } as const] as const
      }
    }),
  )

  const sections: DashboardSections = {}
  for (const [key, value] of entries) {
    ;(sections as Record<string, unknown>)[key] = value
  }
  return { asOf: new Date().toISOString(), sections }
}
