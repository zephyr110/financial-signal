import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 投研台必须能从现有日线确定性地产出行业聚合、判断与预警；
 * 重复刷新只更新快照，不重复堆预警。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-engine-test-'))
let demo: typeof import('../lib/cockpit/demo')
let engine: typeof import('../lib/desk/engine')
let repo: typeof import('../lib/desk/repo')
let dbModule: typeof import('../lib/db')

const failingFetch = (async () => new Response('', { status: 503 })) as typeof fetch

describe('desk deterministic engine', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'desk.db')
    vi.resetModules()
    demo = await import('../lib/cockpit/demo')
    engine = await import('../lib/desk/engine')
    repo = await import('../lib/desk/repo')
    dbModule = await import('../lib/db')
    await demo.ensureCockpitDemoSeed()
  })

  it('从示例行情生成 3 条行业判断与市场判断', async () => {
    const result = await engine.refreshDesk({
      tradeDate: demo.DEMO_TRADE_DATE,
      fetchImpl: failingFetch,
    })
    expect(result.tradeDate).toBe(demo.DEMO_TRADE_DATE)
    expect(result.industries).toBeGreaterThanOrEqual(3)
    expect(result.judgments).toBe(4)
    expect(result.isDemo).toBe(true)

    const snapshot = await repo.getDeskSnapshot(demo.DEMO_TRADE_DATE)
    expect(snapshot.market?.kind).toBe('market')
    expect(snapshot.industries).toHaveLength(3)
    expect(snapshot.industries.every((judgment) => judgment.industry !== '指数')).toBe(true)
    expect(snapshot.market?.evidence.length).toBeGreaterThan(0)
    expect(snapshot.industries.every((judgment) => judgment.drivers.length > 0)).toBe(true)
    expect(snapshot.overseas).toEqual([])
    expect(snapshot.dataQuality.length).toBeGreaterThan(0)
  })

  it('重复刷新不重复堆预警，判断仍为同一天 4 条', async () => {
    const first = await repo.listAlerts({ limit: 100 })
    const result = await engine.refreshDesk({
      tradeDate: demo.DEMO_TRADE_DATE,
      fetchImpl: failingFetch,
    })
    expect(result.alerts).toBeGreaterThan(0)
    const second = await repo.listAlerts({ limit: 100 })
    expect(second.length).toBe(first.length)
    const snapshot = await repo.getDeskSnapshot(demo.DEMO_TRADE_DATE)
    expect(snapshot.industries).toHaveLength(3)

    const db = await dbModule.getDb()
    const rows = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM judgments WHERE trade_date = ? AND status = 'open'",
      args: [demo.DEMO_TRADE_DATE],
    })
    expect(Number(rows.rows[0]?.n)).toBe(4)
  })

  it('预警可确认，状态与台账可读', async () => {
    const alerts = await repo.listAlerts({ status: 'open', limit: 10 })
    expect(alerts.length).toBeGreaterThan(0)
    const acknowledged = await repo.acknowledgeAlert(alerts[0].id)
    expect(acknowledged?.status).toBe('acknowledged')

    const ledger = await repo.listJudgments({ limit: 10 })
    expect(ledger.total).toBe(4)
    expect(ledger.items.every((judgment) => judgment.tradeDate === demo.DEMO_TRADE_DATE)).toBe(true)
    expect(ledger.items.some((judgment) => judgment.kind === 'market')).toBe(true)

    const status = await repo.getDeskStatus()
    expect(status.hasSnapshot).toBe(true)
    expect(status.tradeDate).toBe(demo.DEMO_TRADE_DATE)
    expect(status.judgments).toBe(4)
    expect(status.isDemo).toBe(true)
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
