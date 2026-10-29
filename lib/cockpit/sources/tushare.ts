import { getDb } from '../../db'
import { getSetting, SETTING_KEYS } from '../../settings'
import { todayShanghai } from '../format'
import { fetchWithTimeout, type FetchLike } from './http'
import {
  assertNoDemoData,
  ensureCockpitSources,
  markSourceFailure,
  markSourceSuccess,
} from './registry'

/**
 * Tushare Pro（T1 持牌数据商）收盘行情适配器。
 * 只写研究范围内标的的日线；全市场 daily 仅用于计算广度与成交额，不整库落盘。
 */

const API_URL = 'https://api.tushare.pro'
const SOURCE_ID = 'tushare'
const INDEXES = [
  { code: '000001.SH', name: '上证指数', exchange: 'SSE' },
  { code: '399001.SZ', name: '深证成指', exchange: 'SZSE' },
  { code: '399006.SZ', name: '创业板指', exchange: 'SZSE' },
] as const
const HISTORY_DAYS = 45
const HISTORY_LOOKBACK_BARS = 20
const MAX_HISTORY_CODES = 60
const CALENDAR_WINDOW_DAYS = 30
const CALENDAR_MIN_ROWS = 15

type Row = Record<string, unknown>

interface TushareResponse {
  code?: number
  msg?: string
  data?: { fields?: string[]; items?: unknown[][] } | null
}

export interface TushareIngestResult {
  tradeDate: string
  bars: number
  indices: number
  universe: number
  breadth: { up: number; flat: number; down: number; limitUp: number; limitDown: number }
  turnover: { value: number; changePct: number | null }
  limitUpDownAvailable: boolean
  warnings: string[]
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function compact(date: string): string {
  return date.replace(/-/g, '')
}

function dashed(value: string): string {
  return /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` : value
}

function exchangeOf(code: string): string {
  if (code.endsWith('.SH')) return 'SSE'
  if (code.endsWith('.SZ')) return 'SZSE'
  if (code.endsWith('.BJ')) return 'BSE'
  return 'UNKNOWN'
}

function shanghaiHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(new Date()))
}

async function tushareFetch(
  apiName: string,
  params: Record<string, unknown>,
  fields: string,
  token: string,
  fetchImpl: FetchLike,
): Promise<Row[]> {
  const res = await fetchWithTimeout(fetchImpl)(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: apiName, token, params, fields }),
  })
  if (!res.ok) throw new Error(`Tushare ${apiName} HTTP ${res.status}`)
  const json = await res.json() as TushareResponse
  if (json.code !== 0) throw new Error(`Tushare ${apiName}: ${json.msg || `code ${json.code}`}`)
  const fieldsList = json.data?.fields || []
  const items = json.data?.items || []
  return items.map((item) => {
    const row: Row = {}
    fieldsList.forEach((field, index) => { row[field] = item[index] })
    return row
  })
}

async function resolveToken(): Promise<string | null> {
  const fromSetting = await getSetting(SETTING_KEYS.TUSHARE_TOKEN).catch(() => null)
  return (fromSetting || process.env.TUSHARE_TOKEN || '').trim() || null
}

export async function hasTushareToken(): Promise<boolean> {
  return Boolean(await resolveToken())
}

async function upsertCalendar(rows: Row[], fetchedAt: string): Promise<void> {
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    for (const row of rows) {
      const date = dashed(str(row.cal_date))
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      await tx.execute({
        sql: `INSERT INTO trading_calendar (trade_date, is_open, source_id, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(trade_date) DO UPDATE SET
                is_open = excluded.is_open, source_id = excluded.source_id,
                updated_at = excluded.updated_at`,
        args: [date, Number(row.is_open) === 1 ? 1 : 0, SOURCE_ID, fetchedAt],
      })
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }
}

/**
 * 保证锚点日期前后 30 天的交易日历在库中；显式回补历史日期也按该日期取窗口。
 * 只补齐缺失窗口，已有足够行且含锚点日时直接读库。
 */
export async function ensureTradingCalendar(options: {
  anchorDate: string
  token?: string
  fetchImpl?: FetchLike
}): Promise<{ openDates: string[]; fetched: boolean }> {
  const { anchorDate } = options
  const startDate = addDays(anchorDate, -CALENDAR_WINDOW_DAYS)
  const db = await getDb()
  const [countRes, anchorRes] = await Promise.all([
    db.execute({
      sql: 'SELECT COUNT(*) AS n FROM trading_calendar WHERE trade_date BETWEEN ? AND ?',
      args: [startDate, anchorDate],
    }),
    db.execute({
      sql: 'SELECT 1 AS ok FROM trading_calendar WHERE trade_date = ? LIMIT 1',
      args: [anchorDate],
    }),
  ])
  // 锚点行缺失时重拉：否则今天休市/新交易日会沿用旧窗口选错目标日。
  const fresh = num(countRes.rows[0]?.n) >= CALENDAR_MIN_ROWS && Boolean(anchorRes.rows[0])
  let fetched = false
  if (!fresh) {
    const token = (options.token || await resolveToken())?.trim()
    if (!token) throw new Error('未配置 Tushare token；请在设置的数据源中填写，或设置 TUSHARE_TOKEN')
    const rows = await tushareFetch(
      'trade_cal',
      { exchange: 'SSE', start_date: compact(startDate), end_date: compact(anchorDate) },
      'exchange,cal_date,is_open,pretrade_date',
      token,
      options.fetchImpl || fetch,
    )
    await upsertCalendar(rows, new Date().toISOString())
    fetched = true
  }
  const res = await db.execute({
    sql: `SELECT trade_date FROM trading_calendar
          WHERE is_open = 1 AND trade_date BETWEEN ? AND ?
          ORDER BY trade_date ASC`,
    args: [startDate, anchorDate],
  })
  const openDates = res.rows
    .map((row) => str(row.trade_date))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
  return { openDates, fetched }
}

/** A 股收盘数据在 15:00 后才稳定；16:00 前自动回退到上一交易日，避免拿当天半截数据。 */
function chooseTradeDate(openDates: string[], explicit?: string): string {
  if (explicit) {
    if (!openDates.includes(explicit)) throw new Error(`${explicit} 不是交易日`)
    return explicit
  }
  const today = todayShanghai()
  const closed = shanghaiHour() >= 16
  const eligible = openDates.filter((date) => date < today || (closed && date === today))
  if (eligible.length === 0) throw new Error('交易日历中没有可用的收盘日期')
  return eligible[eligible.length - 1]
}

async function resolveUniverse(): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT DISTINCT code FROM (
            SELECT code FROM watchlist_items
            UNION
            SELECT code FROM positions
            WHERE account_id <> 'demo-account' AND shares > 0
          ) ORDER BY code`,
    args: [],
  })
  return res.rows.map((row) => str(row.code)).filter(Boolean)
}

