import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * Tushare 适配器用固定响应验证口径：广度只数沪深、成交额换算为亿元、
 * 手→股与千元→元；涨跌停接口失败时必须明确降级而不是写 0；
 * 库里一旦有示例行情就拒绝接入真实源。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-tushare-test-'))
let tushare: typeof import('../lib/cockpit/sources/tushare')
let tushareApi: typeof import('../lib/cockpit/sources/tushare')
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

function table(fields: string[], items: unknown[][]) {
  return response({ code: 0, msg: '', data: { fields, items } })
}

const CALENDAR_ROWS = [
  ['SSE', '20261020', 1, '20261019'],
  ['SSE', '20261021', 1, '20261020'],
  ['SSE', '20261022', 1, '20261021'],
  ['SSE', '20261023', 1, '20261022'],
  ['SSE', '20261024', 0, '20261023'],
]

const ALL_MARKET_ROWS = [
  ['600519.SH', '20261022', 1580, 1620, 1570, 1600, 1580, 2.5, 12345, 1_000_000],
  ['000001.SZ', '20261022', 11, 11.1, 10.8, 10.9, 11.03, -1.2, 20000, 2_000_000],
  ['300750.SZ', '20261022', 220, 221, 218, 220, 220, 0, 30000, 3_000_000],
  ['688001.SH', '20261022', 40, 42, 39.8, 42, 40, 5, 40000, 4_000_000],
]

function makeFetch({ limitFails = false, prevDailyEmpty = false } = {}): FetchLike {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}')) as {
      api_name: string
      params: Record<string, unknown>
    }
    switch (body.api_name) {
      case 'trade_cal':
        return table(['exchange', 'cal_date', 'is_open', 'pretrade_date'], CALENDAR_ROWS)
      case 'stock_basic':
        return table(
          ['ts_code', 'symbol', 'name', 'industry', 'market', 'exchange', 'list_date'],
          [['600519.SH', '600519', '贵州茅台', '白酒', '主板', 'SSE', '20010827']],
        )
      case 'index_daily': {
        const code = String(body.params.ts_code)
        return table(
          ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
          [
            [code, '20261021', 3000, 3050, 2980, 3020, 100000, 200000],
            [code, '20261022', 3020, 3080, 3010, 3070, 120000, 220000],
          ],
        )
      }
      case 'daily': {
        if (body.params.ts_code === '600519.SH') {
          return table(
            ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
            [
              ['600519.SH', '20261021', 1570, 1590, 1560, 1580, 10000, 900_000],
              ['600519.SH', '20261022', 1580, 1620, 1570, 1600, 12345, 1_000_000],
            ],
          )
        }
        if (prevDailyEmpty && body.params.trade_date === '20261021') {
          return table(
            ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
            [],
          )
        }
        return table(
          ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
          ALL_MARKET_ROWS,
        )
      }
      case 'limit_list_d': {
        if (limitFails) return response({ code: 40001, msg: 'limit_list_d 权限不足' }, false, 403)
        const type = String(body.params.limit_type)
        return table(
          ['ts_code', 'trade_date', 'limit_type'],
          type === 'U'
            ? [['600519.SH', '20261022', 'U'], ['688001.SH', '20261022', 'U']]
            : [['000001.SZ', '20261022', 'D']],
        )
      }
      default:
        return response({ code: 40002, msg: `unexpected ${body.api_name}` })
    }
  }) as unknown as FetchLike
}

