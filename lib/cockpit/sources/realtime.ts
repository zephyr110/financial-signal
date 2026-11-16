import crypto from 'crypto'
import { getDb } from '../../db'
import { fetchWithTimeout } from './http'
import { assertNoDemoData, ensureCockpitSources, markSourceFailure, markSourceSuccess } from './registry'

/** 可选付费源：未配置 REALTIME_SOURCE_URL 时零网络请求，且绝不写入无延迟标注的数据。 */
const SOURCE_ID = 'realtime'
const TIMEOUT_MS = 10_000

type Row = Record<string, unknown>

export interface RealtimeRefreshResult {
  configured: boolean
  quotes: number
  news: number
  skipped: number
  warnings: string[]
}

interface RealtimeOptions {
  fetchImpl?: typeof fetch
  url?: string
  token?: string
}

function configuredUrl(options: RealtimeOptions): string {
  return (options.url ?? process.env.REALTIME_SOURCE_URL ?? '').trim()
}

function configuredToken(options: RealtimeOptions): string {
  return (options.token ?? process.env.REALTIME_SOURCE_TOKEN ?? '').trim()
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 只接受数字或非空数字串：Number(null) 和 Number('') 都是 0，会把缺失的延迟读成“实时”。 */
function finite(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 延迟必须是明确的非负整数；缺失一律丢弃，不默认成 0（实时）。 */
function delaySeconds(value: unknown): number | null {
  const n = finite(value)
  return n == null || n < 0 ? null : Math.round(n)
}

function isoTime(value: unknown): string | null {
  const raw = text(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function docId(externalId: string): string {
  return `${SOURCE_ID}:${crypto.createHash('sha1').update(externalId).digest('hex').slice(0, 24)}`
}

async function writeQuotes(rows: unknown[], fetchedAt: string): Promise<{ written: number; skipped: number }> {
  const db = await getDb()
  let written = 0
  let skipped = 0
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') { skipped += 1; continue }
    const row = raw as Row
    const code = text(row.code)
    const price = finite(row.price)
    const tradeTime = isoTime(row.tradeTime ?? row.trade_time)
    const delay = delaySeconds(row.delaySeconds ?? row.delay_seconds)
    if (!code || price == null || price <= 0 || !tradeTime || delay == null) {
      skipped += 1
      continue
    }
    const previousClose = finite(row.previousClose ?? row.previous_close)
    const changePct = finite(row.changePct ?? row.change_pct)
      ?? (previousClose && previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : null)
    await db.execute({
      sql: `INSERT INTO realtime_quotes
              (code, name, price, previous_close, change_pct, trade_time, delay_seconds,
               source_id, fetched_at, is_demo)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(code, trade_time) DO UPDATE SET
              name = excluded.name, price = excluded.price, previous_close = excluded.previous_close,
              change_pct = excluded.change_pct, delay_seconds = excluded.delay_seconds,
              source_id = excluded.source_id, fetched_at = excluded.fetched_at`,
      args: [
        code,
        text(row.name) || null,
        price,
        previousClose,
        changePct,
        tradeTime,
        delay,
        SOURCE_ID,
        fetchedAt,
      ],
    })
    written += 1
  }
  return { written, skipped }
}

async function writeNews(rows: unknown[], fetchedAt: string): Promise<{ written: number; skipped: number }> {
  const db = await getDb()
  let written = 0
  let skipped = 0
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') { skipped += 1; continue }
    const row = raw as Row
    const title = text(row.title)
    const delay = delaySeconds(row.delaySeconds ?? row.delay_seconds)
    if (!title || delay == null) {
      skipped += 1
      continue
    }
    const providerId = text(row.id) || text(row.url) || title
    const externalId = `${SOURCE_ID}:${providerId.slice(0, 200)}`
    const publishedAt = isoTime(row.publishedAt ?? row.published_at) ?? fetchedAt
    const url = text(row.url) || null
    const summary = text(row.summary)
    const body = text(row.content) || summary
    await db.execute({
      sql: `INSERT INTO source_documents
              (id, source_id, doc_type, external_id, title, issuer, document_no, published_at,
               effective_at, status, url, content_path, full_text, raw_hash, fetched_at,
               supersedes_id, metadata_json, is_demo)
            VALUES (?, ?, 'news', ?, ?, NULL, NULL, ?, NULL, NULL, ?, NULL, ?, ?, ?, NULL, ?, 0)
            ON CONFLICT(id) DO UPDATE SET
              title = excluded.title, published_at = excluded.published_at, url = excluded.url,
              full_text = excluded.full_text, raw_hash = excluded.raw_hash,
              fetched_at = excluded.fetched_at, metadata_json = excluded.metadata_json`,
      args: [
        docId(externalId),
        SOURCE_ID,
        externalId,
        title.slice(0, 300),
        publishedAt,
        url,
        body || null,
        crypto.createHash('sha256').update(`${externalId}|${title}|${body}`).digest('hex'),
        fetchedAt,
        JSON.stringify({
          delay_seconds: delay,
          provider_id: providerId,
          ...(text(row.code) ? { code: text(row.code) } : {}),
        }),
      ],
    })
    written += 1
  }
  return { written, skipped }
}

/**
 * 拉取一次付费源快照。响应约定：
 * { quotes: [{code,name,price,previousClose,changePct,tradeTime,delaySeconds}],
 *   news: [{id,title,publishedAt,url,summary,delaySeconds}] }
 * 缺少 delaySeconds 的条目直接丢弃并计入 skipped。
 */
export async function refreshRealtimeFeed(options: RealtimeOptions = {}): Promise<RealtimeRefreshResult> {
  const url = configuredUrl(options)
  if (!url) return { configured: false, quotes: 0, news: 0, skipped: 0, warnings: [] }

  await assertNoDemoData()
  await ensureCockpitSources()
  const fetchImpl = fetchWithTimeout(options.fetchImpl || fetch, TIMEOUT_MS)
  const token = configuredToken(options)
  const warnings: string[] = []

  let payload: unknown
  try {
    const res = await fetchImpl(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'financial-signal/1.0',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    payload = await res.json()
  } catch (err) {
    const message = `付费快照源请求失败：${err instanceof Error ? err.message : String(err)}`
    await markSourceFailure(SOURCE_ID, message).catch(() => {})
    return { configured: true, quotes: 0, news: 0, skipped: 0, warnings: [message] }
  }

  const root = payload && typeof payload === 'object' ? payload as Row : {}
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Row : root
  const quoteRows = Array.isArray(data.quotes) ? data.quotes : []
  const newsRows = Array.isArray(data.news) ? data.news : []
  const fetchedAt = new Date().toISOString()

  const [quotes, news] = await Promise.all([
    writeQuotes(quoteRows, fetchedAt),
    writeNews(newsRows, fetchedAt),
  ])
  const skipped = quotes.skipped + news.skipped
  if (quotes.skipped > 0 || news.skipped > 0) {
    warnings.push(`付费快照源有 ${skipped} 条数据缺少延迟标注或字段无效，已丢弃。`)
  }

  const written = quotes.written + news.written
  if (written > 0) {
    await markSourceSuccess(SOURCE_ID).catch(() => {})
  } else {
    const message = warnings[0] || '付费快照源没有可用数据'
    await markSourceFailure(SOURCE_ID, message).catch(() => {})
    if (!warnings.length) warnings.push(message)
  }
  return { configured: true, quotes: quotes.written, news: news.written, skipped, warnings }
}
