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
let validators: typeof import('../lib/cockpit/validators')
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
    validators = await import('../lib/cockpit/validators')
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

  it('涨跌家数缺失时不下“赚钱效应偏弱”的结论', async () => {
    const pack = await facts.buildFactPack(demo.DEMO_TRADE_DATE)
    const payload = brief.buildDailyBrief({
      ...pack,
      breadth: { ...pack.breadth, up: 0, flat: 0, down: 0, limitUp: 0, limitDown: 0 },
    })
    expect(payload.hero.claim).not.toContain('赚钱效应偏弱')
    expect(payload.hero.claim).toContain('涨跌家数缺失')
    expect(payload.hero.evidence.find((item) => item.kind === 'conclusion')?.label)
      .toContain('补齐涨跌家数')
  })

  it('次日凌晨（上海）的公告不算进当天简报', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO source_documents
            (id, source_id, doc_type, external_id, title, published_at, fetched_at, is_demo)
            VALUES ('demo-doc-late', 'demo-announcement', 'announcement', 'late-1',
                    '【示例】次日早间公告', '2026-10-22T23:30:00.000Z', '2026-10-22T23:30:00.000Z', 1)`,
      args: [],
    })
    try {
      const pack = await facts.buildFactPack(demo.DEMO_TRADE_DATE)
      expect(pack.documents.map((doc) => doc.id)).not.toContain('demo-doc-late')
    } finally {
      await db.execute({ sql: "DELETE FROM source_documents WHERE id = 'demo-doc-late'", args: [] })
    }
  })

  it('没有行情记录时不伪造价格、涨跌与证据', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
            VALUES ('601999.SH', '无行情标的', 'SSE', '测试', 'demo-market', '2026-10-22T00:00:00.000Z')`,
      args: [],
    })
    try {
      const stock = await repo.getStockDetail('601999.SH')
      expect(stock).not.toBeNull()
      expect(stock!.price).toBeNull()
      expect(stock!.changePct).toBeNull()
      expect(stock!.bars).toEqual([])
      expect(stock!.evidence.some((item) => item.id.startsWith('fact:stock:'))).toBe(false)
    } finally {
      await db.execute({ sql: "DELETE FROM symbols WHERE code = '601999.SH'", args: [] })
    }
  })

  it('行情只回补到前一日时不把旧收盘当成当日收盘', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `CREATE TEMP TABLE _bar_backup AS
            SELECT * FROM market_bars WHERE code = '399006.SZ' AND trade_date = ?`,
      args: [demo.DEMO_TRADE_DATE],
    })
    await db.execute({
      sql: "DELETE FROM market_bars WHERE code = '399006.SZ' AND trade_date = ?",
      args: [demo.DEMO_TRADE_DATE],
    })
    try {
      const pack = await facts.buildFactPack(demo.DEMO_TRADE_DATE)
      expect(pack.indices.some((item) => item.code === '399006.SZ')).toBe(false)
    } finally {
      await db.execute({ sql: 'INSERT OR REPLACE INTO market_bars SELECT * FROM _bar_backup', args: [] })
      await db.execute({ sql: 'DROP TABLE _bar_backup', args: [] })
    }
  })

  it('指数缺失时降级简报仍可发布', async () => {
    const pack = await facts.buildFactPack(demo.DEMO_TRADE_DATE)
    const payload = brief.buildDailyBrief({ ...pack, indices: [] })
    const result = validators.validateBriefPayload(
      payload,
      new Set(Object.keys(pack.facts)),
      new Set(pack.dataQuality.map((source) => source.id)),
    )
    expect(payload.hero.claim).toContain('指数行情缺失')
    expect(result.ok).toBe(true)
  })

  it('论点标题里的交易词不会拖垮整份简报', async () => {
    const pack = await facts.buildFactPack(demo.DEMO_TRADE_DATE)
    const weakened = pack.theses.find((thesis) => thesis.status === 'weakened')
    expect(weakened).toBeTruthy()
    const poisoned = {
      ...pack,
      theses: pack.theses.map((thesis) => thesis.id === weakened!.id
        ? { ...thesis, title: '白酒止损线 1400' }
        : thesis),
    }
    const payload = brief.buildDailyBrief(poisoned)
    expect(JSON.stringify(payload)).not.toContain('止损')
    const result = validators.validateBriefPayload(
      payload,
      new Set(Object.keys(pack.facts)),
      new Set(pack.dataQuality.map((source) => source.id)),
    )
    expect(result.ok).toBe(true)
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