describe('Tushare 收盘入库', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.TUSHARE_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'tushare.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    tushare = await import('../lib/cockpit/sources/tushare')
    tushareApi = tushare
    const db = await dbModule.getDb()
    await db.execute({
      sql: "INSERT INTO watchlist_items (code, note, created_at) VALUES ('600519.SH', '长期跟踪', ?)",
      args: [new Date().toISOString()],
    })
    await db.execute({
      sql: `INSERT INTO market_overview
            (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
            VALUES ('2026-10-21', '{}', ?, 'tushare', 0, ?)`,
      args: [JSON.stringify({ value: 80, changePct: 0 }), new Date().toISOString()],
    })
  })

  it('没有 token 时给出可操作的错误，而不是访问网络', async () => {
    const fetchImpl = vi.fn() as unknown as FetchLike
    await expect(tushareApi.ingestTushare({ tradeDate: '2026-10-22', fetchImpl }))
      .rejects.toThrow('Tushare token')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('用固定响应写入日线、广度、成交额与来源健康', async () => {
    const result = await tushareApi.ingestTushare({
      tradeDate: '2026-10-22',
      token: 'test-token',
      fetchImpl: makeFetch(),
    })

    expect(result.tradeDate).toBe('2026-10-22')
    expect(result.breadth).toEqual({ up: 2, down: 1, flat: 1, limitUp: 2, limitDown: 1 })
    expect(result.limitUpDownAvailable).toBe(true)
    expect(result.turnover).toEqual({ value: 100, changePct: 25 })
    expect(result.indices).toBe(3)
    expect(result.universe).toBe(1)
    // 3 个指数 × 2 根 + 自选股 2 根
    expect(result.bars).toBe(8)
    expect(result.warnings).toEqual([])

    const db = await dbModule.getDb()
    const bar = await db.execute({
      sql: `SELECT close, volume, amount, source_id, is_demo FROM market_bars
            WHERE code = '600519.SH' AND trade_date = '2026-10-22' AND adjust_type = 'raw'`,
      args: [],
    })
    expect(Number(bar.rows[0]?.close)).toBe(1600)
    expect(Number(bar.rows[0]?.volume)).toBe(1_234_500) // 手 → 股
    expect(Number(bar.rows[0]?.amount)).toBe(1_000_000_000) // 千元 → 元
    expect(bar.rows[0]?.source_id).toBe('tushare')
    expect(Number(bar.rows[0]?.is_demo)).toBe(0)

    const overview = await db.execute({
      sql: 'SELECT breadth_json, turnover_json FROM market_overview WHERE trade_date = ?',
      args: ['2026-10-22'],
    })
    const breadth = JSON.parse(String(overview.rows[0]?.breadth_json))
    expect(breadth).toMatchObject({ up: 2, down: 1, flat: 1, limitUp: 2, limitDown: 1 })
    expect(breadth.limitUpDownAvailable).toBe(true)
    expect(JSON.parse(String(overview.rows[0]?.turnover_json))).toEqual({ value: 100, changePct: 25 })

    const source = await db.execute({
      sql: "SELECT enabled, last_error, consecutive_failures FROM source_registry WHERE id = 'tushare'",
      args: [],
    })
    expect(Number(source.rows[0]?.enabled)).toBe(1)
    expect(source.rows[0]?.last_error).toBeNull()
    expect(Number(source.rows[0]?.consecutive_failures)).toBe(0)

    const calendar = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM trading_calendar WHERE is_open = 1',
      args: [],
    })
    expect(Number(calendar.rows[0]?.n)).toBe(4)
  })

  it('显式历史日期按锚点取 30 天日历窗口，而不是沿用今天', async () => {
    const db = await dbModule.getDb()
    await db.execute({ sql: 'DELETE FROM trading_calendar', args: [] })
    const fetchImpl = makeFetch()

    await tushareApi.ensureTradingCalendar({
      anchorDate: '2026-10-21',
      token: 'test-token',
      fetchImpl,
    })

    const calls = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls
      .map(([, init]) => JSON.parse(String(init?.body || '{}')) as {
        api_name: string
        params: Record<string, unknown>
      })
    const calendarCall = calls.filter((call) => call.api_name === 'trade_cal').pop()
    expect(calendarCall?.params).toMatchObject({
      start_date: '20260921',
      end_date: '20261021',
    })

    const open = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM trading_calendar WHERE is_open = 1",
      args: [],
    })
    expect(Number(open.rows[0]?.n)).toBe(4)
  })

  it('前一日成交额缺失时记 null 并警告，不伪造 0%', async () => {
    const db = await dbModule.getDb()
    await db.execute({ sql: "DELETE FROM market_overview WHERE trade_date = '2026-10-21'", args: [] })

    const result = await tushareApi.ingestTushare({
      tradeDate: '2026-10-22',
      token: 'test-token',
      fetchImpl: makeFetch({ prevDailyEmpty: true }),
    })

    expect(result.turnover).toEqual({ value: 100, changePct: null })
    expect(result.warnings.join(' ')).toContain('前一开市日成交额不可用')
    const overview = await db.execute({
      sql: 'SELECT turnover_json FROM market_overview WHERE trade_date = ?',
      args: ['2026-10-22'],
    })
    expect(JSON.parse(String(overview.rows[0]?.turnover_json))).toEqual({ value: 100, changePct: null })
  })

  it('涨跌停接口失败时标记不可用并保留其它数据', async () => {
    const result = await tushareApi.ingestTushare({
      tradeDate: '2026-10-22',
      token: 'test-token',
      fetchImpl: makeFetch({ limitFails: true }),
    })
    expect(result.limitUpDownAvailable).toBe(false)
    expect(result.warnings.join(' ')).toContain('涨跌停统计不可用')

    const db = await dbModule.getDb()
    const overview = await db.execute({
      sql: 'SELECT breadth_json FROM market_overview WHERE trade_date = ?',
      args: ['2026-10-22'],
    })
    expect(JSON.parse(String(overview.rows[0]?.breadth_json)).limitUpDownAvailable).toBe(false)
  })

  it('库里出现示例行情后拒绝真实入库，且不发起网络请求', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO market_bars
            (code, trade_date, close, source_id, fetched_at, is_demo)
            VALUES ('999999.SH', '2026-10-19', 1, 'demo-tushare', ?, 1)`,
      args: [new Date().toISOString()],
    })
    const fetchImpl = vi.fn() as unknown as FetchLike
    await expect(tushareApi.ingestTushare({ tradeDate: '2026-10-22', token: 'test-token', fetchImpl }))
      .rejects.toThrow('示例行情')
    expect(fetchImpl).not.toHaveBeenCalled()
    await db.execute({ sql: "DELETE FROM market_bars WHERE code = '999999.SH'", args: [] })
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
