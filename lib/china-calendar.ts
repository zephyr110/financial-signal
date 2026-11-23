import { getDb } from './db'
import { CHINA_CALENDAR_BUNDLED } from './china-calendar-data'
import { fetchWithTimeout, type FetchLike } from './cockpit/sources/http'

/**
 * A 股休市日历：法定节假日与调休补班日都休市，调休上班日不代表交易所开市。
 * 订阅失败时保留库内数据，首次启动用仓库内 2026/2027 快照兜底。
 */

export const CHINA_CALENDAR_SOURCE_ID = 'china-calendar-ics'

/** 每年一份：新年份发布后按同一规则自动拉取，无需改代码。 */
const ICS_BASE = 'https://chinacalendar.app/ics/china-calendar-'
/** 一年满额 365/366 行；低于该值视为窗口没落全。 */
const YEAR_MIN_ROWS = 300
const NETWORK_REFRESH_MS = 24 * 60 * 60 * 1000

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isCalendarDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_RE.test(value)
}

export function addCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

export function isWeekendDate(date: string): boolean {
  const day = weekdayOf(date)
  return day === 0 || day === 6
}

export interface ChinaCalendarDay {
  date: string
  kind: 'holiday' | 'workday'
  name: string
}

export function chinaCalendarUrl(year: number): string {
  return `${ICS_BASE}${year}.ics`
}

function icsDate(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '').slice(0, 8)
  if (digits.length !== 8) return null
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  return isCalendarDate(date) ? date : null
}

/** 解析订阅 ICS：SUMMARY 以「休」/「班」开头，DTEND 为开区间。 */
export function parseChinaCalendarIcs(text: string): ChinaCalendarDay[] {
  const unfolded = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n[ \t]/g, '')
  const seen = new Set<string>()
  const days: ChinaCalendarDay[] = []
  for (const block of unfolded.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0] || ''
    const fields = new Map<string, string>()
    for (const line of body.split('\n')) {
      const index = line.indexOf(':')
      if (index <= 0) continue
      const key = line.slice(0, index).split(';')[0].trim().toUpperCase()
      if (!fields.has(key)) fields.set(key, line.slice(index + 1).trim())
    }
    const start = icsDate(fields.get('DTSTART') || '')
    if (!start) continue
    const end = icsDate(fields.get('DTEND') || '') || addCalendarDays(start, 1)
    const summary = fields.get('SUMMARY') || ''
    const kind = summary.startsWith('休')
      ? 'holiday' as const
      : summary.startsWith('班')
        ? 'workday' as const
        : null
    if (!kind) continue
    const name = summary.replace(/^[休班]\s*[｜|]?\s*/, '').trim()
    let cursor = start
    for (let guard = 0; cursor < end && guard < 370; guard += 1) {
      const key = `${cursor}:${kind}`
      if (!seen.has(key)) {
        seen.add(key)
        days.push({ date: cursor, kind, name })
      }
      cursor = addCalendarDays(cursor, 1)
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
}

function snapshotOf(year: number, days: ChinaCalendarDay[]) {
  const holidays: string[] = []
  const workdays: string[] = []
  for (const day of days) {
    if (!day.date.startsWith(`${year}-`)) continue
    if (day.kind === 'holiday') holidays.push(day.date)
    else workdays.push(day.date)
  }
  return { holidays, workdays }
}

/** 整年落库；只有本模块写过的行才允许被覆盖，Tushare 等来源保持权威。 */
async function seedYear(
  year: number,
  snapshot: { holidays: string[]; workdays: string[] },
  updatedAt: string,
): Promise<void> {
  const holidays = new Set(snapshot.holidays)
  const workdays = new Set(snapshot.workdays)
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    let cursor = `${year}-01-01`
    while (cursor.startsWith(`${year}-`)) {
      const closed = holidays.has(cursor) || workdays.has(cursor) || isWeekendDate(cursor)
      await tx.execute({
        sql: `INSERT INTO trading_calendar (trade_date, is_open, source_id, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(trade_date) DO UPDATE SET
                is_open = excluded.is_open, source_id = excluded.source_id,
                updated_at = excluded.updated_at
              WHERE trading_calendar.source_id = ?`,
        args: [cursor, closed ? 0 : 1, CHINA_CALENDAR_SOURCE_ID, updatedAt, CHINA_CALENDAR_SOURCE_ID],
      })
      cursor = addCalendarDays(cursor, 1)
    }
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }
}

