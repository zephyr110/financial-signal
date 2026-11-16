import { getDb } from '../../db'
import { fetchWithTimeout, type FetchLike } from './http'
import {
  assertNoDemoData,
  ensureCockpitSources,
  markSourceFailure,
  markSourceSuccess,
} from './registry'

/**
 * 盘中快照（T2）：东财 → 新浪 → 腾讯依次回退，一次批量取自选、持仓与三大指数。
 * 延迟秒数按行情时间与收到时间的实际差值计算，不用 0 冒充实时。
 */

type LiveProvider = 'eastmoney' | 'sina' | 'tencent'

const PROVIDERS: LiveProvider[] = ['eastmoney', 'sina', 'tencent']
const PROVIDER_LABEL: Record<LiveProvider, string> = {
  eastmoney: '东方财富',
  sina: '新浪财经',
  tencent: '腾讯财经',
}
const COOLDOWN_AFTER_FAILURES = 2
const COOLDOWN_MS = 5 * 60_000
const TIMEOUT_MS = 8_000
const MAX_RESEARCH_CODES = 60
const BATCH_SIZE = 40
const FIELDS = 'f2,f3,f12,f13,f14,f18,f124'
const UT = 'bd1d9ddb04089700cf9c27f6f7426281'
const INDEX_CODES = ['000001.SH', '399001.SZ', '399006.SZ'] as const

const failures: Record<LiveProvider, number> = { eastmoney: 0, sina: 0, tencent: 0 }
const cooldownUntil: Record<LiveProvider, number> = { eastmoney: 0, sina: 0, tencent: 0 }

type Row = Record<string, unknown>