async function previousOpenDate(tradeDate: string): Promise<string | null> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT MAX(trade_date) AS d FROM trading_calendar WHERE is_open = 1 AND trade_date < ?`,
    args: [tradeDate],
  })
  const value = res.rows[0]?.d
  return value ? String(value) : null
}

async function storedTurnover(tradeDate: string): Promise<number | null> {
  const db = await getDb()
  const res = await db.execute({
    sql: 'SELECT turnover_json FROM market_overview WHERE trade_date = ?',
    args: [tradeDate],
  })
  if (!res.rows[0]) return null
  try {
    const parsed = JSON.parse(String(res.rows[0].turnover_json)) as { value?: unknown }
    const value = Number(parsed.value)
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function sumTurnover(rows: Row[]): number {
  const totalThousandYuan = rows
    .filter((row) => {
      const code = str(row.ts_code)
      return code.endsWith('.SH') || code.endsWith('.SZ')
    })
    .reduce((sum, row) => sum + num(row.amount), 0)
  return round2(totalThousandYuan / 1e5)
}

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

function optNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function barFrom(row: Row): BarInput | null {
  const code = str(row.ts_code)
  const date = dashed(str(row.trade_date))
  const close = optNum(row.close)
  if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null || close <= 0) return null
  const volume = optNum(row.vol)
  const amount = optNum(row.amount)
  return {
    code,
    tradeDate: date,
    open: optNum(row.open),
    high: optNum(row.high),
    low: optNum(row.low),
    close,
    volume: volume === null ? null : volume * 100,
    amount: amount === null ? null : amount * 1000,
  }
}

async function writeBars(bars: BarInput[], fetchedAt: string): Promise<void> {
  if (bars.length === 0) return
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    for (const bar of bars) {
      await tx.execute({
        sql: `INSERT INTO market_bars
              (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
               source_id, fetched_at, is_demo)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'raw', ?, ?, 0)
              ON CONFLICT(code, trade_date, adjust_type) DO UPDATE SET
                open = excluded.open, high = excluded.high, low = excluded.low,
                close = excluded.close, volume = excluded.volume, amount = excluded.amount,
                source_id = excluded.source_id, fetched_at = excluded.fetched_at
              WHERE market_bars.is_demo = 0`,
        args: [bar.code, bar.tradeDate, bar.open, bar.high, bar.low, bar.close,
          bar.volume, bar.amount, SOURCE_ID, fetchedAt],
      })
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }
}

async function upsertSymbols(rows: Row[], fetchedAt: string): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    // 分批避免变量数超限；示例标的绝不改名。
    for (let offset = 0; offset < rows.length; offset += 150) {
      const chunk = rows.slice(offset, offset + 150)
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
      const args: unknown[] = []
      for (const row of chunk) {
        const code = str(row.ts_code)
        const name = str(row.name) || code
        args.push(code, name, exchangeOf(code), str(row.industry) || null, SOURCE_ID, fetchedAt)
      }
      await tx.execute({
        sql: `INSERT INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
              VALUES ${values}
              ON CONFLICT(code) DO UPDATE SET
                name = excluded.name, exchange = excluded.exchange,
                industry_l1 = COALESCE(excluded.industry_l1, symbols.industry_l1),
                source_id = excluded.source_id, updated_at = excluded.updated_at
              WHERE symbols.source_id IS NULL OR symbols.source_id NOT LIKE 'demo-%'`,
        args,
      })
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }
}

async function expectedHistoryDates(tradeDate: string): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT trade_date FROM trading_calendar
          WHERE is_open = 1 AND trade_date <= ?
          ORDER BY trade_date DESC LIMIT ?`,
    args: [tradeDate, HISTORY_LOOKBACK_BARS],
  })
  return res.rows.map((row) => str(row.trade_date)).sort()
}

