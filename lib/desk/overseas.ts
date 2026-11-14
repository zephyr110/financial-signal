import { getDb } from '../db'
import { fetchWithTimeout } from '../cockpit/sources/http'
import { assertNoDemoData, ensureCockpitSources, markSourceFailure, markSourceSuccess } from '../cockpit/sources/registry'

const SOURCE_ID = 'cboe'
const DELAY_MINUTES = 15
const QUOTES = [
  { symbol: '_SPX', name: '标普500' },
  { symbol: '_NDX', name: '纳斯达克100' },
  { symbol: '_DJI', name: '道琼斯工业' },
] as const

type Row = Record<string, unknown>

export interface OverseasRefreshResult {
  written: number
  warnings: string[]
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function pick(row: Row, keys: string[]): unknown {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** CBOE 延迟行情：免费、无需 key，盘中外盘只看隔夜方向，不追实时。 */
export async function refreshOverseasQuotes(options: { fetchImpl?: typeof fetch } = {}): Promise<OverseasRefreshResult> {
  await assertNoDemoData()
  await ensureCockpitSources()
  const db = await getDb()
  const fetchImpl = fetchWithTimeout(options.fetchImpl || fetch, 12_000)
  const warnings: string[] = []
  let written = 0

  // 三个指数互不依赖；串行时任一挂起会把整体拖到 36 秒。
  const outcomes = await Promise.all(QUOTES.map(async (quote) => {
    try {
      const res = await fetchImpl(`https://cdn-api.cboe.com/api/global/delayed_quotes/quotes/${quote.symbol}.json`, {
        headers: { Accept: 'application/json', 'User-Agent': 'financial-signal/1.0' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const payload = await res.json() as Row
      const data = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Row
      const price = num(pick(data, ['current_price', 'last', 'price', 'lastPrice']))
      if (price <= 0) throw new Error('响应缺少有效价格')
      const previousCloseRaw = pick(data, ['prev_day_close', 'previous_close', 'prevClose'])
      const previousClose = previousCloseRaw == null ? null : num(previousCloseRaw)
      const changeRaw = pick(data, ['price_change_percent', 'change_percent', 'pct_change'])
      const changePct = changeRaw == null
        ? (previousClose && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null)
        : num(changeRaw)
      const timeRaw = pick(data, ['last_trade_time', 'lastTradeTime', 'time'])
      const parsedTime = timeRaw ? new Date(String(timeRaw)) : new Date()
      const tradeTime = Number.isNaN(parsedTime.getTime()) ? new Date().toISOString() : parsedTime.toISOString()
      const fetchedAt = new Date().toISOString()

      await db.execute({
        sql: `INSERT INTO overseas_quotes
          (symbol, trade_time, price, previous_close, change_pct, source_id, delay_minutes, is_demo, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
          ON CONFLICT(symbol, trade_time) DO UPDATE SET
            price = excluded.price, previous_close = excluded.previous_close,
            change_pct = excluded.change_pct, source_id = excluded.source_id,
            delay_minutes = excluded.delay_minutes, fetched_at = excluded.fetched_at`,
        args: [quote.symbol, tradeTime, price, previousClose, changePct, SOURCE_ID, DELAY_MINUTES, fetchedAt],
      })
      return { ok: true as const }
    } catch (err) {
      return {
        ok: false as const,
        warning: `${quote.name}外盘行情未更新：${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }))
  for (const outcome of outcomes) {
    if (outcome.ok) written += 1
    else warnings.push(outcome.warning)
  }

  if (written > 0) {
    await markSourceSuccess(SOURCE_ID).catch(() => {})
  } else {
    await markSourceFailure(SOURCE_ID, warnings[0] || '全部外盘行情获取失败').catch(() => {})
  }
  return { written, warnings }
}
