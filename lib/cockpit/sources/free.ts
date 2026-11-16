import { getDb } from '../../db'
import { fetchWithTimeout, type FetchLike } from './http'
import {
  assertNoDemoData,
  ensureCockpitSources,
  markSourceFailure,
  markSourceSuccess,
} from './registry'

/**
 * 免费公开行情源（T2）：东方财富 → 新浪财经 → 腾讯财经。
 * 日线一律 INSERT ... DO NOTHING —— 同键的 T0/T1 行情先到就保留。
 * 全市场快照与涨停池只有东财提供；新浪/腾讯只兜底日线。
 */

const HISTORY_DAYS = 45
const CALENDAR_WINDOW_DAYS = 30
const LATEST_WINDOW_DAYS = 14
const MAX_UNIVERSE_CODES = 60
const TIMEOUT_MS = 20_000
const SNAPSHOT_PAGE_SIZE = 100
const SNAPSHOT_MAX_PAGES = 80
const SNAPSHOT_CONCURRENCY = 6
const POOL_PAGE_SIZE = 100
const POOL_MAX_PAGES = 10
const COOLDOWN_AFTER_FAILURES = 2
const COOLDOWN_MS = 60_000

const INDEXES = [
  { code: '000001.SH', name: '上证指数', exchange: 'SSE' },
  { code: '399001.SZ', name: '深证成指', exchange: 'SZSE' },
  { code: '399006.SZ', name: '创业板指', exchange: 'SZSE' },
] as const

const FREE_SOURCES = ['eastmoney', 'sina', 'tencent'] as const
export type FreeSourceId = (typeof FREE_SOURCES)[number]

const SOURCE_LABEL: Record<FreeSourceId, string> = {
  eastmoney: '东方财富',
  sina: '新浪财经',
  tencent: '腾讯财经',
}

const SOURCE_HEADERS: Record<FreeSourceId, Record<string, string>> = {
  eastmoney: { Referer: 'https://quote.eastmoney.com/' },
  sina: { Referer: 'https://finance.sina.com.cn/' },
  tencent: { Referer: 'https://gu.qq.com/' },
}

const SH_PREFIXES = ['600', '601', '603', '605', '688', '689']
const SZ_PREFIXES = ['000', '001', '002', '003', '300', '301']
const BJ_PREFIXES = ['43', '82', '83', '84', '87', '88', '920']

type Row = Record<string, unknown>

export interface BarInput {
  code: string
  tradeDate: string
  open: number | null
  high: number | null
  low: number | null
  close: number
  volume: number | null
  amount: number | null
  sourceId: FreeSourceId
}

interface SnapshotRow {
  code: string
  name: string
  industry: string | null
  price: number
  pct: number
  amount: number
}

