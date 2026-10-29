import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

/**
 * AKShare（T2）适配器：单位由侧车统一为股/元；已有 T0/T1 同键日线必须原样保留；
 * 未配置时明确跳过；空数据与 schema 漂移不能被当成 0 静默入库。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-akshare-test-'))
let akshare: typeof import('../lib/cockpit/sources/akshare')
let dbModule: typeof import('../lib/db')

type FetchLike = typeof fetch

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response
}

const BAR_ROWS = [
  {
    trade_date: '2026-10-21', open: 100, high: 105, low: 99, close: 104,
    volume: 1_234_500, amount: 128_000_000,
  },
  {
    trade_date: '2026-10-22', open: 104, high: 110, low: 103, close: 109,
    volume: 2_000_000, amount: 218_000_000,
  },
]

function makeFetch(options: {
  bars?: unknown
  items?: unknown
  dailyStatus?: number
  poolStatus?: number
  empty?: boolean
  badCode?: boolean
} = {}): FetchLike {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    if (options.dailyStatus && url.pathname === '/v1/daily') {
      return response({ error: { message: 'boom' } }, false, options.dailyStatus)
    }
    if (options.poolStatus && url.pathname === '/v1/limit-pool') {
      return response({ error: { message: 'boom' } }, false, options.poolStatus)
    }
    if (url.pathname === '/v1/daily') {
      expect(url.searchParams.get('code')).toBe('600519.SH')
      expect(url.searchParams.get('end')).toBe('2026-10-22')
      return response({
        code: options.badCode ? '000001.SZ' : '600519.SH',
        bars: options.empty ? [] : (options.bars ?? BAR_ROWS),
        warnings: options.empty ? ['无日线数据'] : [],
      })
    }
    if (url.pathname === '/v1/limit-pool') {
      return response({
        trade_date: '2026-10-22',
        items: options.items ?? [{
          code: '688001.SH', name: '华兴源创', latest_price: 42.5, pct_change: 20.01,
          amount: 500_000_000, turnover_rate: 6.2, seal_amount: 180_000_000,
          first_seal_time: '09:31:00', last_seal_time: '14:55:00', open_times: 1,
          limit_up_stats: '2/1', streak: 1, industry: '专用设备',
        }],
        warnings: [],
      })
    }
    return response({ error: 'unexpected' }, false, 404)
  }) as unknown as FetchLike
}

describe('AKShare（T2）补充入库', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.AKSHARE_SIDECAR_URL
    delete process.env.AKSHARE_SIDECAR_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'akshare.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    akshare = await import('../lib/cockpit/sources/akshare')
    const db = await dbModule.getDb()
    const now = new Date().toISOString()
    await db.execute({
      sql: "INSERT INTO watchlist_items (code, note, created_at) VALUES ('600519.SH', '长期跟踪', ?)",
      args: [now],
    })
  })

  beforeEach(async () => {
    const db = await dbModule.getDb()
    await db.execute({ sql: 'DELETE FROM market_bars', args: [] })
    await db.execute({ sql: 'DELETE FROM limit_pool', args: [] })
  })

  it('未配置侧车时明确跳过，不发请求也不写库', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike
    const result = await akshare.ingestAkshare({ tradeDate: '2026-10-22', fetchImpl })
    expect(result.configured).toBe(false)
    expect(result.bars).toBe(0)
    expect(result.warnings[0]).toContain('未配置')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('只配置一半时抛错，避免误以为已启用', async () => {
    await expect(akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765',
      token: '',
      fetchImpl: makeFetch(),
    })).rejects.toThrow('配置不完整')
  })

  it('写入日线与涨停池，并记录 T2 来源', async () => {
    const result = await akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765/',
      token: 'test-token',
      fetchImpl: makeFetch(),
    })
    expect(result).toMatchObject({
      configured: true,
      tradeDate: '2026-10-22',
      codes: 1,
      bars: 2,
      insertedBars: 2,
      limitPool: 1,
      limitPoolWritten: 1,
    })

    const db = await dbModule.getDb()
    const bars = await db.execute({
      sql: "SELECT code, trade_date, close, volume, amount, source_id, is_demo FROM market_bars ORDER BY trade_date",
      args: [],
    })
    expect(bars.rows).toHaveLength(2)
    expect(bars.rows[1]).toMatchObject({
      code: '600519.SH', trade_date: '2026-10-22', close: 109,
      volume: 2_000_000, amount: 218_000_000, source_id: 'akshare', is_demo: 0,
    })

    const pool = await db.execute({
      sql: 'SELECT * FROM limit_pool WHERE trade_date = ?',
      args: ['2026-10-22'],
    })
    expect(pool.rows).toHaveLength(1)
    expect(pool.rows[0]).toMatchObject({
      code: '688001.SH', name: '华兴源创', streak: 1,
      first_seal_time: '09:31:00', source_id: 'akshare',
    })

    const source = await db.execute({
      sql: "SELECT tier, enabled FROM source_registry WHERE id = 'akshare'",
      args: [],
    })
    expect(source.rows[0]).toMatchObject({ tier: 2, enabled: 1 })
  })

  it('不覆盖已有的 T1 同键日线', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT OR REPLACE INTO market_bars
            (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
             source_id, fetched_at, is_demo)
            VALUES ('600519.SH', '2026-10-22', 1, 1, 1, 1, 1, 1, 1, 'raw', 'tushare', '2026-10-22T08:00:00Z', 0)`,
      args: [],
    })

    const result = await akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      fetchImpl: makeFetch(),
    })

    expect(result.insertedBars).toBe(1)
    expect(result.warnings.some((warning) => warning.includes('保留原来源'))).toBe(true)
    const row = await db.execute({
      sql: "SELECT close, source_id FROM market_bars WHERE code = '600519.SH' AND trade_date = '2026-10-22'",
      args: [],
    })
    expect(row.rows[0]).toMatchObject({ close: 1, source_id: 'tushare' })
  })

  it('重复执行时日线不重复插入，涨停池按同日同代码更新', async () => {
    const options = {
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      fetchImpl: makeFetch(),
    }
    await akshare.ingestAkshare(options)
    const second = await akshare.ingestAkshare(options)
    expect(second.insertedBars).toBe(0)

    const db = await dbModule.getDb()
    const bars = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM market_bars', args: [] })
    const pool = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM limit_pool', args: [] })
    expect(Number(bars.rows[0].n)).toBe(2)
    expect(Number(pool.rows[0].n)).toBe(1)
  })

  it('空日线保留警告，不写入 0 价格', async () => {
    const result = await akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      fetchImpl: makeFetch({ empty: true }),
    })
    expect(result.bars).toBe(0)
    expect(result.insertedBars).toBe(0)
    expect(result.warnings.join(' ')).toContain('无日线数据')
  })

  it('日线代码不一致时保留警告，涨停池仍可入库', async () => {
    const result = await akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      fetchImpl: makeFetch({ badCode: true }),
    })
    expect(result.bars).toBe(0)
    expect(result.limitPoolWritten).toBe(1)
    expect(result.warnings.join(' ')).toContain('代码与请求不一致')
  })

  it('日线全部失败但涨停池成功时，任务保留部分结果并给出警告', async () => {
    const result = await akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      fetchImpl: makeFetch({ dailyStatus: 502 }),
    })
    expect(result.configured).toBe(true)
    expect(result.bars).toBe(0)
    expect(result.insertedBars).toBe(0)
    expect(result.limitPoolWritten).toBe(1)
    expect(result.warnings.join(' ')).toContain('日线未取到')
  })

  it('日线与涨停池都失败时抛错并记录来源失败', async () => {
    await expect(akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'http://127.0.0.1:8765',
      token: 'test-token',
      fetchImpl: makeFetch({ dailyStatus: 502, poolStatus: 502 }),
    })).rejects.toThrow('HTTP 502')

    const db = await dbModule.getDb()
    const source = await db.execute({
      sql: "SELECT enabled, consecutive_failures FROM source_registry WHERE id = 'akshare'",
      args: [],
    })
    expect(Number(source.rows[0].consecutive_failures)).toBeGreaterThan(0)
  })

  it('拒绝非 http/https 的侧车地址', async () => {
    await expect(akshare.ingestAkshare({
      tradeDate: '2026-10-22',
      baseUrl: 'file:///tmp/sidecar',
      token: 'test-token',
      fetchImpl: makeFetch(),
    })).rejects.toThrow('只支持 http/https')
  })
})
