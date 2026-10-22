import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 端到端跑一遍确定性链路：种子 → 事实包 → 简报 → 报告。
 * 这里刻意不 mock SQL：schema、JSON 字段和来源映射都要经过真实 SQLite。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-brief-test-'))
let demo: typeof import('../lib/cockpit/demo')
let repo: typeof import('../lib/cockpit/repo')
let brief: typeof import('../lib/cockpit/brief')
let facts: typeof import('../lib/cockpit/facts')
let dbModule: typeof import('../lib/db')

describe('cockpit demo → brief', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'cockpit.db')
    vi.resetModules()
    demo = await import('../lib/cockpit/demo')
    repo = await import('../lib/cockpit/repo')
    brief = await import('../lib/cockpit/brief')
    facts = await import('../lib/cockpit/facts')
    dbModule = await import('../lib/db')
    const result = await demo.ensureCockpitDemoSeed()
    expect(result.seeded).toBe(true)
  })

  it('种子幂等，且报告可读取', async () => {
    const second = await demo.ensureCockpitDemoSeed()
    expect(second.seeded).toBe(false)

    const db = await dbModule.getDb()
    const reports = await db.execute({ sql: "SELECT COUNT(*) AS n FROM reports WHERE kind = 'daily_brief'", args: [] })
    expect(Number(reports.rows[0].n)).toBe(1)

    const payload = await repo.getTodayPayload(demo.DEMO_TRADE_DATE)
    expect(payload).not.toBeNull()
    expect(payload!.indices).toHaveLength(3)
    expect(payload!.hero.evidence.map((e) => e.kind)).toEqual(['fact', 'inference', 'counter', 'conclusion'])
    expect(payload!.hero.evidence[0].source?.id).toBe('demo-market')
    expect(payload!.isDemo).toBe(true)
    expect(payload!.documents.length).toBeGreaterThan(0)
    expect(payload!.hero.confidence.label).toBe('中')
  })

  it('事实包只包含登记来源，持仓有真实计算值', async () => {
    const pack = await facts.buildFactPack(demo.DEMO_TRADE_DATE)
    const sourceIds = new Set(pack.dataQuality.map((s) => s.id))
    for (const index of pack.indices) expect(sourceIds.has(index.source.id)).toBe(true)
    expect(Object.keys(pack.facts)).toContain('fact:index:000001.SH')
    expect(Object.keys(pack.facts)).not.toContain('fact:index:600519.SH')

    const portfolio = await repo.getPortfolio()
    expect(portfolio.totalValue).toBeGreaterThan(0)
    expect(portfolio.positions).toHaveLength(3)
    expect(portfolio.isDemo).toBe(true)
    expect(portfolio.positions.every((p) => p.price !== null)).toBe(true)
  })

  it('自选、个股与论点可读，论点有失效条件', async () => {
    const watchlist = await repo.getWatchlist()
    expect(watchlist).toHaveLength(5)
    expect(watchlist.every((item) => item.sparkline.length > 0)).toBe(true)

    const stock = await repo.getStockDetail('600519.SH')
    expect(stock).not.toBeNull()
    expect(stock!.documents.length).toBeGreaterThan(0)
    expect(stock!.thesis?.invalidation.length).toBeGreaterThan(0)

    const theses = await repo.getTheses()
    expect(theses).toHaveLength(3)
    expect(theses.every((t) => t.invalidation.length > 0)).toBe(true)
  })

  it('重复生成产生新版本而不是覆盖旧报告', async () => {
    const first = await brief.buildAndStoreDailyReport(demo.DEMO_TRADE_DATE)
    expect(first.version).toBe(1)
    const forced = await brief.buildAndStoreDailyReport(demo.DEMO_TRADE_DATE, { force: true })
    expect(forced.version).toBe(2)
    const db = await dbModule.getDb()
    const rows = await db.execute({
      sql: 'SELECT version, payload_json FROM reports WHERE kind = ? ORDER BY version',
      args: ['daily_brief'],
    })
    expect(rows.rows.map((r) => Number(r.version))).toEqual([1, 2])
  })
})

describe('demo task rows', () => {
  it('示例任务为成功态，不制造永远运行中的队列', async () => {
    const db = await dbModule.getDb()
    const rows = await db.execute({ sql: 'SELECT status, COUNT(*) AS n FROM tasks GROUP BY status', args: [] })
    expect(rows.rows).toHaveLength(1)
    expect(String(rows.rows[0].status)).toBe('succeeded')
  })
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})