interface LimitPoolItem {
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

export interface FreeIngestResult {
  tradeDate: string
  source: FreeSourceId | 'mixed'
  bars: number
  indices: number
  universe: number
  breadth: {
    up: number
    flat: number
    down: number
    limitUp: number
    limitDown: number
    limitUpDownAvailable: boolean
  } | null
  turnover: { value: number; changePct: number | null } | null
  limitUpDownAvailable: boolean
  limitPoolWritten: number
  warnings: string[]
}

export interface FreePoolResult {
  available: boolean
  limitUp: number
  limitDown: number
  written: number
  warnings: string[]
}

interface ProviderLog {
  ok: Set<FreeSourceId>
  errors: Map<FreeSourceId, string>
}

// 同一任务里连错两次就冷却，避免每个代码都等满超时。
const transportFailures = new Map<FreeSourceId, number>()
const cooldownUntil = new Map<FreeSourceId, number>()

let clockOverride: Date | null = null

export function resetFreeSourceCooldownsForTests(): void {
  transportFailures.clear()
  cooldownUntil.clear()
  clockOverride = null
}

export function setFreeSourceClockForTests(now: Date | null): void {
  clockOverride = now
}

function nowDate(): Date {
  return clockOverride ? new Date(clockOverride.getTime()) : new Date()
}

function todayOf(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(date)
}

function inCooldown(id: FreeSourceId): boolean {
  return (cooldownUntil.get(id) || 0) > Date.now()
}

function noteTransportSuccess(id: FreeSourceId): void {
  transportFailures.delete(id)
  cooldownUntil.delete(id)
}

function noteTransportFailure(id: FreeSourceId): void {
  const count = (transportFailures.get(id) || 0) + 1
  transportFailures.set(id, count)
  if (count >= COOLDOWN_AFTER_FAILURES) cooldownUntil.set(id, Date.now() + COOLDOWN_MS)
}

function newLog(): ProviderLog {
  return { ok: new Set(), errors: new Map() }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function noteError(log: ProviderLog, id: FreeSourceId, err: unknown): void {
  if (!log.errors.has(id)) log.errors.set(id, messageOf(err).slice(0, 300))
}

async function reportLog(log: ProviderLog): Promise<void> {
  for (const id of log.ok) await markSourceSuccess(id)
  for (const [id, message] of log.errors) {
    if (log.ok.has(id)) continue
    await markSourceFailure(id, message).catch(() => {})
  }
}

function str(value: unknown): string {
  return value == null ? '' : String(value)
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function optNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function optInt(value: unknown): number | null {
  const n = optNum(value)
  return n === null ? null : Math.round(n)
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

function daySpan(start: string, end: string): number {
  return Math.max(1, Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  ))
}

function shanghaiHour(date: Date = nowDate()): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    hourCycle: 'h23',
  }).format(date))
}

function suffixOf(six: string): 'SH' | 'SZ' | 'BJ' | null {
  if (SH_PREFIXES.some((prefix) => six.startsWith(prefix))) return 'SH'
  if (SZ_PREFIXES.some((prefix) => six.startsWith(prefix))) return 'SZ'
  if (BJ_PREFIXES.some((prefix) => six.startsWith(prefix))) return 'BJ'
  return null
}

function normalizeSix(value: unknown): string | null {
  const raw = str(value).trim()
  if (!/^\d{1,6}$/.test(raw)) return null
  const six = raw.padStart(6, '0')
  return suffixOf(six) ? six : null
}

function secid(code: string): string {
  const market = code.endsWith('.SH') ? '1' : '0'
  return `${market}.${code.slice(0, 6)}`
}

function quoteSymbol(code: string): string {
  const prefix = code.endsWith('.SH') ? 'sh' : code.endsWith('.BJ') ? 'bj' : 'sz'
  return `${prefix}${code.slice(0, 6)}`
}

async function getJson(
  url: string,
  provider: FreeSourceId,
  fetchImpl: FetchLike,
): Promise<unknown> {
  if (inCooldown(provider)) throw new Error(`${SOURCE_LABEL[provider]}处于冷却`)
  let res: Response
  try {
    res = await fetchWithTimeout(fetchImpl, TIMEOUT_MS)(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
        ...SOURCE_HEADERS[provider],
      },
    })
  } catch (err) {
    noteTransportFailure(provider)
    throw new Error(`${SOURCE_LABEL[provider]}请求失败：${messageOf(err)}`)
  }
  if (!res.ok) {
    noteTransportFailure(provider)
    throw new Error(`${SOURCE_LABEL[provider]} HTTP ${res.status}`)
  }
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    noteTransportFailure(provider)
    throw new Error(`${SOURCE_LABEL[provider]}读取响应失败：${messageOf(err)}`)
  }
  try {
    const payload = JSON.parse(text) as unknown
    noteTransportSuccess(provider)
    return payload
  } catch {
    noteTransportFailure(provider)
    throw new Error(`${SOURCE_LABEL[provider]}返回非 JSON`)
  }
}

