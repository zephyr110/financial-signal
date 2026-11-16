import { describe, it, expect } from 'vitest'
import {
  DASHBOARD_SECTION_KEYS,
  briefFrom,
  collectDashboard,
  parseDashboardSections,
  pulseFrom,
  tasksSummary,
  watchlistMovers,
  type DashboardSources,
} from '@/lib/dashboard/aggregate'
import type { TaskRecord, TodayPayload, WatchlistItem } from '@/lib/cockpit/types'
import type { AlertView, DeskSnapshot, JudgmentView } from '@/lib/desk/types'

function today(): TodayPayload {
  return {
    tradeDate: '2026-11-12',
    issueNo: 42,
    session: 'post',
    hero: { claim: '指数缩量整理', confidence: { label: '中', score: 60, basis: '样本' }, evidence: [] },
    indices: [],
    breadth: { up: 2000, flat: 100, down: 2500, limitUp: 30, limitDown: 5, limitUpDownAvailable: true },
    turnover: { amount: 8000 },
    impacts: [],
    documents: [],
    tomorrow: [],
    dataQuality: [],
    isDemo: false,
    generatedAt: '2026-11-12T08:00:00.000Z',
  } as unknown as TodayPayload
}

function judgment(id: string, score: number): JudgmentView {
  return { id, industry: id, score } as JudgmentView
}

function snapshot(overrides: Partial<DeskSnapshot> = {}): DeskSnapshot {
  return {
    tradeDate: '2026-11-12',
    asOf: '2026-11-12T08:05:00.000Z',
    market: null,
    industries: [],
    alerts: [],
    overseas: [],
    realtime: [],
    dataQuality: [],
    isDemo: false,
    generatedAt: '2026-11-12T08:05:00.000Z',
    ...overrides,
  }
}

function watch(code: string, changePct: number | null): WatchlistItem {
  return { code, name: code, price: null, changePct, sparkline: [] }
}

function task(id: string, status: string, createdAt: string): TaskRecord {
  return {
    id,
    type: 'daily_brief',
    lane: 'daily',
    status,
    progress: 0,
    params: {},
    result: null,
    error: null,
    createdAt,
    attempts: 0,
    costMicros: 0,
  } as unknown as TaskRecord
}

function alert(id: string): AlertView {
  return { id } as AlertView
}

function sources(overrides: Partial<DashboardSources> = {}): DashboardSources {
  return {
    today: async () => today(),
    snapshot: async () => snapshot(),
    watchlist: async () => [],
    portfolio: async () => ({}) as any,
    tasks: async () => [],
    ...overrides,
  }
}

describe('区块参数解析', () => {
  it('缺省或全非法时返回全部区块', () => {
    expect(parseDashboardSections()).toEqual([...DASHBOARD_SECTION_KEYS])
    expect(parseDashboardSections('')).toEqual([...DASHBOARD_SECTION_KEYS])
    expect(parseDashboardSections('bogus')).toEqual([...DASHBOARD_SECTION_KEYS])
  })

  it('按固定顺序返回选中区块并忽略非法项', () => {
    expect(parseDashboardSections('tasks,watchlist,bogus')).toEqual(['watchlist', 'tasks'])
  })
})

describe('数据摘要', () => {
  it('briefFrom 只搬运驾驶舱需要的结论区', () => {
    const brief = briefFrom(today())
    expect(brief?.issueNo).toBe(42)
    expect(brief?.claim).toBe('指数缩量整理')
    expect(briefFrom(null)).toBeNull()
  })

  it('pulseFrom 取波动最大的六个行业，并截断外盘与实盘', () => {
    const pulse = pulseFrom(
      snapshot({
        industries: [-9, 2, 7, -1, 5, 0, 3].map((score, index) => judgment(`i${index}`, score)),
        overseas: ['a', 'b', 'c', 'd', 'e'].map((symbol) => ({ symbol }) as any),
        realtime: Array.from({ length: 7 }, (_, index) => ({ code: `c${index}` }) as any),
      }),
    )
    expect(pulse?.industries.map((item) => item.score)).toEqual([-9, 7, 5, 3, 2, -1])
    expect(pulse?.overseas).toHaveLength(4)
    expect(pulse?.realtime).toHaveLength(6)
    expect(pulseFrom(null)).toBeNull()
  })

  it('watchlistMovers 按涨跌幅绝对值降序，缺价排最后且不当作 0%', () => {
    const sorted = watchlistMovers([
      watch('A', -5),
      watch('B', null),
      watch('C', 3),
      watch('D', 8),
      watch('E', null),
    ])
    expect(sorted.map((item) => item.code)).toEqual(['D', 'A', 'C', 'B', 'E'])
  })

  it('tasksSummary 只保留进行中、失败与最近成功，并截断预警', () => {
    const summary = tasksSummary(
      [
        task('old-run', 'running', '2026-11-12T07:00:00.000Z'),
        task('new-run', 'running', '2026-11-12T09:00:00.000Z'),
        task('queued', 'queued', '2026-11-12T08:00:00.000Z'),
        task('fail-1', 'failed', '2026-11-12T06:00:00.000Z'),
        task('fail-2', 'failed', '2026-11-12T05:00:00.000Z'),
        task('done-old', 'succeeded', '2026-11-12T04:00:00.000Z'),
        task('done-new', 'succeeded', '2026-11-12T10:00:00.000Z'),
      ],
      [alert('a'), alert('b'), alert('c'), alert('d')],
    )
    expect(summary.active.map((item) => item.id)).toEqual(['new-run', 'queued', 'old-run'])
    expect(summary.failed.map((item) => item.id)).toEqual(['fail-1', 'fail-2'])
    expect(summary.latestSucceeded?.id).toBe('done-new')
    expect(summary.alerts.map((item) => item.id)).toEqual(['a', 'b', 'c'])
  })

  it('没有任何成功任务时 latestSucceeded 为 null', () => {
    expect(tasksSummary([task('run', 'running', '2026-11-12T07:00:00.000Z')], []).latestSucceeded).toBeNull()
  })
})

describe('collectDashboard 区块隔离', () => {
  it('单源失败只标记对应区块，其余照常返回', async () => {
    const payload = await collectDashboard(
      sources({
        watchlist: async () => {
          throw new Error('db down')
        },
      }),
      ['watchlist', 'tasks'],
    )
    expect(payload.sections.watchlist).toEqual({ ok: false, error: '数据暂时不可用' })
    expect(payload.sections.tasks?.ok).toBe(true)
    expect(payload.sections.brief).toBeUndefined()
  })

  it('投研快照失败时脉搏报错，但任务面板仍展示任务队列', async () => {
    let snapshotCalls = 0
    const payload = await collectDashboard(
      sources({
        snapshot: async () => {
          snapshotCalls += 1
          throw new Error('snapshot down')
        },
      }),
      ['pulse', 'tasks'],
    )
    expect(payload.sections.pulse).toEqual({ ok: false, error: '数据暂时不可用' })
    expect(payload.sections.tasks?.ok).toBe(true)
    // 脉搏与任务共用同一次快照请求，失败也要复用同一个 Promise
    expect(snapshotCalls).toBe(1)
  })

  it('全量请求按固定键返回，空数据也是一种成功', async () => {
    const payload = await collectDashboard(sources({ snapshot: async () => null }))
    expect(Object.keys(payload.sections)).toEqual([...DASHBOARD_SECTION_KEYS])
    expect(payload.sections.pulse).toEqual({ ok: true, data: null })
    expect(payload.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})