export interface LiveQuoteResult {
  /** 实际写入的行情条数。 */
  written: number
  skipped: number
  /** 提供这批快照的来源；全部失败时为 null。 */
  source: LiveProvider | null
  warnings: string[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (!raw || raw === '-') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function secid(code: string): string | null {
  const match = /^(\d{6})\.(SH|SZ|BJ)$/.exec(code.trim().toUpperCase())
  if (!match) return null
  return `${match[2] === 'SH' ? '1' : '0'}.${match[1]}`
}

function quoteSymbol(code: string): string {
  const prefix = code.endsWith('.SH') ? 'sh' : code.endsWith('.BJ') ? 'bj' : 'sz'
  return `${prefix}${code.slice(0, 6)}`
}

function codeFromSymbol(symbol: string): string | null {
  const match = /^(sh|sz|bj)(\d{6})$/i.exec(symbol)
  return match ? `${match[2]}.${match[1].toUpperCase()}` : null
}

function codeOf(six: string, market: number): string {
  if (market === 1) return `${six}.SH`
  if (six.startsWith('8') || six.startsWith('4') || six.startsWith('92')) return `${six}.BJ`
  return `${six}.SZ`
}

function providerReady(provider: LiveProvider, now: number): boolean {
  return cooldownUntil[provider] <= now
}

function noteFailure(provider: LiveProvider, now: number): void {
  failures[provider] += 1
  if (failures[provider] >= COOLDOWN_AFTER_FAILURES) {
    cooldownUntil[provider] = now + COOLDOWN_MS
    failures[provider] = 0
  }
}

function noteSuccess(provider: LiveProvider): void {
  failures[provider] = 0
  cooldownUntil[provider] = 0
}

async function decodeGbk(res: Response): Promise<string> {
  return new TextDecoder('gbk').decode(await res.arrayBuffer())
}

async function liveCodes(): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT DISTINCT code FROM (
            SELECT code FROM watchlist_items
            UNION
            SELECT code FROM positions WHERE account_id <> 'demo-account' AND shares > 0
          ) ORDER BY code LIMIT ?`,
    args: [MAX_RESEARCH_CODES],
  })
  const codes: string[] = []
  const seen = new Set<string>()
  for (const row of res.rows) {
    const code = text(row.code).trim().toUpperCase()
    if (!secid(code) || seen.has(code)) continue
    seen.add(code)
    codes.push(code)
  }
  for (const code of INDEX_CODES) {
    if (!seen.has(code)) codes.push(code)
  }
  return codes
}

interface ParsedQuote {
  code: string
  name: string | null
  price: number
  previousClose: number | null
  changePct: number | null
  tradeTime: Date
}

interface BatchResult {
  quotes: ParsedQuote[]
  skipped: number
}

function buildQuote(
  code: string | null,
  name: string,
  rawPrice: unknown,
  rawPreviousClose: unknown,
  rawChangePct: unknown,
  tradeTime: Date,
): ParsedQuote | null {
  const price = finite(rawPrice)
  const previousClose = finite(rawPreviousClose)
  if (!code || price == null || price <= 0 || !previousClose || previousClose <= 0) return null
  if (Number.isNaN(tradeTime.getTime())) return null
  const changePct = finite(rawChangePct)
  return {
    code,
    name: name.trim() || null,
    price,
    previousClose,
    changePct: changePct ?? ((price - previousClose) / previousClose) * 100,
    tradeTime,
  }
}

async function fetchEastmoneyBatch(codes: string[], fetchImpl: FetchLike): Promise<BatchResult> {
  const ids = codes.map(secid).filter((id): id is string => Boolean(id))
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get'
    + `?fltt=2&invt=2&fields=${FIELDS}&ut=${UT}&secids=${ids.join(',')}`
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://quote.eastmoney.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const payload = await res.json() as { data?: { diff?: unknown } } | null
  const diff = payload?.data?.diff
  const rows = Array.isArray(diff)
    ? diff as Row[]
    : diff && typeof diff === 'object'
      ? Object.values(diff as Record<string, Row>)
      : []
  if (rows.length === 0) throw new Error('缺少 diff')

  const quotes: ParsedQuote[] = []
  let skipped = 0
  for (const raw of rows) {
    const six = /^\d{6}$/.test(text(raw.f12).trim()) ? text(raw.f12).trim() : ''
    const market = finite(raw.f13)
    const epoch = finite(raw.f124)
    if (!six || market == null || epoch == null || epoch <= 0) {
      skipped += 1
      continue
    }
    const millis = epoch > 1_000_000_000_000 ? epoch : epoch * 1000
    const quote = buildQuote(
      codeOf(six, market),
      text(raw.f14),
      raw.f2,
      raw.f18,
      raw.f3,
      new Date(millis),
    )
    if (quote) quotes.push(quote)
    else skipped += 1
  }
  if (quotes.length === 0) throw new Error('没有可用行情')
  return { quotes, skipped }
}

async function fetchSinaBatch(codes: string[], fetchImpl: FetchLike): Promise<BatchResult> {
  const url = `https://hq.sinajs.cn/list=${codes.map(quoteSymbol).join(',')}`
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: '*/*',
      Referer: 'https://finance.sina.com.cn/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await decodeGbk(res)

  const quotes: ParsedQuote[] = []
  let skipped = 0
  for (const match of body.matchAll(/var hq_str_(\w+)="([^"]*)"/g)) {
    const fields = match[2].split(',')
    if (fields.length < 32) {
      skipped += 1
      continue
    }
    const quote = buildQuote(
      codeFromSymbol(match[1]),
      fields[0],
      fields[3],
      fields[2],
      null,
      new Date(`${fields[30]}T${fields[31]}+08:00`),
    )
    if (quote) quotes.push(quote)
    else skipped += 1
  }
  if (quotes.length === 0) throw new Error('快照为空')
  return { quotes, skipped }
}

