import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 东财盘中快照：批量取自选/持仓/指数，按时差写 delay_seconds，
 * 字段无效的行跳过；整批失败时只记来源健康度，不写脏数据。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-live-quotes-test-'))
let liveQuotes: typeof import('../lib/cockpit/sources/live-quotes')
let dbModule: typeof import('../lib/db')

const tradeEpoch = Math.floor(Date.now() / 1000) - 90

const payload = {
  rc: 0,
  data: {
    total: 4,
    diff: [
      { f2: 190, f3: -6.54, f12: '688041', f13: 1, f14: '海光信息', f18: 203.3, f124: tradeEpoch },
      { f2: 24.11, f3: -4.14, f12: '000938', f13: 0, f14: '紫光股份', f18: 25.15, f124: tradeEpoch },
      { f2: 3602.57, f3: -0.87, f12: '000001', f13: 1, f14: '上证指数', f18: 3634.35, f124: tradeEpoch },
      { f2: '-', f3: '-', f12: '300454', f13: 0, f14: '深信服', f18: 100, f124: tradeEpoch },
    ],
  },
}

// 备用源用 ASCII 名称，避免测试里手工构造 GBK 字节
function sinaBody(): string {
  const fields = Array.from({ length: 32 }, () => '0')
  fields[0] = 'HAIGUANG'
  fields[1] = '198.010'
  fields[2] = '203.300'
  fields[3] = '190.000'
  fields[30] = '2026-11-16'
  fields[31] = '15:00:00'
  return `var hq_str_sh688041="${fields.join(',')}";`
}

function tencentBody(): string {
  const fields = Array.from({ length: 40 }, () => '0')
  fields[1] = 'HAIGUANG'
  fields[2] = '688041'
  fields[3] = '190.00'
  fields[4] = '203.30'
  fields[30] = '20261116150001'
  fields[31] = '-13.30'
  fields[32] = '-6.54'
  return `v_sh688041="${fields.join('~')}";`
}

describe('东财盘中快照', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'live-quotes.db')
    vi.resetModules()
    liveQuotes = await import('../lib/cockpit/sources/live-quotes')
    dbModule = await import('../lib/db')
    const db = await dbModule.getDb()
    const now = new Date().toISOString()
    for (const code of ['688041.SH', '300454.SZ']) {
      await db.execute({
        sql: 'INSERT INTO watchlist_items (code, note, created_at) VALUES (?, NULL, ?)',
        args: [code, now],
      })
    }
    await db.execute({
      sql: `INSERT INTO positions (account_id, code, shares, avg_cost_cents, updated_at)
            VALUES ('main-account', '000938.SZ', 100, 2000, ?)`,
      args: [now],
    })
  })

  it('批量抓取并按时差标注延迟，无效字段跳过', async () => {
    let requested = ''
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested = String(input)
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const result = await liveQuotes.refreshLiveQuotes({ fetchImpl })
    expect(result.written).toBe(3)
    expect(result.skipped).toBe(1)
    expect(result.source).toBe('eastmoney')
    expect(result.warnings.join('')).toContain('1 条')

    // 自选、持仓与三大指数都在同一批 secid 里
    for (const id of ['1.688041', '0.000938', '0.300454', '1.000001', '0.399001', '0.399006']) {
      expect(requested).toContain(id)
    }

    // 同一 trade_time 重复抓取走覆盖，不堆积
    const again = await liveQuotes.refreshLiveQuotes({ fetchImpl })
    expect(again.written).toBe(3)

    const db = await dbModule.getDb()
    const row = await db.execute({
      sql: "SELECT * FROM realtime_quotes WHERE code = '688041.SH'",
      args: [],
    })
    expect(row.rows).toHaveLength(1)
    const saved = row.rows[0]
    expect(Number(saved.price)).toBe(190)
    expect(Number(saved.previous_close)).toBe(203.3)
    expect(Number(saved.change_pct)).toBe(-6.54)
    expect(saved.source_id).toBe('eastmoney')
    expect(saved.trade_time).toBe(new Date(tradeEpoch * 1000).toISOString())
    const delay = Number(saved.delay_seconds)
    expect(delay).toBeGreaterThanOrEqual(89)
    expect(delay).toBeLessThan(120)

    const health = await db.execute({
      sql: "SELECT enabled, consecutive_failures FROM source_registry WHERE id = 'eastmoney'",
      args: [],
    })
    expect(Number(health.rows[0]?.enabled)).toBe(1)
    expect(Number(health.rows[0]?.consecutive_failures)).toBe(0)
  })

  it('整批失败不写行情，只累计来源失败次数', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const result = await liveQuotes.refreshLiveQuotes({ fetchImpl: failing })
    expect(result.written).toBe(0)
    expect(result.source).toBeNull()
    expect(result.warnings.join('')).toContain('offline')

    const db = await dbModule.getDb()
    // 399001.SZ 始终被请求，但响应里没有它，失败轮不应凭空写入
    const count = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM realtime_quotes WHERE code = '399001.SZ'",
      args: [],
    })
    expect(Number(count.rows[0]?.n)).toBe(0)

    const health = await db.execute({
      sql: "SELECT last_error, consecutive_failures FROM source_registry WHERE id = 'eastmoney'",
      args: [],
    })
    expect(String(health.rows[0]?.last_error)).toContain('offline')
    expect(Number(health.rows[0]?.consecutive_failures)).toBeGreaterThanOrEqual(1)
  })

  it('东财失败时回退新浪', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('push2.eastmoney.com')) throw new Error('empty reply')
      if (url.includes('hq.sinajs.cn')) return new Response(sinaBody(), { status: 200 })
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const result = await liveQuotes.refreshLiveQuotes({ fetchImpl })
    expect(result.source).toBe('sina')
    expect(result.written).toBe(1)
    expect(result.warnings.join('')).toContain('东方财富')

    const db = await dbModule.getDb()
    const row = await db.execute({
      sql: "SELECT source_id, name, price FROM realtime_quotes WHERE code = '688041.SH' AND source_id = 'sina'",
      args: [],
    })
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.name).toBe('HAIGUANG')
    expect(Number(row.rows[0]?.price)).toBe(190)
  })

  it('东财与新浪都失败时回退腾讯', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('push2.eastmoney.com')) throw new Error('empty reply')
      if (url.includes('hq.sinajs.cn')) throw new Error('blocked')
      if (url.includes('qt.gtimg.cn')) return new Response(tencentBody(), { status: 200 })
      throw new Error(`unexpected ${url}`)
    }) as unknown as typeof fetch

    const result = await liveQuotes.refreshLiveQuotes({ fetchImpl })
    expect(result.source).toBe('tencent')
    expect(result.written).toBe(1)
    expect(result.warnings.join('')).toContain('新浪财经')

    const db = await dbModule.getDb()
    const row = await db.execute({
      sql: "SELECT source_id, change_pct FROM realtime_quotes WHERE code = '688041.SH' AND source_id = 'tencent'",
      args: [],
    })
    expect(row.rows).toHaveLength(1)
    expect(Number(row.rows[0]?.change_pct)).toBe(-6.54)
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