async function coveredYears(years: number[]): Promise<Set<number>> {
  if (!years.length) return new Set()
  const db = await getDb()
  const placeholders = years.map(() => '?').join(',')
  const r = await db.execute({
    sql: `SELECT substr(trade_date, 1, 4) AS year, COUNT(*) AS n
          FROM trading_calendar
          WHERE substr(trade_date, 1, 4) IN (${placeholders})
          GROUP BY substr(trade_date, 1, 4)`,
    args: years.map(String),
  })
  const covered = new Set<number>()
  for (const row of r.rows) {
    if (Number(row.n) >= YEAR_MIN_ROWS) covered.add(Number(row.year))
  }
  return covered
}

async function fetchIcs(year: number, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchWithTimeout(fetchImpl)(chinaCalendarUrl(year), {
    headers: { accept: 'text/calendar,text/plain' },
  })
  if (!res.ok) throw new Error(`节假日日历 HTTP ${res.status}`)
  return res.text()
}

export interface ChinaCalendarEnsureResult {
  years: number[]
  fetched: number[]
  bundled: number[]
  cached: number[]
}

type YearSource = 'network' | 'bundled' | 'cached' | 'unavailable'

const lastNetworkAttempt = new Map<number, number>()
const inFlight = new Map<number, Promise<YearSource>>()

async function ensureYear(
  year: number,
  options: { allowNetwork: boolean; now: string; fetchImpl: FetchLike },
): Promise<YearSource> {
  const covered = (await coveredYears([year])).has(year)
  if (covered) {
    if (!options.allowNetwork) return 'cached'
    const last = lastNetworkAttempt.get(year) ?? 0
    if (Date.now() - last < NETWORK_REFRESH_MS) return 'cached'
  }
  if (options.allowNetwork) {
    // 失败也记时间，避免离线时每轮 tick 都打一次请求。
    lastNetworkAttempt.set(year, Date.now())
    try {
      const days = parseChinaCalendarIcs(await fetchIcs(year, options.fetchImpl))
      if (!days.some((day) => day.kind === 'holiday')) throw new Error('日历中没有节假日条目')
      await seedYear(year, snapshotOf(year, days), options.now)
      return 'network'
    } catch {
      if (covered) return 'cached'
    }
  }
  const bundled = CHINA_CALENDAR_BUNDLED[year]
  if (!bundled) return 'unavailable'
  await seedYear(year, bundled, options.now)
  return 'bundled'
}

export async function ensureChinaCalendar(options: {
  years?: number[]
  allowNetwork?: boolean
  now?: string
  fetchImpl?: FetchLike
} = {}): Promise<ChinaCalendarEnsureResult> {
  const now = options.now ?? new Date().toISOString()
  const current = Number(now.slice(0, 4))
  const years = [...new Set(options.years ?? [current, current + 1])]
    .filter((year) => Number.isInteger(year) && year >= 2000 && year <= 2100)
  const allowNetwork = options.allowNetwork ?? process.env.NODE_ENV !== 'test'
  const fetchImpl = options.fetchImpl ?? fetch
  const result: ChinaCalendarEnsureResult = { years, fetched: [], bundled: [], cached: [] }

  for (const year of years) {
    let task = inFlight.get(year)
    if (!task) {
      task = ensureYear(year, { allowNetwork, now, fetchImpl })
        .finally(() => inFlight.delete(year))
      inFlight.set(year, task)
    }
    const source = await task
    if (source === 'network') result.fetched.push(year)
    else if (source === 'bundled') result.bundled.push(year)
    else if (source === 'cached') result.cached.push(year)
  }
  return result
}

/** 库里没有该日记录时按工作日推断，但先尝试用内置/订阅日历补齐。 */
export async function isChinaMarketOpen(
  date: string,
  options: { allowNetwork?: boolean } = {},
): Promise<boolean> {
  if (!isCalendarDate(date)) return false
  const db = await getDb()
  const read = async () => (await db.execute({
    sql: 'SELECT is_open FROM trading_calendar WHERE trade_date = ?',
    args: [date],
  })).rows
  let rows = await read()
  if (!rows.length) {
    try {
      await ensureChinaCalendar({
        years: [Number(date.slice(0, 4))],
        allowNetwork: options.allowNetwork,
      })
    } catch {
      // 落库失败不能把休市日当交易日；仍按工作日兜底，交给当日行情做最终确认。
    }
    rows = await read()
  }
  if (rows.length) return Number(rows[0].is_open) === 1
  return !isWeekendDate(date)
}