async function fetchTencentBatch(codes: string[], fetchImpl: FetchLike): Promise<BatchResult> {
  const url = `https://qt.gtimg.cn/q=${codes.map(quoteSymbol).join(',')}`
  const res = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: '*/*',
      Referer: 'https://gu.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const body = await decodeGbk(res)

  const quotes: ParsedQuote[] = []
  let skipped = 0
  for (const match of body.matchAll(/v_(\w+)="([^"]*)"/g)) {
    const fields = match[2].split('~')
    const stamp = fields.length >= 35
      ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(fields[30])
      : null
    if (!stamp) {
      skipped += 1
      continue
    }
    const quote = buildQuote(
      codeFromSymbol(match[1]),
      fields[1],
      fields[3],
      fields[4],
      fields[32],
      new Date(`${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}+08:00`),
    )
    if (quote) quotes.push(quote)
    else skipped += 1
  }
  if (quotes.length === 0) throw new Error('快照为空')
  return { quotes, skipped }
}

const FETCHERS: Record<LiveProvider, (codes: string[], fetchImpl: FetchLike) => Promise<BatchResult>> = {
  eastmoney: fetchEastmoneyBatch,
  sina: fetchSinaBatch,
  tencent: fetchTencentBatch,
}

async function writeQuotes(
  quotes: ParsedQuote[],
  receivedAt: Date,
  sourceId: LiveProvider,
): Promise<number> {
  const db = await getDb()
  let written = 0
  for (const quote of quotes) {
    const delaySeconds = Math.max(0, Math.round(
      (receivedAt.getTime() - quote.tradeTime.getTime()) / 1000,
    ))
    await db.execute({
      sql: `INSERT INTO realtime_quotes
              (code, name, price, previous_close, change_pct, trade_time, delay_seconds,
               source_id, fetched_at, is_demo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(code, trade_time) DO UPDATE SET
              name = excluded.name,
              price = excluded.price,
              previous_close = excluded.previous_close,
              change_pct = excluded.change_pct,
              delay_seconds = excluded.delay_seconds,
              fetched_at = excluded.fetched_at`,
      args: [
        quote.code,
        quote.name,
        quote.price,
        quote.previousClose,
        quote.changePct,
        quote.tradeTime.toISOString(),
        delaySeconds,
        sourceId,
        receivedAt.toISOString(),
      ],
    })
    written += 1
  }
  return written
}

export async function refreshLiveQuotes(
  options: { fetchImpl?: FetchLike } = {},
): Promise<LiveQuoteResult> {
  await assertNoDemoData()
  await ensureCockpitSources()
  const codes = await liveCodes()
  const fetchImpl = fetchWithTimeout(options.fetchImpl || fetch, TIMEOUT_MS)
  const warnings: string[] = []
  const attemptAt = Date.now()

  for (const provider of PROVIDERS) {
    if (!providerReady(provider, attemptAt)) {
      warnings.push(`${PROVIDER_LABEL[provider]}冷却中`)
      continue
    }
    try {
      const quotes: ParsedQuote[] = []
      let providerSkipped = 0
      for (let index = 0; index < codes.length; index += BATCH_SIZE) {
        const result = await FETCHERS[provider](codes.slice(index, index + BATCH_SIZE), fetchImpl)
        quotes.push(...result.quotes)
        providerSkipped += result.skipped
      }
      if (quotes.length === 0) throw new Error('没有可用行情')
      const written = await writeQuotes(quotes, new Date(), provider)
      noteSuccess(provider)
      try {
        await markSourceSuccess(provider)
      } catch {
        // 来源健康度不影响已写入的行情
      }
      if (providerSkipped > 0) warnings.push(`有 ${providerSkipped} 条快照字段无效，已跳过`)
      return { written, skipped: providerSkipped, source: provider, warnings }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      noteFailure(provider, attemptAt)
      warnings.push(`${PROVIDER_LABEL[provider]}：${message}`)
      try {
        await markSourceFailure(provider, message)
      } catch {
        // 来源健康度写不进去不改变本轮“无数据”的结论
      }
    }
  }

  return { written: 0, skipped: 0, source: null, warnings }
}