function toBar(
  sourceId: FreeSourceId,
  code: string,
  date: string,
  open: unknown,
  close: unknown,
  high: unknown,
  low: unknown,
  volume: number | null,
  amount: number | null,
): BarInput | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const closeValue = optNum(close)
  if (closeValue === null || closeValue <= 0) return null
  const highValue = optNum(high)
  const lowValue = optNum(low)
  if (highValue !== null && lowValue !== null && highValue < lowValue) return null
  return {
    code,
    tradeDate: date,
    open: optNum(open),
    high: highValue,
    low: lowValue,
    close: closeValue,
    volume,
    amount,
    sourceId,
  }
}

function parseEastmoneyBars(payload: unknown, code: string): BarInput[] {
  const klines = (payload as { data?: { klines?: unknown } } | null)?.data?.klines
  if (!Array.isArray(klines)) return []
  const bars: BarInput[] = []
  for (const line of klines) {
    if (typeof line !== 'string') continue
    const [date, open, close, high, low, volume, amount] = line.split(',')
    const vol = optNum(volume)
    const bar = toBar('eastmoney', code, date, open, close, high, low,
      vol === null ? null : vol * 100, optNum(amount))
    if (bar) bars.push(bar)
  }
  return bars
}

function parseSinaBars(payload: unknown, code: string): BarInput[] {
  if (!Array.isArray(payload)) return []
  const bars: BarInput[] = []
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Row
    const bar = toBar('sina', code, str(row.day), row.open, row.close, row.high, row.low,
      optNum(row.volume), null)
    if (bar) bars.push(bar)
  }
  return bars
}

function parseTencentBars(payload: unknown, code: string): BarInput[] {
  const symbol = quoteSymbol(code)
  const data = (payload as { data?: Record<string, { day?: unknown; qfqday?: unknown }> } | null)?.data
  const node = data?.[symbol]
  const rows = Array.isArray(node?.day) ? node.day : Array.isArray(node?.qfqday) ? node.qfqday : []
  const bars: BarInput[] = []
  for (const raw of rows) {
    if (!Array.isArray(raw) || raw.length < 6) continue
    const [date, open, close, high, low, volume] = raw
    const vol = optNum(volume)
    const bar = toBar('tencent', code, str(date), open, close, high, low,
      vol === null ? null : vol * 100, null)
    if (bar) bars.push(bar)
  }
  return bars
}

