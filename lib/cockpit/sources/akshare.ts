import { getDb } from '../../db'
import { todayShanghai } from '../format'
import { fetchWithTimeout, type FetchLike } from './http'
import {
  assertNoDemoData,
  ensureCockpitSources,
  markSourceFailure,
  markSourceSuccess,
} from './registry'

/**
 * AKShare（T2 聚合）补充适配器：只补自选/持仓的日线与涨停池。
 * 日线用 INSERT ... DO NOTHING —— 同键的 T0/T1 行情先到就保留，T2 绝不覆盖。
 */

const SOURCE_ID = 'akshare'
const HISTORY_DAYS = 45
const MAX_CODES = 20
const TIMEOUT_MS = 30_000

type Row = Record<string, unknown>

interface BarInput {
  code: string
  tradeDate: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
  amount: number | null
}

interface LimitPoolInput {
  code: string
  name: string
  latestPrice: number | null
  pctChange: number | null
  amount: number | null
  turnoverRate: number | null
  sealAmount: number | null
  firstSealTime: string | null
  lastSealTime: string | null
  openTimes: number | null
  limitUpStats: string | null
  streak: number | null
  industry: string | null
}

export interface AkshareIngestResult {
  configured: boolean
  tradeDate: string
  codes: number
  bars: number
  insertedBars: number
  limitPool: number
  limitPoolWritten: number
  warnings: string[]
}

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function optionalNumber(value: unknown, { positive = false, integer = false } = {}): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || (positive && n === 0)) return null
  return integer ? Math.round(n) : n
}

// 只认沪深京 A 股代码前缀；基金、B 股、指数不进入 T2 补充范围。
const STOCK_PREFIXES: Array<['SH' | 'SZ' | 'BJ', string[]]> = [
  ['SH', ['600', '601', '603', '605', '688', '689']],
  ['SZ', ['000', '001', '002', '003', '300', '301']],
  ['BJ', ['43', '82', '83', '84', '87', '88', '920']],
]

function expectedSuffix(symbol: string): 'SH' | 'SZ' | 'BJ' | null {
  for (const [suffix, prefixes] of STOCK_PREFIXES) {
    if (prefixes.some((prefix) => symbol.startsWith(prefix))) return suffix
  }
  return null
}

function normalizeSidecarCode(value: unknown): string | null {
  const code = str(value).trim().toUpperCase()
  const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(code)
  if (!match) return null
  return expectedSuffix(match[1]) === match[2] ? code : null
}

function resolveConfig(options: { baseUrl?: string; token?: string }): { baseUrl: string; token: string } | null {
  const baseUrl = (options.baseUrl ?? process.env.AKSHARE_SIDECAR_URL ?? '').trim()
  const token = (options.token ?? process.env.AKSHARE_SIDECAR_TOKEN ?? '').trim()
  if (!baseUrl && !token) return null
  if (!baseUrl || !token) {
    throw new Error('AKShare 侧车配置不完整：AKSHARE_SIDECAR_URL 与 AKSHARE_SIDECAR_TOKEN 需同时设置')
  }
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new Error('AKSHARE_SIDECAR_URL 不是合法的 URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AKSHARE_SIDECAR_URL 只支持 http/https')
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token }
}

