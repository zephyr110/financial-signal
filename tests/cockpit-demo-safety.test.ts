import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { dateShanghai } from '../lib/cockpit/format'

/** 示例数据只能在空库铺底；已有真实记录时既不能混入，也不能覆盖。 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-demo-safety-test-'))
let demo: typeof import('../lib/cockpit/demo')
let dbModule: typeof import('../lib/db')

describe('cockpit demo seed safety', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'demo-safety.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    demo = await import('../lib/cockpit/demo')
  })

  it('已有真实标的与行情时不写任何示例数据', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
            VALUES ('600519.SH', '真实白酒', 'SSE', '食品饮料', 'tushare', '2026-10-22T08:00:00.000Z')`,
      args: [],
    })
    await db.execute({
      sql: `INSERT INTO market_bars
            (code, trade_date, open, high, low, close, volume, amount, source_id, fetched_at, is_demo)
            VALUES ('600519.SH', '2026-10-22', 1500, 1520, 1490, 1510, 100, 151000, 'tushare', '2026-10-22T08:00:00.000Z', 0)`,
      args: [],
    })

    const result = await demo.ensureCockpitDemoSeed()
    expect(result.seeded).toBe(false)

    const symbol = await db.execute({
      sql: "SELECT name, source_id FROM symbols WHERE code = '600519.SH'",
      args: [],
    })
    expect(symbol.rows[0]?.name).toBe('真实白酒')
    expect(symbol.rows[0]?.source_id).toBe('tushare')

    const bars = await db.execute({
      sql: "SELECT close, is_demo FROM market_bars WHERE code = '600519.SH'",
      args: [],
    })
    expect(bars.rows).toHaveLength(1)
    expect(Number(bars.rows[0]?.close)).toBe(1510)
    expect(Number(bars.rows[0]?.is_demo)).toBe(0)

    const demoBars = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM market_bars WHERE is_demo = 1',
      args: [],
    })
    expect(Number(demoBars.rows[0]?.n)).toBe(0)

    const marker = await db.execute({
      sql: "SELECT value FROM app_settings WHERE key = 'cockpit_demo_seed_v1'",
      args: [],
    })
    expect(marker.rows[0]).toBeUndefined()
  })

  it('凌晨时间戳按上海日期而不是 UTC 日期展示', () => {
    expect(dateShanghai('2026-10-21T17:00:00.000Z')).toBe('2026-10-22')
    expect(dateShanghai('2026-10-21T03:00:00.000Z')).toBe('2026-10-21')
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