async function fetchProviderBars(
  provider: FreeSourceId,
  code: string,
  start: string,
  end: string,
  fetchImpl: FetchLike,
): Promise<BarInput[]> {
  const count = Math.min(400, Math.max(10, Math.ceil(daySpan(start, end) * 0.75) + 10))
  let payload: unknown
  let bars: BarInput[]
  if (provider === 'eastmoney') {
    payload = await getJson(
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid(code)}`
        + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57'
        + `&klt=101&fqt=0&beg=${compact(start)}&end=${compact(end)}`,
      provider,
      fetchImpl,
    )
    bars = parseEastmoneyBars(payload, code)
  } else if (provider === 'sina') {
    payload = await getJson(
      'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
        + `?symbol=${quoteSymbol(code)}&scale=240&ma=no&datalen=${count}`,
      provider,
      fetchImpl,
    )
    bars = parseSinaBars(payload, code)
  } else {
    payload = await getJson(
      `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${quoteSymbol(code)},day,,,${count}`,
      provider,
      fetchImpl,
    )
    bars = parseTencentBars(payload, code)
  }
  return bars.filter((bar) => bar.tradeDate >= start && bar.tradeDate <= end)
}

async function fetchBarsWithFallback(
  code: string,
  start: string,
  end: string,
  fetchImpl: FetchLike,
  log: ProviderLog,
): Promise<{ bars: BarInput[]; provider: FreeSourceId }> {
  const failures: string[] = []
  for (const provider of FREE_SOURCES) {
    if (inCooldown(provider)) {
      failures.push(`${SOURCE_LABEL[provider]}冷却中`)
      continue
    }
    try {
      const bars = await fetchProviderBars(provider, code, start, end, fetchImpl)
      if (bars.length > 0) {
        log.ok.add(provider)
        return { bars, provider }
      }
      failures.push(`${SOURCE_LABEL[provider]}无数据`)
    } catch (err) {
      noteError(log, provider, err)
      failures.push(messageOf(err))
    }
  }
  throw new Error(`免费源均未取到 ${code} 日线（${failures.join('；')}）`)
}

function chooseTradeDate(openDates: string[], explicit?: string): string {
  const now = nowDate()
  const today = todayOf(now)
  const closed = shanghaiHour(now) >= 16
  if (explicit) {
    if (!openDates.includes(explicit)) throw new Error(`${explicit} 不是交易日`)
    if (explicit === today && !closed) {
      throw new Error(`${explicit} 收盘数据 16:00 后才稳定，请稍后再试`)
    }
    return explicit
  }
  const eligible = openDates.filter((date) => date < today || (closed && date === today))
  if (eligible.length === 0) throw new Error('交易日历中没有可用的收盘日期')
  return eligible[eligible.length - 1]
}

/** 由上证指数日线反推交易日历：指数有收盘价的日期就是开市日。 */
export async function deriveFreeCalendar(options: {
  anchorDate: string
  fetchImpl?: FetchLike
}): Promise<string[]> {
  const fetchImpl = options.fetchImpl || fetch
  const start = addDays(options.anchorDate, -CALENDAR_WINDOW_DAYS)
  const end = addDays(options.anchorDate, 1)
  const { bars, provider } = await fetchBarsWithFallback('000001.SH', start, end, fetchImpl, newLog())
  const openDates = [...new Set(
    bars.map((bar) => bar.tradeDate).filter((date) => date <= options.anchorDate),
  )].sort()
  if (openDates.length === 0) throw new Error('指数日线中没有可用交易日')
  const db = await getDb()
  const now = new Date().toISOString()
  const tx = await db.transaction('write')
  try {
    for (const date of openDates) {
      await tx.execute({
        sql: `INSERT INTO trading_calendar (trade_date, is_open, source_id, updated_at)
              VALUES (?, 1, ?, ?)
              ON CONFLICT(trade_date) DO NOTHING`,
        args: [date, provider, now],
      })
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx 已关闭 */ }
    throw err
  }
  return openDates
}

/** 全市场快照没有自带日期；用最近 14 天的指数日线确认「最新开市日」再决定能否使用。 */
async function latestOpenDate(fetchImpl: FetchLike, log: ProviderLog): Promise<string | null> {
  const today = todayOf(nowDate())
  const start = addDays(today, -LATEST_WINDOW_DAYS)
  const { bars } = await fetchBarsWithFallback('000001.SH', start, addDays(today, 1), fetchImpl, log)
  const dates = bars.map((bar) => bar.tradeDate).filter((date) => date <= today).sort()
  return dates.length > 0 ? dates[dates.length - 1] : null
}

function parseSnapshotRow(raw: unknown): SnapshotRow | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Row
  const six = normalizeSix(row.f12)
  const price = optNum(row.f2)
  const pct = optNum(row.f3)
  if (!six || price === null || price <= 0 || pct === null) return null
  const name = str(row.f14).trim().slice(0, 100)
  if (!name) return null
  const industry = str(row.f100).trim().slice(0, 100)
  return {
    code: `${six}.${suffixOf(six)!}`,
    name,
    industry: industry && industry !== '-' ? industry : null,
    price,
    pct,
    amount: Math.max(0, optNum(row.f6) || 0),
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

async function fetchSnapshot(fetchImpl: FetchLike): Promise<SnapshotRow[]> {
  const url = (page: number) =>
    'https://push2.eastmoney.com/api/qt/clist/get'
    + `?pn=${page}&pz=${SNAPSHOT_PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f3`
    + '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23'
    + '&fields=f2,f3,f6,f12,f14,f100'
    + '&ut=bd1d9ddb04089700cf9c27f6f7426281'
  const first = await getJson(url(1), 'eastmoney', fetchImpl)
  const total = Number((first as { data?: { total?: unknown } } | null)?.data?.total)
  if (!Number.isFinite(total) || total <= 0) throw new Error('东财快照缺少总数')
  const pages = Math.ceil(total / SNAPSHOT_PAGE_SIZE)
  if (pages > SNAPSHOT_MAX_PAGES) throw new Error(`东财快照分页超限（${total} 条）`)
  const rest = Array.from({ length: pages - 1 }, (_, index) => index + 2)
  const payloads = await mapLimit(rest, SNAPSHOT_CONCURRENCY,
    (page) => getJson(url(page), 'eastmoney', fetchImpl))
  const rows: SnapshotRow[] = []
  for (const payload of [first, ...payloads]) {
    const diff = (payload as { data?: { diff?: unknown } } | null)?.data?.diff
    if (!Array.isArray(diff)) throw new Error('东财快照缺少 diff')
    for (const raw of diff) {
      const row = parseSnapshotRow(raw)
      if (row) rows.push(row)
    }
  }
  if (rows.length === 0) throw new Error('东财快照为空')
  return rows
}

function summarizeSnapshot(rows: SnapshotRow[]): {
  up: number
  flat: number
  down: number
  turnoverValue: number
} {
  let up = 0
  let flat = 0
  let down = 0
  let amount = 0
  for (const row of rows) {
    const suffix = suffixOf(row.code.slice(0, 6))
    if (suffix !== 'SH' && suffix !== 'SZ') continue
    if (row.pct > 0) up += 1
    else if (row.pct < 0) down += 1
    else flat += 1
    amount += row.amount
  }
  return { up, flat, down, turnoverValue: round2(amount / 1e8) }
}

function poolTime(value: unknown): string | null {
  const n = optInt(value)
  if (n === null || n <= 0) return null
  const text = String(n).padStart(6, '0')
  return `${text.slice(0, 2)}:${text.slice(2, 4)}:${text.slice(4, 6)}`
}

function parsePoolItem(raw: unknown, kind: 'zt' | 'dt'): LimitPoolItem | null {
  if (!raw || typeof raw !== 'object') return null
  const row = raw as Row
  const six = normalizeSix(row.c)
  const name = str(row.n).trim().slice(0, 100)
  if (!six || !name) return null
  const price = optNum(row.p)
  const stats = row.zttj as { days?: unknown; ct?: unknown } | undefined
  const days = stats ? optInt(stats.days) : null
  const times = stats ? optInt(stats.ct) : null
  return {
    code: `${six}.${suffixOf(six)!}`,
    name,
    // 东财池子价格是 1/1000 元。
    latestPrice: price === null ? null : round2(price / 1000),
    pctChange: optNum(row.zdp),
    amount: optNum(row.amount),
    turnoverRate: optNum(row.hs),
    sealAmount: optNum(row.fund),
    firstSealTime: kind === 'zt' ? poolTime(row.fbt) : null,
    lastSealTime: poolTime(row.lbt),
    openTimes: optInt(kind === 'zt' ? row.zbc : row.oc),
    limitUpStats: days !== null && times !== null ? `${days}天${times}板` : null,
    streak: optInt(kind === 'zt' ? row.lbc : row.days),
    industry: str(row.hybk).trim().slice(0, 100) || null,
  }
}

async function fetchPool(
  kind: 'zt' | 'dt',
  tradeDate: string,
  fetchImpl: FetchLike,
): Promise<LimitPoolItem[]> {
  const path = kind === 'zt' ? 'getTopicZTPool' : 'getTopicDTPool'
  const sort = kind === 'zt' ? 'fbt%3Aasc' : 'fund%3Aasc'
  const items: LimitPoolItem[] = []
  let total = Number.POSITIVE_INFINITY
  for (let page = 0; page < POOL_MAX_PAGES; page += 1) {
    const payload = await getJson(
      `https://push2ex.eastmoney.com/${path}?ut=7eea3edcaed734bea9cbfc24409ed989`
        + `&dpt=wz.ztzt&Pageindex=${page}&pagesize=${POOL_PAGE_SIZE}&sort=${sort}`
        + `&date=${compact(tradeDate)}`,
      'eastmoney',
      fetchImpl,
    )
    const data = (payload as {
      data?: { qdate?: unknown; tc?: unknown; pool?: unknown }
    } | null)?.data
    const qdate = str(data?.qdate)
    // 该接口会忽略历史 date 参数、直接返回当日池子；不校验会把今天的池子写到历史日期上。
    if (qdate !== compact(tradeDate)) {
      throw new Error(`涨停池返回 ${qdate || '(空)'}，不是请求日 ${tradeDate}`)
    }
    const tc = Number(data?.tc)
    if (Number.isFinite(tc) && tc >= 0) total = tc
    const rawPool = Array.isArray(data?.pool) ? data.pool : []
    for (const raw of rawPool) {
      const item = parsePoolItem(raw, kind)
      if (item) items.push(item)
    }
    if (rawPool.length < POOL_PAGE_SIZE || items.length >= total) break
  }
  return items
}

