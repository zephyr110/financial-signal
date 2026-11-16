import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

/**
 * 免费源适配器用固定响应验证口径与降级：手→股、元→亿元、广度只数沪深、
 * 涨停池 ÷1000 与时间格式、T1 同键行情不被覆盖、东财失败后按新浪/腾讯降级，
 * 以及涨跌停池日期不符时宁可不写也不落到错误交易日。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-free-test-'))
let free: typeof import('../lib/cockpit/sources/free')
let market: typeof import('../lib/cockpit/sources/market')
let dbModule: typeof import('../lib/db')

type FetchLike = typeof fetch

// 上海 17:00，已过收盘稳定时间
const FIXED_NOW = new Date('2026-10-23T09:00:00Z')
const TRADE_DATE = '2026-10-23'
const OPEN_DATES = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']

function response(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response
}

function failure(status = 500): Response {
  return {
    ok: false,
    status,
    json: async () => ({ error: 'upstream' }),
    text: async () => 'upstream error',
  } as Response
}

interface DayBar {
  date: string
  open: number
  close: number
  high: number
  low: number
  volume: number // 手
  amount: number // 元
}

const DAILY: Record<string, DayBar[]> = {
  '000001.SH': [
    { date: '2026-10-21', open: 3000, close: 3020, high: 3030, low: 2990, volume: 100_000, amount: 200_000_000_000 },
    { date: '2026-10-22', open: 3020, close: 3050, high: 3060, low: 3010, volume: 110_000, amount: 210_000_000_000 },
    { date: '2026-10-23', open: 3050, close: 3070, high: 3080, low: 3040, volume: 120_000, amount: 220_000_000_000 },
  ],
  '399001.SZ': [
    { date: '2026-10-21', open: 9500, close: 9550, high: 9600, low: 9450, volume: 90_000, amount: 150_000_000_000 },
    { date: '2026-10-22', open: 9550, close: 9600, high: 9650, low: 9500, volume: 95_000, amount: 160_000_000_000 },
    { date: '2026-10-23', open: 9600, close: 9650, high: 9700, low: 9550, volume: 99_000, amount: 170_000_000_000 },
  ],
  '399006.SZ': [
    { date: '2026-10-21', open: 1900, close: 1920, high: 1930, low: 1890, volume: 70_000, amount: 90_000_000_000 },
    { date: '2026-10-22', open: 1920, close: 1935, high: 1945, low: 1910, volume: 72_000, amount: 92_000_000_000 },
    { date: '2026-10-23', open: 1935, close: 1950, high: 1960, low: 1930, volume: 75_000, amount: 95_000_000_000 },
  ],
  '600519.SH': [
    { date: '2026-10-22', open: 1570, close: 1580, high: 1590, low: 1560, volume: 10_000, amount: 900_000_000 },
    { date: '2026-10-23', open: 1580, close: 1600, high: 1620, low: 1570, volume: 12_345, amount: 1_000_000_000 },
  ],
}

const SECID_CODES: Record<string, string> = {
  '1.000001': '000001.SH',
  '0.399001': '399001.SZ',
  '0.399006': '399006.SZ',
  '1.600519': '600519.SH',
}

const SYMBOL_CODES: Record<string, string> = {
  sh000001: '000001.SH',
  sz399001: '399001.SZ',
  sz399006: '399006.SZ',
  sh600519: '600519.SH',
}

const SNAPSHOT_ROWS = [
  { f12: '600519', f14: '贵州茅台', f100: '白酒', f2: 1600, f3: 2.5, f6: 2_000_000_000 },
  { f12: '000001', f14: '平安银行', f100: '银行', f2: 11, f3: -1.2, f6: 1_000_000_000 },
  { f12: '300750', f14: '宁德时代', f100: '电池', f2: 220, f3: 0, f6: 300_000_000 },
  { f12: '830799', f14: '艾融软件', f100: '-', f2: 10, f3: 9.9, f6: 100_000_000 },
]

const ZT_POOL = [
  {
    c: '600519', n: '贵州茅台', p: 1_600_000, zdp: 10.01, amount: 500_000_000, hs: 1.2,
    fund: 100_000_000, fbt: 93000, lbt: 145959, zbc: 2, lbc: 3,
    zttj: { days: 5, ct: 3 }, hybk: '白酒',
  },
  {
    c: '300750', n: '宁德时代', p: 220_000, zdp: 9.99, amount: 200_000_000, hs: 0.8,
    fund: 50_000_000, fbt: 100500, lbt: 143000, zbc: 0, lbc: 1,
    zttj: { days: 1, ct: 1 }, hybk: '电池',
  },
]

const DT_POOL = [
  { c: '000001', n: '平安银行', p: 11_000, zdp: -10, amount: 100_000_000, hs: 0.5, fund: 10_000_000, oc: 1, days: 2, hybk: '银行' },
]

interface FetchOptions {
  eastmoneyBars?: 'ok' | 'fail' | 'empty'
  sinaBars?: 'ok' | 'fail' | 'empty'
  tencentBars?: 'ok' | 'fail'
  snapshot?: 'ok' | 'fail'
  pool?: 'ok' | 'fail' | 'bad-qdate'
  tushare?: 'ok' | 'fail'
}

function makeFetch(options: FetchOptions = {}): FetchLike {
  const handler = vi.fn(async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = new URL(String(input))
    const host = url.hostname

    if (host === 'api.tushare.pro') {
      if (options.tushare === 'fail') return response({ code: 40001, msg: '积分不足' })
      const body = JSON.parse(String(init?.body || '{}')) as { api_name: string; params: Record<string, unknown> }
      switch (body.api_name) {
        case 'trade_cal':
          return response({
            code: 0,
            msg: '',
            data: {
              fields: ['exchange', 'cal_date', 'is_open', 'pretrade_date'],
              items: OPEN_DATES.map((date) => ['SSE', date.replace(/-/g, ''), 1, '']),
            },
          })
        case 'stock_basic':
          return response({
            code: 0,
            msg: '',
            data: {
              fields: ['ts_code', 'symbol', 'name', 'industry', 'market', 'exchange', 'list_date'],
              items: [['600519.SH', '600519', '贵州茅台', '白酒', '主板', 'SSE', '20010827']],
            },
          })
        case 'index_daily': {
          const code = String(body.params.ts_code)
          return response({
            code: 0,
            msg: '',
            data: {
              fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'vol', 'amount'],
              items: [
                [code, '20261022', 3000, 3050, 2980, 3020, 100_000, 200_000],
                [code, '20261023', 3020, 3080, 3010, 3070, 120_000, 220_000],
              ],
            },
          })
        }
        case 'daily':
          return response({
            code: 0,
            msg: '',
            data: {
              fields: ['ts_code', 'trade_date', 'open', 'high', 'low', 'close', 'pre_close', 'pct_chg', 'vol', 'amount'],
              items: [
                ['600519.SH', '20261023', 1580, 1620, 1570, 1600, 1580, 2.5, 12_345, 100_000],
                ['000001.SZ', '20261023', 11, 11.1, 10.8, 10.9, 11.03, -1.2, 20_000, 50_000],
                ['830799.BJ', '20261023', 10, 10.2, 9.9, 10.1, 10, 1, 5_000, 10_000],
              ],
            },
          })
        case 'limit_list_d':
          // 120 积分没有该接口权限
          return response({ code: 40203, msg: '没有接口访问权限' })
        default:
          return response({ code: 40002, msg: `unexpected ${body.api_name}` })
      }
    }

    if (host === 'push2his.eastmoney.com') {
      if (options.eastmoneyBars === 'fail') return failure()
      if (options.eastmoneyBars === 'empty') return response({ data: { klines: [] } })
      const code = SECID_CODES[url.searchParams.get('secid') || ''] || ''
      const bars = code ? DAILY[code] || [] : []
      return response({
        data: {
          klines: bars.map((bar) =>
            `${bar.date},${bar.open},${bar.close},${bar.high},${bar.low},${bar.volume},${bar.amount}`),
        },
      })
    }

    if (host === 'push2.eastmoney.com') {
      if (options.snapshot === 'fail') return failure()
      return response({ data: { total: SNAPSHOT_ROWS.length, diff: SNAPSHOT_ROWS } })
    }

    if (host === 'push2ex.eastmoney.com') {
      if (options.pool === 'fail') return failure()
      const isDown = url.pathname.includes('getTopicDTPool')
      const pool = isDown ? DT_POOL : ZT_POOL
      const qdate = options.pool === 'bad-qdate' ? '20261026' : '20261023'
      return response({ data: { qdate, tc: pool.length, pool } })
    }

    if (host === 'money.finance.sina.com.cn') {
      if (options.sinaBars === 'fail') return failure()
      if (options.sinaBars === 'empty') return response([])
      const code = SYMBOL_CODES[url.searchParams.get('symbol') || ''] || ''
      const bars = code ? DAILY[code] || [] : []
      // 新浪成交量已经是股
      return response(bars.map((bar) => ({
        day: bar.date,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume * 100,
      })))
    }

    if (host === 'web.ifzq.gtimg.cn') {
      if (options.tencentBars === 'fail') return failure()
      const symbol = (url.searchParams.get('param') || '').split(',')[0]
      const code = SYMBOL_CODES[symbol] || ''
      const bars = code ? DAILY[code] || [] : []
      return response({
        data: {
          [symbol]: {
            day: bars.map((bar) => [
              bar.date, bar.open, bar.close, bar.high, bar.low, bar.volume,
            ]),
          },
        },
      })
    }

    return failure(404)
  })
  return handler as unknown as FetchLike
}

function calledUrls(fetchImpl: FetchLike): string[] {
  const mock = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock
  return mock.calls.map((call) => String(call[0]))
}

async function clearDatabase(): Promise<void> {
  const db = await dbModule.getDb()
  for (const sql of [
    'DELETE FROM watchlist_items',
    'DELETE FROM market_bars',
    'DELETE FROM market_overview',
    'DELETE FROM limit_pool',
    'DELETE FROM symbols',
    'DELETE FROM trading_calendar',
    'DELETE FROM source_registry',
  ]) {
    await db.execute({ sql, args: [] })
  }
}

async function addWatchlist(code: string): Promise<void> {
  const db = await dbModule.getDb()
  await db.execute({
    sql: 'INSERT INTO watchlist_items (code, note, created_at) VALUES (?, ?, ?)',
    args: [code, '测试', new Date().toISOString()],
  })
}

describe('免费行情源兜底链', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.TUSHARE_TOKEN
    delete process.env.AKSHARE_SIDECAR_URL
    delete process.env.AKSHARE_SIDECAR_TOKEN
    delete process.env.COCKPIT_DEMO
    process.env.NEWS_DB_PATH = path.join(dir, 'free.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    free = await import('../lib/cockpit/sources/free')
    market = await import('../lib/cockpit/sources/market')
    await dbModule.getDb()
  })

  beforeEach(async () => {
    delete process.env.TUSHARE_TOKEN
    free.resetFreeSourceCooldownsForTests()
    free.setFreeSourceClockForTests(FIXED_NOW)
    await clearDatabase()
  })

  it('东财全链路：手→股、成交额亿元、广度排除北交所、涨停池与概览入库', async () => {
    const db = await dbModule.getDb()
    await addWatchlist('600519.SH')
    const now = new Date().toISOString()
    await db.execute({
      sql: `INSERT INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES ('2026-10-22', 1, 'eastmoney', ?)`,
      args: [now],
    })
    await db.execute({
      sql: `INSERT INTO market_overview
            (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
            VALUES ('2026-10-22', '{}', ?, 'eastmoney', 0, ?)`,
      args: [JSON.stringify({ value: 30, changePct: null }), now],
    })

    const result = await free.ingestFreeMarket({
      tradeDate: TRADE_DATE,
      openDates: OPEN_DATES,
      fetchImpl: makeFetch(),
    })

    expect(result.tradeDate).toBe(TRADE_DATE)
    expect(result.source).toBe('eastmoney')
    expect(result.indices).toBe(3)
    expect(result.universe).toBe(1)
    expect(result.bars).toBe(11) // 3 指数 × 3 天 + 自选股 2 天
    expect(result.breadth).toEqual({
      up: 1, flat: 1, down: 1, limitUp: 2, limitDown: 1, limitUpDownAvailable: true,
    })
    expect(result.turnover).toEqual({ value: 33, changePct: 10 })
    expect(result.limitPoolWritten).toBe(2)
    expect(result.warnings).toEqual([])

    const bar = await db.execute({
      sql: `SELECT close, volume, amount, source_id FROM market_bars
            WHERE code = '600519.SH' AND trade_date = ? AND adjust_type = 'raw'`,
      args: [TRADE_DATE],
    })
    expect(Number(bar.rows[0]?.close)).toBe(1600)
    expect(Number(bar.rows[0]?.volume)).toBe(1_234_500) // 手 → 股
    expect(Number(bar.rows[0]?.amount)).toBe(1_000_000_000)
    expect(bar.rows[0]?.source_id).toBe('eastmoney')

    const pool = await db.execute({
      sql: `SELECT code, latest_price, first_seal_time, limit_up_stats
            FROM limit_pool WHERE trade_date = ? ORDER BY code`,
      args: [TRADE_DATE],
    })
    expect(pool.rows.length).toBe(2) // 只写涨停池，跌停只计数
    const maotai = pool.rows.find((row) => row.code === '600519.SH')
    expect(Number(maotai?.latest_price)).toBe(1600) // 东财价格 ÷1000
    expect(maotai?.first_seal_time).toBe('09:30:00')
    expect(maotai?.limit_up_stats).toBe('5天3板')

    const overview = await db.execute({
      sql: 'SELECT breadth_json, turnover_json, source_id FROM market_overview WHERE trade_date = ?',
      args: [TRADE_DATE],
    })
    expect(overview.rows[0]?.source_id).toBe('eastmoney')
    expect(JSON.parse(String(overview.rows[0]?.breadth_json))).toMatchObject({
      up: 1, flat: 1, down: 1, limitUp: 2, limitDown: 1, limitUpDownAvailable: true,
    })
    expect(JSON.parse(String(overview.rows[0]?.turnover_json))).toEqual({ value: 33, changePct: 10 })

    const symbol = await db.execute({
      sql: "SELECT industry_l1 FROM symbols WHERE code = '600519.SH'",
      args: [],
    })
    expect(symbol.rows[0]?.industry_l1).toBe('白酒')

    const bjSymbol = await db.execute({
      sql: "SELECT industry_l1 FROM symbols WHERE code = '830799.BJ'",
      args: [],
    })
    expect(bjSymbol.rows[0]?.industry_l1).toBeNull()

    const source = await db.execute({
      sql: "SELECT enabled, last_error FROM source_registry WHERE id = 'eastmoney'",
      args: [],
    })
    expect(Number(source.rows[0]?.enabled)).toBe(1)
    expect(source.rows[0]?.last_error).toBeNull()
  })

  it('已有 T1 日线与概览不被免费源覆盖', async () => {
    const db = await dbModule.getDb()
    await addWatchlist('600519.SH')
    const now = new Date().toISOString()
    await db.execute({
      sql: `INSERT INTO market_bars
            (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
             source_id, fetched_at, is_demo)
            VALUES ('600519.SH', ?, 1690, 1710, 1680, 1700, 5000, 850000000, 1, 'raw', 'tushare', ?, 0)`,
      args: [TRADE_DATE, now],
    })
    await db.execute({
      sql: `INSERT INTO market_overview
            (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
            VALUES (?, '{"up":9}', '{"value":99,"changePct":null}', 'tushare', 0, ?)`,
      args: [TRADE_DATE, now],
    })

    const result = await free.ingestFreeMarket({
      tradeDate: TRADE_DATE,
      openDates: OPEN_DATES,
      fetchImpl: makeFetch(),
    })
    expect(result.breadth).not.toBeNull()

    const bar = await db.execute({
      sql: `SELECT close, source_id FROM market_bars
            WHERE code = '600519.SH' AND trade_date = ? AND adjust_type = 'raw'`,
      args: [TRADE_DATE],
    })
    expect(Number(bar.rows[0]?.close)).toBe(1700)
    expect(bar.rows[0]?.source_id).toBe('tushare')

    const overview = await db.execute({
      sql: 'SELECT breadth_json, source_id FROM market_overview WHERE trade_date = ?',
      args: [TRADE_DATE],
    })
    expect(overview.rows[0]?.source_id).toBe('tushare')
    expect(String(overview.rows[0]?.breadth_json)).toBe('{"up":9}')
  })

  it('东财不可用时降级新浪，日线标新浪来源且不产出广度', async () => {
    const db = await dbModule.getDb()
    await addWatchlist('600519.SH')

    const result = await free.ingestFreeMarket({
      tradeDate: TRADE_DATE,
      openDates: OPEN_DATES,
      fetchImpl: makeFetch({ eastmoneyBars: 'fail', snapshot: 'fail', pool: 'fail' }),
    })

    expect(result.source).toBe('sina')
    expect(result.breadth).toBeNull()
    expect(result.turnover).toBeNull()
    expect(result.limitUpDownAvailable).toBe(false)
    expect(result.warnings.join(' ')).toContain('全市场快照不可用')

    const bar = await db.execute({
      sql: `SELECT close, volume, source_id FROM market_bars
            WHERE code = '600519.SH' AND trade_date = ? AND adjust_type = 'raw'`,
      args: [TRADE_DATE],
    })
    expect(Number(bar.rows[0]?.close)).toBe(1600)
    expect(Number(bar.rows[0]?.volume)).toBe(1_234_500) // 新浪已是股，不再 ×100
    expect(bar.rows[0]?.source_id).toBe('sina')

    const overview = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM market_overview WHERE trade_date = ?',
      args: [TRADE_DATE],
    })
    expect(Number(overview.rows[0]?.n)).toBe(0)
  })

  it('东财与新浪都不可用时降级腾讯', async () => {
    const db = await dbModule.getDb()
    await addWatchlist('600519.SH')

    const result = await free.ingestFreeMarket({
      tradeDate: TRADE_DATE,
      openDates: OPEN_DATES,
      fetchImpl: makeFetch({ eastmoneyBars: 'fail', sinaBars: 'empty', snapshot: 'fail', pool: 'fail' }),
    })

    expect(result.source).toBe('tencent')
    expect(result.breadth).toBeNull()

    const bar = await db.execute({
      sql: `SELECT close, volume, source_id FROM market_bars
            WHERE code = '600519.SH' AND trade_date = ? AND adjust_type = 'raw'`,
      args: [TRADE_DATE],
    })
    expect(Number(bar.rows[0]?.close)).toBe(1600)
    expect(Number(bar.rows[0]?.volume)).toBe(1_234_500) // 腾讯手 → 股
    expect(bar.rows[0]?.source_id).toBe('tencent')
  })

  it('三家免费源全部失败时明确报错', async () => {
    await expect(free.ingestFreeMarket({
      tradeDate: TRADE_DATE,
      openDates: OPEN_DATES,
      fetchImpl: makeFetch({ eastmoneyBars: 'fail', sinaBars: 'fail', tencentBars: 'fail' }),
    })).rejects.toThrow('免费行情源均未返回有效数据')
  })

  it('涨停池返回的 qdate 与请求日不符时拒绝入库', async () => {
    const db = await dbModule.getDb()

    const result = await free.ingestFreeLimitPool({
      tradeDate: TRADE_DATE,
      fetchImpl: makeFetch({ pool: 'bad-qdate' }),
    })

    expect(result.available).toBe(false)
    expect(result.written).toBe(0)
    expect(result.limitUp).toBe(0)
    expect(result.warnings.join(' ')).toContain('涨停池不可用')
    const pool = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM limit_pool WHERE trade_date = ?',
      args: [TRADE_DATE],
    })
    expect(Number(pool.rows[0]?.n)).toBe(0)
  })

  it('prefer=free 时完全不请求 Tushare', async () => {
    process.env.TUSHARE_TOKEN = 'test-token'
    await addWatchlist('600519.SH')
    const fetchImpl = makeFetch()

    const result = await market.ingestMarket({
      tradeDate: TRADE_DATE,
      prefer: 'free',
      fetchImpl,
    })

    expect(result.source).toBe('eastmoney')
    expect(result.fallbackFromTushare).toBe(false)
    expect(calledUrls(fetchImpl).some((url) => url.includes('api.tushare.pro'))).toBe(false)
  })

  it('Tushare 调用失败时自动降级到免费源', async () => {
    process.env.TUSHARE_TOKEN = 'test-token'
    await addWatchlist('600519.SH')

    const result = await market.ingestMarket({
      tradeDate: TRADE_DATE,
      fetchImpl: makeFetch({ tushare: 'fail' }),
    })

    expect(result.source).toBe('eastmoney')
    expect(result.fallbackFromTushare).toBe(true)
    expect(result.warnings.join(' ')).toContain('Tushare 行情不可用')
    expect(result.breadth).not.toBeNull()
  })

  it('Tushare 成功但缺涨跌停权限时用东财涨停池补齐概览', async () => {
    process.env.TUSHARE_TOKEN = 'test-token'
    const fetchImpl = makeFetch()

    const result = await market.ingestMarket({
      tradeDate: TRADE_DATE,
      fetchImpl,
    })

    expect(result.source).toBe('tushare')
    expect(result.fallbackFromTushare).toBe(false)
    expect(result.limitUpDownAvailable).toBe(true)
    expect(result.limitPoolWritten).toBe(2)
    expect(result.breadth).toMatchObject({ limitUp: 2, limitDown: 1, limitUpDownAvailable: true })

    const db = await dbModule.getDb()
    const overview = await db.execute({
      sql: 'SELECT breadth_json, source_id FROM market_overview WHERE trade_date = ?',
      args: [TRADE_DATE],
    })
    const breadth = JSON.parse(String(overview.rows[0]?.breadth_json))
    expect(breadth).toMatchObject({ limitUp: 2, limitDown: 1, limitUpDownAvailable: true, limitSource: 'eastmoney' })
    expect(overview.rows[0]?.source_id).toBe('tushare')

    const pool = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM limit_pool WHERE trade_date = ?',
      args: [TRADE_DATE],
    })
    expect(Number(pool.rows[0]?.n)).toBe(2)

    // Tushare 已提供全市场广度，不应再拉东财快照
    expect(calledUrls(fetchImpl).some((url) => url.includes('push2.eastmoney.com/api/qt/clist'))).toBe(false)
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
