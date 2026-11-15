import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

/**
 * P13：可选付费快照源。未配置零请求；无延迟标注的数据一律丢弃，绝不当作实时。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'realtime-source-test-'))
let dbModule: typeof import('../lib/db')
let realtime: typeof import('../lib/cockpit/sources/realtime')

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('optional realtime source', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.REALTIME_SOURCE_URL
    delete process.env.REALTIME_SOURCE_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'realtime.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    realtime = await import('../lib/cockpit/sources/realtime')
    await dbModule.getDb()
  })

  beforeEach(() => {
    delete process.env.REALTIME_SOURCE_URL
    delete process.env.REALTIME_SOURCE_TOKEN
  })

  it('未配置时不发任何请求', async () => {
    const fetchImpl = vi.fn()
    const result = await realtime.refreshRealtimeFeed({ fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(result.configured).toBe(false)
    expect(result.quotes).toBe(0)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('写入带延迟标注的行情与快讯，缺延迟的条目被丢弃', async () => {
    let seenAuth = ''
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization || ''
      return jsonResponse({
        quotes: [
          {
            code: '600519.SH',
            name: '贵州茅台',
            price: 1700,
            previousClose: 1690,
            tradeTime: '2026-11-14T06:30:00Z',
            delaySeconds: 15,
          },
          { code: '000001.SZ', name: '平安银行', price: 11.2, tradeTime: '2026-11-14T06:30:00Z' },
        ],
        news: [
          {
            id: 'n-1',
            title: '某公司上调业绩指引',
            publishedAt: '2026-11-14T06:00:00Z',
            summary: '指引上调',
            delaySeconds: 60,
          },
          // null 必须算缺失，不能被 Number(null)=0 读成实时
          { id: 'n-2', title: '延迟字段为空的快讯', delaySeconds: null },
        ],
      })
    })
    const result = await realtime.refreshRealtimeFeed({
      url: 'https://feed.example.com/snapshot',
      token: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result).toMatchObject({ configured: true, quotes: 1, news: 1, skipped: 2 })
    expect(result.warnings.join('')).toContain('延迟标注')

    const db = await dbModule.getDb()
    const quote = await db.execute({ sql: "SELECT * FROM realtime_quotes WHERE code = '600519.SH'", args: [] })
    expect(Number(quote.rows[0].delay_seconds)).toBe(15)
    expect(Number(quote.rows[0].is_demo)).toBe(0)
    const missing = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM realtime_quotes WHERE code = '000001.SZ'",
      args: [],
    })
    expect(Number(missing.rows[0].n)).toBe(0)

    const docs = await db.execute({
      sql: "SELECT * FROM source_documents WHERE source_id = 'realtime'",
      args: [],
    })
    expect(docs.rows).toHaveLength(1)
    const metadata = JSON.parse(String(docs.rows[0].metadata_json)) as { delay_seconds: number }
    expect(metadata.delay_seconds).toBe(60)

    const health = await db.execute({
      sql: "SELECT enabled FROM source_registry WHERE id = 'realtime'",
      args: [],
    })
    expect(Number(health.rows[0].enabled)).toBe(1)

    expect(seenAuth).toBe('Bearer secret-token')
  })

  it('全部缺延迟时标记来源故障且不写数据', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      quotes: [{ code: '600000.SH', price: 9.9, tradeTime: '2026-11-14T06:30:00Z' }],
      news: [],
    }))
    const result = await realtime.refreshRealtimeFeed({
      url: 'https://feed.example.com/snapshot',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(result.quotes).toBe(0)
    expect(result.warnings.length).toBeGreaterThan(0)

    const db = await dbModule.getDb()
    const row = await db.execute({
      sql: "SELECT consecutive_failures FROM source_registry WHERE id = 'realtime'",
      args: [],
    })
    expect(Number(row.rows[0].consecutive_failures)).toBeGreaterThan(0)
  })

  it('含示例数据的库拒绝接入，请求也不发出', async () => {
    const db = await dbModule.getDb()
    const now = new Date().toISOString()
    await db.execute({
      sql: `INSERT INTO market_bars (code, trade_date, close, source_id, fetched_at, is_demo)
            VALUES ('000001.SZ', '2026-11-14', 11.2, 'demo', ?, 1)`,
      args: [now],
    })
    const fetchImpl = vi.fn()
    await expect(realtime.refreshRealtimeFeed({
      url: 'https://feed.example.com/snapshot',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(/示例/)
    expect(fetchImpl).not.toHaveBeenCalled()
    await db.execute({ sql: 'DELETE FROM market_bars WHERE is_demo = 1', args: [] })
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