async function sidecarGet(
  config: { baseUrl: string; token: string },
  path: string,
  query: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<Record<string, unknown>> {
  const url = new URL(`${config.baseUrl}${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const res = await fetchWithTimeout(fetchImpl, TIMEOUT_MS)(url.toString(), {
    method: 'GET',
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`AKShare 侧车 ${path} 返回 HTTP ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`)
  }
  let payload: unknown
  try {
    payload = await res.json()
  } catch {
    throw new Error(`AKShare 侧车 ${path} 返回非 JSON`)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`AKShare 侧车 ${path} 返回结构无效`)
  }
  return payload as Record<string, unknown>
}

function warningsOf(payload: Record<string, unknown>): string[] {
  return Array.isArray(payload.warnings)
    ? payload.warnings.map((item) => String(item).slice(0, 300)).filter(Boolean)
    : []
}

function toBar(raw: unknown, code: string, start: string, end: string): BarInput | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Row
  const tradeDate = str(row.trade_date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || tradeDate < start || tradeDate > end) return null
  const close = optionalNumber(row.close, { positive: true })
  if (close === null) return null
  const open = optionalNumber(row.open, { positive: true })
  const high = optionalNumber(row.high, { positive: true })
  const low = optionalNumber(row.low, { positive: true })
  if (high !== null && low !== null && high < low) return null
  return {
    code,
    tradeDate,
    open,
    high,
    low,
    close,
    volume: optionalNumber(row.volume),
    amount: optionalNumber(row.amount),
  }
}

function toLimitPoolItem(raw: unknown): LimitPoolInput | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Row
  const code = normalizeSidecarCode(row.code)
  const name = str(row.name).trim().slice(0, 100)
  if (!code || !name) return null
  return {
    code,
    name,
    latestPrice: optionalNumber(row.latest_price, { positive: true }),
    pctChange: optionalNumber(row.pct_change),
    amount: optionalNumber(row.amount),
    turnoverRate: optionalNumber(row.turnover_rate),
    sealAmount: optionalNumber(row.seal_amount),
    firstSealTime: str(row.first_seal_time).trim().slice(0, 20) || null,
    lastSealTime: str(row.last_seal_time).trim().slice(0, 20) || null,
    openTimes: optionalNumber(row.open_times, { integer: true }),
    limitUpStats: str(row.limit_up_stats).trim().slice(0, 50) || null,
    streak: optionalNumber(row.streak, { integer: true }),
    industry: str(row.industry).trim().slice(0, 100) || null,
  }
}

async function researchCodes(): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT DISTINCT code FROM (
            SELECT code FROM watchlist_items
            UNION
            SELECT code FROM positions
            WHERE account_id <> 'demo-account' AND shares > 0
          ) ORDER BY code LIMIT ?`,
    args: [MAX_CODES],
  })
  return res.rows.map((row) => str(row.code)).filter(Boolean)
}

async function writeBars(bars: BarInput[], fetchedAt: string): Promise<number> {
  if (bars.length === 0) return 0
  const db = await getDb()
  const tx = await db.transaction('write')
  let inserted = 0
  try {
    for (const bar of bars) {
      const res = await tx.execute({
        sql: `INSERT INTO market_bars
              (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
               source_id, fetched_at, is_demo)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'raw', ?, ?, 0)
              ON CONFLICT(code, trade_date, adjust_type) DO NOTHING`,
        args: [bar.code, bar.tradeDate, bar.open, bar.high, bar.low, bar.close,
          bar.volume, bar.amount, SOURCE_ID, fetchedAt],
      })
      inserted += res.rowsAffected
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx 已关闭 */ }
    throw err
  }
  return inserted
}

async function writeLimitPool(items: LimitPoolInput[], tradeDate: string, fetchedAt: string): Promise<number> {
  if (items.length === 0) return 0
  const db = await getDb()
  const tx = await db.transaction('write')
  let written = 0
  try {
    for (const item of items) {
      const res = await tx.execute({
        sql: `INSERT INTO limit_pool
              (trade_date, code, name, latest_price, pct_change, amount, turnover_rate, seal_amount,
               first_seal_time, last_seal_time, open_times, limit_up_stats, streak, industry,
               source_id, fetched_at, is_demo)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
              ON CONFLICT(trade_date, code) DO UPDATE SET
                name = excluded.name, latest_price = excluded.latest_price,
                pct_change = excluded.pct_change, amount = excluded.amount,
                turnover_rate = excluded.turnover_rate, seal_amount = excluded.seal_amount,
                first_seal_time = excluded.first_seal_time, last_seal_time = excluded.last_seal_time,
                open_times = excluded.open_times, limit_up_stats = excluded.limit_up_stats,
                streak = excluded.streak, industry = excluded.industry,
                source_id = excluded.source_id, fetched_at = excluded.fetched_at
              WHERE limit_pool.is_demo = 0`,
        args: [tradeDate, item.code, item.name, item.latestPrice, item.pctChange, item.amount,
          item.turnoverRate, item.sealAmount, item.firstSealTime, item.lastSealTime,
          item.openTimes, item.limitUpStats, item.streak, item.industry, SOURCE_ID, fetchedAt],
      })
      written += res.rowsAffected
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx 已关闭 */ }
    throw err
  }
  return written
}