async function writeLimitPool(
  items: LimitPoolItem[],
  tradeDate: string,
  fetchedAt: string,
): Promise<number> {
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
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'eastmoney', ?, 0)
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
          item.openTimes, item.limitUpStats, item.streak, item.industry, fetchedAt],
      })
      written += Number(res.rowsAffected) || 0
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx 已关闭 */ }
    throw err
  }
  return written
}

/** 只入库涨停池；跌停池仅用于 breadth 的 limitDown 计数（表里没有方向字段）。 */
export async function ingestFreeLimitPool(options: {
  tradeDate: string
  fetchImpl?: FetchLike
}): Promise<FreePoolResult> {
  const fetchImpl = options.fetchImpl || fetch
  const warnings: string[] = []
  let upItems: LimitPoolItem[]
  let downItems: LimitPoolItem[]
  try {
    upItems = await fetchPool('zt', options.tradeDate, fetchImpl)
  } catch (err) {
    const message = messageOf(err)
    await markSourceFailure('eastmoney', message).catch(() => {})
    return { available: false, limitUp: 0, limitDown: 0, written: 0, warnings: [`涨停池不可用：${message}`] }
  }
  try {
    downItems = await fetchPool('dt', options.tradeDate, fetchImpl)
  } catch (err) {
    const message = messageOf(err)
    await markSourceFailure('eastmoney', message).catch(() => {})
    return { available: false, limitUp: 0, limitDown: 0, written: 0, warnings: [`跌停池不可用：${message}`] }
  }
  const written = await writeLimitPool(upItems, options.tradeDate, new Date().toISOString())
  await markSourceSuccess('eastmoney')
  return {
    available: true,
    limitUp: upItems.length,
    limitDown: downItems.length,
    written,
    warnings,
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
              ON CONFLICT(code, trade_date, adjust_type) DO NOTHING`,
        args: [bar.code, bar.tradeDate, bar.open, bar.high, bar.low, bar.close,
          bar.volume, bar.amount, bar.sourceId, fetchedAt],
      })
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx 已关闭 */ }
    throw err
  }
}

async function upsertSymbols(
  rows: Array<{ code: string; name: string; exchange: string; industry: string | null }>,
  fetchedAt: string,
  sourceId: FreeSourceId,
): Promise<void> {
  if (rows.length === 0) return
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    // 只补空行业，不改已有名称/行业；示例标的也绝不覆盖。
    for (let offset = 0; offset < rows.length; offset += 150) {
      const chunk = rows.slice(offset, offset + 150)
      const values = chunk.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')
      const args: unknown[] = []
      for (const row of chunk) {
        args.push(row.code, row.name, row.exchange, row.industry, sourceId, fetchedAt)
      }
      await tx.execute({
        sql: `INSERT INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
              VALUES ${values}
              ON CONFLICT(code) DO UPDATE SET
                industry_l1 = COALESCE(symbols.industry_l1, excluded.industry_l1),
                updated_at = excluded.updated_at
              WHERE symbols.source_id IS NULL OR symbols.source_id NOT LIKE 'demo-%'`,
        args,
      })
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx 已关闭 */ }
    throw err
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
    args: [MAX_UNIVERSE_CODES],
  })
  return res.rows.map((row) => str(row.code)).filter(Boolean)
}

async function previousOpenDate(tradeDate: string): Promise<string | null> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT MAX(trade_date) AS d FROM trading_calendar WHERE is_open = 1 AND trade_date < ?`,
    args: [tradeDate],
  })
  return res.rows[0]?.d ? String(res.rows[0].d) : null
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

