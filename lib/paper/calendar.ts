import { getDb } from '../db'
import { ensureTradingCalendarFuture } from '../cockpit/sources/tushare'
import {
  addCalendarDays,
  ensureChinaCalendar,
  isCalendarDate,
  isChinaMarketOpen,
  isWeekendDate,
  weekdayOf,
} from '../china-calendar'

/**
 * 模拟盘日历：优先用 trading_calendar 的真实开市日；节假日与调休补班日均休市。
 * 未来日期缺失时先按内置/订阅节假日日历补齐，结算前再用当日行情是否落库确认。
 */

export { addCalendarDays, weekdayOf }
export { isCalendarDate as isDateString, isWeekendDate as isWeekend }

export function nextWeekday(dateExclusive: string): string {
  let cursor = addCalendarDays(dateExclusive, 1)
  while (isWeekendDate(cursor)) cursor = addCalendarDays(cursor, 1)
  return cursor
}

export function previousWeekday(dateExclusive: string): string {
  let cursor = addCalendarDays(dateExclusive, -1)
  while (isWeekendDate(cursor)) cursor = addCalendarDays(cursor, -1)
  return cursor
}

/** 用将来 370 天的交易日历覆盖次日卡生成；内嵌节假日日历保证无 token 时也不把假日当开市。 */
export async function ensurePaperCalendar(input: {
  fromDate: string
  daysAhead?: number
  allowNetwork?: boolean
}): Promise<{ source: 'tushare' | 'china-calendar' | 'local'; fetched: boolean }> {
  const allowNetwork = input.allowNetwork ?? process.env.NODE_ENV !== 'test'
  const year = Number(input.fromDate.slice(0, 4))
  const china = await ensureChinaCalendar({
    years: [year, year + 1],
    allowNetwork,
  }).catch(() => null)
  if (allowNetwork) {
    try {
      const result = await ensureTradingCalendarFuture({
        fromDate: input.fromDate,
        daysAhead: input.daysAhead ?? 370,
      })
      return { source: 'tushare', fetched: result.fetched || Boolean(china?.fetched.length) }
    } catch {
      // 没有 token / 网络不可用时用节假日日历；结算仍会核对当日行情。
    }
  }
  return { source: china ? 'china-calendar' : 'local', fetched: Boolean(china?.fetched.length) }
}

/** 节假日与周末都休市；库内缺记录时由内嵌日历补齐。 */
export async function isPaperTradingDay(tradeDate: string): Promise<boolean> {
  if (!isCalendarDate(tradeDate)) return false
  return isChinaMarketOpen(tradeDate, { allowNetwork: false })
}

export async function nextPaperTradingDate(afterDate: string): Promise<string> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT trade_date FROM trading_calendar
          WHERE is_open = 1 AND trade_date > ? ORDER BY trade_date ASC LIMIT 1`,
    args: [afterDate],
  })
  if (r.rows.length) return String(r.rows[0].trade_date)
  let cursor = nextWeekday(afterDate)
  for (let i = 0; i < 10; i += 1) {
    if (await isPaperTradingDay(cursor)) return cursor
    cursor = nextWeekday(cursor)
  }
  return nextWeekday(afterDate)
}

export async function previousPaperTradingDate(beforeDate: string): Promise<string> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT trade_date FROM trading_calendar
          WHERE is_open = 1 AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`,
    args: [beforeDate],
  })
  if (r.rows.length) return String(r.rows[0].trade_date)
  let cursor = previousWeekday(beforeDate)
  for (let i = 0; i < 10; i += 1) {
    if (await isPaperTradingDay(cursor)) return cursor
    cursor = previousWeekday(cursor)
  }
  return previousWeekday(beforeDate)
}

/** 往后数第 n 个开市日；日历不足时逐个按交易日补齐。 */
export async function addPaperTradingDays(tradeDate: string, n: number): Promise<string> {
  if (n <= 0) return tradeDate
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT trade_date FROM trading_calendar
          WHERE is_open = 1 AND trade_date > ? ORDER BY trade_date ASC LIMIT ?`,
    args: [tradeDate, n],
  })
  if (r.rows.length >= n) return String(r.rows[n - 1].trade_date)
  let cursor = r.rows.length ? String(r.rows[r.rows.length - 1].trade_date) : tradeDate
  for (let i = r.rows.length; i < n; i += 1) {
    cursor = await nextPaperTradingDate(cursor)
  }
  return cursor
}

export async function openDatesBetween(startDate: string, endDate: string): Promise<string[]> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT trade_date FROM trading_calendar
          WHERE is_open = 1 AND trade_date BETWEEN ? AND ? ORDER BY trade_date ASC`,
    args: [startDate, endDate],
  })
  return r.rows.map((row) => String(row.trade_date))
}

/** 当日行情是否真的落库：休市日即使被按工作日推断也会在这里被拦住。 */
export async function hasMarketDataForDate(tradeDate: string): Promise<boolean> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT 1 AS ok FROM market_overview WHERE trade_date = ?
          UNION ALL
          SELECT 1 AS ok FROM market_bars
            WHERE trade_date = ? AND code = '000001.SH' AND adjust_type = 'raw'
          LIMIT 1`,
    args: [tradeDate, tradeDate],
  })
  return r.rows.length > 0
}
