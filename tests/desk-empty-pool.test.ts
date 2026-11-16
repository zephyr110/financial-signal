import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 新装或清空研究池后，行情任务只会入库指数，投研台不应因此硬失败：
 * 空池是可解释的空状态（写市场判断 + 告警）；只有池里明明有可聚合个股、
 * 行情却缺失时才是需要暴露的数据故障。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-empty-pool-test-'))
const TRADE_DATE = '2026-11-16'
const PREV_DATE = '2026-11-13'
const failingFetch = (async () => new Response('', { status: 503 })) as typeof fetch

let engine: typeof import('../lib/desk/engine')
let repo: typeof import('../lib/desk/repo')
let dbModule: typeof import('../lib/db')

const INDEXES = [
  ['000001.SH', '上证指数'],
  ['399001.SZ', '深证成指'],
  ['399006.SZ', '创业板指'],
] as const

async function seedIndexMarket() {
  const db = await dbModule.getDb()
  const now = new Date().toISOString()
  for (const [code, name] of INDEXES) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
            VALUES (?, ?, 'SSE', '指数', 'eastmoney', ?)`,
      args: [code, name, now],
    })
    for (const [tradeDate, close] of [[PREV_DATE, 4000], [TRADE_DATE, 4030]] as const) {
      await db.execute({
        sql: `INSERT OR REPLACE INTO market_bars
              (code, trade_date, close, amount, adjust_type, source_id, fetched_at, is_demo)
              VALUES (?, ?, ?, ?, 'raw', 'eastmoney', ?, 0)`,
        args: [code, tradeDate, close, 1e11, now],
      })
    }
  }
  await db.execute({
    sql: `INSERT OR REPLACE INTO market_overview
          (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
          VALUES (?, ?, ?, 'eastmoney', 0, ?)`,
    args: [
      TRADE_DATE,
      JSON.stringify({ up: 1109, flat: 92, down: 4018, limitUp: 32, limitDown: 60 }),
      JSON.stringify({ value: 1e12, changePct: null }),
      now,
    ],
  })
}

describe('desk refresh with empty research pool', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'desk.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    engine = await import('../lib/desk/engine')
    repo = await import('../lib/desk/repo')
    await seedIndexMarket()
  })

  it('研究池为空时只写市场判断并给出告警，而不是整任务失败', async () => {
    const result = await engine.refreshDesk({ tradeDate: TRADE_DATE, fetchImpl: failingFetch })
    expect(result.industries).toBe(0)
    expect(result.judgments).toBe(1)
    expect(result.events).toBe(0)
    expect(result.warnings.some((warning) => warning.includes('研究池'))).toBe(true)

    const snapshot = await repo.getDeskSnapshot(TRADE_DATE)
    expect(snapshot.market?.kind).toBe('market')
    expect(snapshot.industries).toEqual([])
  })

  it('研究池有带行业归属的个股但缺日线时仍报数据故障', async () => {
    const db = await dbModule.getDb()
    const now = new Date().toISOString()
    await db.execute({
      sql: `INSERT OR REPLACE INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
            VALUES ('600000.SH', '浦发银行', 'SSE', '银行', 'eastmoney', ?)`,
      args: [now],
    })
    await db.execute({
      sql: `INSERT OR REPLACE INTO watchlist_items (code, note, created_at) VALUES ('600000.SH', NULL, ?)`,
      args: [now],
    })

    await expect(engine.refreshDesk({ tradeDate: TRADE_DATE, fetchImpl: failingFetch }))
      .rejects.toThrow('没有可聚合的行业行情')
  })

  it('自选只含指数时按空状态处理，不误报数据故障', async () => {
    const db = await dbModule.getDb()
    const now = new Date().toISOString()
    await db.execute({ sql: "DELETE FROM watchlist_items WHERE code = '600000.SH'", args: [] })
    await db.execute({
      sql: `INSERT OR REPLACE INTO watchlist_items (code, note, created_at) VALUES ('000001.SH', NULL, ?)`,
      args: [now],
    })

    const result = await engine.refreshDesk({ tradeDate: TRADE_DATE, fetchImpl: failingFetch })
    expect(result.industries).toBe(0)
    expect(result.judgments).toBe(1)
    expect(result.warnings.some((warning) => warning.includes('研究池'))).toBe(true)
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