async function writeOverview(
  tradeDate: string,
  breadth: NonNullable<FreeIngestResult['breadth']>,
  turnover: NonNullable<FreeIngestResult['turnover']>,
  fetchedAt: string,
): Promise<void> {
  const db = await getDb()
  await db.execute({
    sql: `INSERT INTO market_overview (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
          VALUES (?, ?, ?, 'eastmoney', 0, ?)
          ON CONFLICT(trade_date) DO NOTHING`,
    args: [tradeDate, JSON.stringify(breadth), JSON.stringify(turnover), fetchedAt],
  })
}

/** Tushare 成功但缺涨跌停权限时，用东财池子补 counts；只动这两个字段。 */
export async function patchOverviewLimits(
  tradeDate: string,
  limits: { limitUp: number; limitDown: number },
): Promise<void> {
  const db = await getDb()
  const res = await db.execute({
    sql: 'SELECT breadth_json FROM market_overview WHERE trade_date = ? AND is_demo = 0',
    args: [tradeDate],
  })
  if (!res.rows[0]) return
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(String(res.rows[0].breadth_json)) as Record<string, unknown>
  } catch {
    return
  }
  const next = {
    ...parsed,
    limitUp: limits.limitUp,
    limitDown: limits.limitDown,
    limitUpDownAvailable: true,
    limitSource: 'eastmoney',
  }
  await db.execute({
    sql: 'UPDATE market_overview SET breadth_json = ? WHERE trade_date = ? AND is_demo = 0',
    args: [JSON.stringify(next), tradeDate],
  })
}