export async function ingestAkshare(options: {
  tradeDate?: string
  baseUrl?: string
  token?: string
  fetchImpl?: FetchLike
} = {}): Promise<AkshareIngestResult> {
  const fetchImpl = options.fetchImpl || fetch
  const requestedEnd = options.tradeDate || todayShanghai()
  const start = addDays(requestedEnd, -HISTORY_DAYS)
  const warnings: string[] = []

  await ensureCockpitSources()
  const config = resolveConfig(options)
  if (!config) {
    return {
      configured: false,
      tradeDate: requestedEnd,
      codes: 0,
      bars: 0,
      insertedBars: 0,
      limitPool: 0,
      limitPoolWritten: 0,
      warnings: ['未配置 AKSHARE_SIDECAR_URL / AKSHARE_SIDECAR_TOKEN，T2 补充入库已跳过'],
    }
  }

  await assertNoDemoData()
  const codes = await researchCodes()
  if (codes.length === 0) {
    warnings.push('自选与持仓为空，只尝试拉取涨停池')
  }

  const fetchedAt = new Date().toISOString()
  const allBars: BarInput[] = []
  let latestDate = ''
  let okCalls = 0
  let lastError: Error | null = null

  for (const code of codes) {
    try {
      const payload = await sidecarGet(config, '/v1/daily', { code, start, end: requestedEnd }, fetchImpl)
      if (str(payload.code) !== code) {
        throw new Error(`侧车返回的代码与请求不一致：请求 ${code}，返回 ${str(payload.code) || '(空)'}`)
      }
      const rawBars = payload.bars
      if (!Array.isArray(rawBars)) throw new Error(`${code} 的侧车日线缺少 bars 数组`)
      const bars = rawBars
        .map((raw) => toBar(raw, code, start, requestedEnd))
        .filter((bar): bar is BarInput => bar !== null)
      if (rawBars.length > 0 && bars.length === 0) {
        throw new Error(`${code} 的侧车日线全部未通过校验`)
      }
      if (bars.length < rawBars.length) {
        warnings.push(`${code} 有 ${rawBars.length - bars.length} 根日线未通过校验，已跳过`)
      }
      warnings.push(...warningsOf(payload))
      for (const bar of bars) {
        if (bar.tradeDate > latestDate) latestDate = bar.tradeDate
      }
      allBars.push(...bars)
      okCalls += 1
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      warnings.push(`${code} 日线未取到：${lastError.message}`)
    }
  }

  const tradeDate = latestDate || requestedEnd
  let limitPool: LimitPoolInput[] = []
  try {
    const payload = await sidecarGet(config, '/v1/limit-pool', { trade_date: tradeDate }, fetchImpl)
    if (str(payload.trade_date) !== tradeDate) {
      throw new Error(`侧车返回的交易日与请求不一致：请求 ${tradeDate}，返回 ${str(payload.trade_date) || '(空)'}`)
    }
    const rawItems = payload.items
    if (!Array.isArray(rawItems)) throw new Error('侧车涨停池缺少 items 数组')
    limitPool = rawItems
      .map(toLimitPoolItem)
      .filter((item): item is LimitPoolInput => item !== null)
    if (rawItems.length > 0 && limitPool.length === 0) {
      throw new Error('侧车涨停池记录全部未通过校验')
    }
    if (limitPool.length < rawItems.length) {
      warnings.push(`涨停池有 ${rawItems.length - limitPool.length} 条记录未通过校验，已跳过`)
    }
    warnings.push(...warningsOf(payload))
    okCalls += 1
  } catch (err) {
    lastError = err instanceof Error ? err : new Error(String(err))
    warnings.push(`涨停池未入库：${lastError.message}`)
    if (okCalls === 0) {
      await markSourceFailure(SOURCE_ID, lastError.message)
      throw lastError
    }
  }

  const insertedBars = await writeBars(allBars, fetchedAt)
  const limitPoolWritten = await writeLimitPool(limitPool, tradeDate, fetchedAt)
  if (insertedBars < allBars.length) {
    warnings.push(
      `${allBars.length - insertedBars} 根日线已有同键记录（T0/T1 或此前 T2），保留原来源，未覆盖`,
    )
  }

  await markSourceSuccess(SOURCE_ID)
  return {
    configured: true,
    tradeDate,
    codes: codes.length,
    bars: allBars.length,
    insertedBars,
    limitPool: limitPool.length,
    limitPoolWritten,
    warnings,
  }
}