async function codesWithFullHistory(codes: string[], dates: string[]): Promise<Set<string>> {
  const complete = new Set<string>()
  if (codes.length === 0 || dates.length === 0) return complete
  const db = await getDb()
  const placeholders = codes.map(() => '?').join(', ')
  const res = await db.execute({
    sql: `SELECT code, trade_date FROM market_bars
          WHERE adjust_type = 'raw' AND is_demo = 0
            AND trade_date BETWEEN ? AND ? AND code IN (${placeholders})`,
    args: [dates[0], dates[dates.length - 1], ...codes],
  })
  const seen = new Map<string, Set<string>>()
  for (const row of res.rows) {
    const code = str(row.code)
    const set = seen.get(code) || new Set<string>()
    set.add(str(row.trade_date))
    seen.set(code, set)
  }
  for (const code of codes) {
    const set = seen.get(code)
    if (set && dates.every((date) => set.has(date))) complete.add(code)
  }
  return complete
}

export async function ingestTushare(options: {
  tradeDate?: string
  token?: string
  fetchImpl?: FetchLike
} = {}): Promise<TushareIngestResult> {
  const fetchImpl = options.fetchImpl || fetch
  await ensureCockpitSources()
  await assertNoDemoData()

  const token = (options.token || await resolveToken())?.trim()
  if (!token) throw new Error('未配置 Tushare token；请在设置的数据源中填写，或设置 TUSHARE_TOKEN')

  const warnings: string[] = []
  try {
    const anchorDate = options.tradeDate || todayShanghai()
    const calendar = await ensureTradingCalendar({
      anchorDate,
      token,
      fetchImpl,
    })
    const tradeDate = chooseTradeDate(calendar.openDates, options.tradeDate)
    const fetchedAt = new Date().toISOString()
    const db = await getDb()

    const basics = await tushareFetch(
      'stock_basic',
      { exchange: '', list_status: 'L' },
      'ts_code,symbol,name,industry,market,exchange,list_date',
      token,
      fetchImpl,
    )
    await upsertSymbols(basics, fetchedAt)

    const indexBars: BarInput[] = []
    let indexCount = 0
    for (const index of INDEXES) {
      const rows = await tushareFetch(
        'index_daily',
        { ts_code: index.code, start_date: compact(addDays(tradeDate, -HISTORY_DAYS)), end_date: compact(tradeDate) },
        'ts_code,trade_date,open,high,low,close,vol,amount',
        token,
        fetchImpl,
      )
      const bars = rows.map(barFrom).filter((bar): bar is BarInput => bar !== null && bar.tradeDate <= tradeDate)
      indexBars.push(...bars)
      if (bars.some((bar) => bar.tradeDate === tradeDate)) indexCount += 1
      await upsertSymbols([{ ts_code: index.code, name: index.name, industry: '指数', exchange: index.exchange }], fetchedAt)
    }

    const dailyRows = await tushareFetch(
      'daily',
      { trade_date: compact(tradeDate) },
      'ts_code,trade_date,open,high,low,close,pre_close,pct_chg,vol,amount',
      token,
      fetchImpl,
    )
    if (dailyRows.length === 0) {
      throw new Error(`${tradeDate} 的全市场日线尚未发布（Tushare 返回空），请收盘后再试`)
    }

    const dailyByCode = new Map(dailyRows.map((row) => [str(row.ts_code), row]))
    const stockRows = dailyRows.filter((row) => {
      const code = str(row.ts_code)
      return code.endsWith('.SH') || code.endsWith('.SZ')
    })
    let up = 0
    let flat = 0
    let down = 0
    for (const row of stockRows) {
      const pct = num(row.pct_chg)
      if (pct > 0) up += 1
      else if (pct < 0) down += 1
      else flat += 1
    }

    let limitUp = 0
    let limitDown = 0
    let limitUpDownAvailable = true
    try {
      const [upRows, downRows] = await Promise.all([
        tushareFetch('limit_list_d', { trade_date: compact(tradeDate), limit_type: 'U' }, 'ts_code,trade_date,limit_type', token, fetchImpl),
        tushareFetch('limit_list_d', { trade_date: compact(tradeDate), limit_type: 'D' }, 'ts_code,trade_date,limit_type', token, fetchImpl),
      ])
      limitUp = upRows.length
      limitDown = downRows.length
    } catch (err) {
      limitUpDownAvailable = false
      warnings.push(`涨跌停统计不可用：${err instanceof Error ? err.message : String(err)}`)
    }

    const turnoverValue = sumTurnover(dailyRows)
    const prevDate = await previousOpenDate(tradeDate)
    let prevTurnover = prevDate ? await storedTurnover(prevDate) : null
    if (prevDate && prevTurnover === null) {
      try {
        const prevRows = await tushareFetch(
          'daily',
          { trade_date: compact(prevDate) },
          'ts_code,amount',
          token,
          fetchImpl,
        )
        prevTurnover = sumTurnover(prevRows)
      } catch (err) {
        warnings.push(`前一日成交额缺失：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    const turnoverChange = prevTurnover !== null && prevTurnover > 0
      ? round2(((turnoverValue - prevTurnover) / prevTurnover) * 100)
      : null
    if (turnoverChange === null) {
      warnings.push('前一开市日成交额不可用，成交额变化未计算')
    }

    const universe = await resolveUniverse()
    const historyCodes = universe.slice(0, MAX_HISTORY_CODES)
    if (universe.length > MAX_HISTORY_CODES) {
      warnings.push(`研究标的 ${universe.length} 个，历史日线仅回补前 ${MAX_HISTORY_CODES} 个；当日 bar 全部写入`)
    }
    const expectedDates = await expectedHistoryDates(tradeDate)
    const completeHistory = await codesWithFullHistory(historyCodes, expectedDates)
    const universeBars: BarInput[] = []
    const missing: string[] = []
    for (const code of historyCodes) {
      if (!dailyByCode.has(code) || completeHistory.has(code)) continue
      const rows = await tushareFetch(
        'daily',
        { ts_code: code, start_date: compact(addDays(tradeDate, -HISTORY_DAYS)), end_date: compact(tradeDate) },
        'ts_code,trade_date,open,high,low,close,vol,amount',
        token,
        fetchImpl,
      )
      universeBars.push(...rows.map(barFrom).filter((bar): bar is BarInput => bar !== null && bar.tradeDate <= tradeDate))
    }
    // 当日 bar 不受历史回补上限影响，避免第 61 个标的当天缺行情。
    for (const code of universe) {
      const row = dailyByCode.get(code)
      if (!row) {
        missing.push(code)
        continue
      }
      const bar = barFrom(row)
      if (bar) universeBars.push(bar)
    }
    if (missing.length > 0) warnings.push(`当日无成交或未上市的标的：${missing.join('、')}`)

    const dedupedBars = new Map<string, BarInput>()
    for (const bar of [...indexBars, ...universeBars]) {
      dedupedBars.set(`${bar.code}|${bar.tradeDate}`, bar)
    }
    await writeBars([...dedupedBars.values()], fetchedAt)

    await db.execute({
      sql: `INSERT INTO market_overview (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
            VALUES (?, ?, ?, ?, 0, ?)
            ON CONFLICT(trade_date) DO UPDATE SET
              breadth_json = excluded.breadth_json, turnover_json = excluded.turnover_json,
              source_id = excluded.source_id, created_at = excluded.created_at
            WHERE market_overview.is_demo = 0`,
      args: [
        tradeDate,
        JSON.stringify({ up, flat, down, limitUp, limitDown, limitUpDownAvailable }),
        JSON.stringify({ value: turnoverValue, changePct: turnoverChange }),
        SOURCE_ID,
        fetchedAt,
      ],
    })

    await markSourceSuccess(SOURCE_ID, fetchedAt)
    return {
      tradeDate,
      bars: dedupedBars.size,
      indices: indexCount,
      universe: universe.length,
      breadth: { up, flat, down, limitUp, limitDown },
      turnover: { value: turnoverValue, changePct: turnoverChange },
      limitUpDownAvailable,
      warnings,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await markSourceFailure(SOURCE_ID, message).catch(() => {})
    throw err
  }
}