export async function ingestFreeMarket(options: {
  tradeDate?: string
  openDates?: string[]
  fetchImpl?: FetchLike
} = {}): Promise<FreeIngestResult> {
  const fetchImpl = options.fetchImpl || fetch
  await ensureCockpitSources()
  await assertNoDemoData()

  const warnings: string[] = []
  const log = newLog()
  const anchor = options.tradeDate || todayOf(nowDate())
  const openDates = options.openDates && options.openDates.length > 0
    ? options.openDates
    : await deriveFreeCalendar({ anchorDate: anchor, fetchImpl })
  const tradeDate = chooseTradeDate(openDates, options.tradeDate)
  const start = addDays(tradeDate, -HISTORY_DAYS)
  const fetchedAt = new Date().toISOString()
  const providers = new Set<FreeSourceId>()

  const indexBars: BarInput[] = []
  let indexCount = 0
  for (const index of INDEXES) {
    try {
      const { bars, provider } = await fetchBarsWithFallback(index.code, start, tradeDate, fetchImpl, log)
      providers.add(provider)
      indexBars.push(...bars)
      if (bars.some((bar) => bar.tradeDate === tradeDate)) indexCount += 1
      await upsertSymbols(
        [{ code: index.code, name: index.name, exchange: index.exchange, industry: '指数' }],
        fetchedAt,
        provider,
      )
    } catch (err) {
      warnings.push(`${index.name}日线未取到：${messageOf(err)}`)
    }
  }

  const codes = await researchCodes()
  const universeBars: BarInput[] = []
  for (const code of codes) {
    try {
      const { bars, provider } = await fetchBarsWithFallback(code, start, tradeDate, fetchImpl, log)
      providers.add(provider)
      universeBars.push(...bars.filter((bar) => bar.tradeDate <= tradeDate))
    } catch (err) {
      warnings.push(`${code} 日线未取到：${messageOf(err)}`)
    }
  }

  let latest: string | null = null
  try {
    latest = await latestOpenDate(fetchImpl, log)
  } catch (err) {
    warnings.push(`最新开市日无法确认，全市场快照与涨停池本次跳过：${messageOf(err)}`)
  }

  let breadth: FreeIngestResult['breadth'] = null
  let turnover: FreeIngestResult['turnover'] = null
  let limitPoolWritten = 0

  if (latest === null) {
    // 无法确认快照日期时一律不用，避免把当日数字写到历史日期上。
  } else if (tradeDate !== latest) {
    warnings.push(`请求日 ${tradeDate} 不是最新开市日 ${latest}，免费源不提供历史全市场广度与成交额`)
  } else {
    let stats: ReturnType<typeof summarizeSnapshot> | null = null
    let snapshotRows: SnapshotRow[] = []
    try {
      snapshotRows = await fetchSnapshot(fetchImpl)
      stats = summarizeSnapshot(snapshotRows)
      providers.add('eastmoney')
      log.ok.add('eastmoney')
    } catch (err) {
      noteError(log, 'eastmoney', err)
      warnings.push(`全市场快照不可用，广度与成交额本次不写入：${messageOf(err)}`)
    }

    const pool = await ingestFreeLimitPool({ tradeDate, fetchImpl })
    limitPoolWritten = pool.written
    warnings.push(...pool.warnings)
    if (pool.available) providers.add('eastmoney')

    if (stats) {
      await upsertSymbols(
        snapshotRows.map((row) => ({
          code: row.code,
          name: row.name,
          exchange: row.code.endsWith('.SH') ? 'SSE' : row.code.endsWith('.BJ') ? 'BSE' : 'SZSE',
          industry: row.industry,
        })),
        fetchedAt,
        'eastmoney',
      )
      const breadthValue = {
        up: stats.up,
        flat: stats.flat,
        down: stats.down,
        limitUp: pool.available ? pool.limitUp : 0,
        limitDown: pool.available ? pool.limitDown : 0,
        limitUpDownAvailable: pool.available,
      }
      let changePct: number | null = null
      const prevDate = await previousOpenDate(tradeDate)
      const prevTurnover = prevDate ? await storedTurnover(prevDate) : null
      if (prevDate && prevTurnover !== null && prevTurnover > 0) {
        changePct = round2(((stats.turnoverValue - prevTurnover) / prevTurnover) * 100)
      } else {
        warnings.push('前一开市日成交额不可用，成交额变化未计算')
      }
      breadth = breadthValue
      turnover = { value: stats.turnoverValue, changePct }
    }
  }

  const deduped = new Map<string, BarInput>()
  for (const bar of [...indexBars, ...universeBars]) {
    deduped.set(`${bar.code}|${bar.tradeDate}`, bar)
  }
  if (deduped.size > 0) await writeBars([...deduped.values()], fetchedAt)
  if (breadth && turnover) await writeOverview(tradeDate, breadth, turnover, fetchedAt)
  await reportLog(log)

  if (deduped.size === 0 && breadth === null) {
    throw new Error(`免费行情源均未返回有效数据${warnings.length ? `：${warnings.slice(0, 3).join('；')}` : ''}`)
  }

  return {
    tradeDate,
    source: providers.size === 0 ? 'mixed' : providers.size === 1 ? [...providers][0] : 'mixed',
    bars: deduped.size,
    indices: indexCount,
    universe: codes.length,
    breadth,
    turnover,
    limitUpDownAvailable: breadth?.limitUpDownAvailable ?? false,
    limitPoolWritten,
    warnings,
  }
}
