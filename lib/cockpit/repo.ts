import { getDb } from '../db'
import { computePortfolio } from './portfolio'
import type {
  DocumentSummary,
  EvidenceItem,
  HealthStatus,
  JournalEntry,
  PortfolioView,
  SourceHealth,
  SourceRef,
  SourceTier,
  StockDetail,
  ThesisView,
  TodayPayload,
  WatchlistItem,
} from './types'

type Row = Record<string, unknown>

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function sourceTier(value: unknown): SourceTier {
  const n = Number(value)
  return (n === 0 || n === 1 || n === 2 || n === 3 ? n : 2) as SourceTier
}

function healthStatus(row: Row): HealthStatus {
  if (Number(row.is_demo) === 1) return 'demo'
  // 停用源是“还没接入”，不是运行异常；否则未配置的官方源会长期误报红点。
  if (Number(row.enabled) !== 1) return 'inactive'
  if (str(row.last_error) || num(row.consecutive_failures) > 0) return 'error'
  if (row.last_success_at) {
    const age = Date.now() - new Date(str(row.last_success_at)).getTime()
    return age <= 48 * 3600 * 1000 ? 'ok' : 'stale'
  }
  return 'stale'
}

function sourceRef(row: Row | undefined, sourceId: string, asOf: string): SourceRef {
  return {
    id: sourceId,
    name: str(row?.name, sourceId),
    tier: sourceTier(row?.tier),
    asOf,
    url: str(row?.base_url) || undefined,
  }
}

function documentFromRow(row: Row, sourceMap: Map<string, Row>): DocumentSummary {
  const sourceId = str(row.source_id)
  const publishedAt = str(row.published_at)
  const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {})
  return {
    id: str(row.id),
    title: str(row.title),
    issuer: str(row.issuer) || undefined,
    documentNo: str(row.document_no) || undefined,
    subjectCode: metadata.code ? String(metadata.code) : undefined,
    publishedAt,
    effectiveAt: str(row.effective_at) || undefined,
    status: str(row.status) || undefined,
    url: str(row.url) || undefined,
    source: sourceRef(sourceMap.get(sourceId), sourceId, publishedAt),
  }
}

function mapThesis(row: Row): ThesisView {
  return {
    id: str(row.id),
    code: str(row.code),
    name: str(row.name, str(row.code)),
    title: str(row.title),
    claim: str(row.claim),
    horizon: str(row.horizon),
    status: str(row.status) as ThesisView['status'],
    confidence: str(row.confidence) as ThesisView['confidence'],
    invalidation: parseJson<string[]>(row.invalidation_json, []),
    supportCount: num(row.support_count),
    opposeCount: num(row.oppose_count),
    lastReviewedAt: str(row.last_reviewed_at) || undefined,
  }
}

export async function getSourceHealth(): Promise<SourceHealth[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: 'SELECT * FROM source_registry ORDER BY tier ASC, id ASC',
    args: [],
  })
  return (res.rows as unknown as Row[]).map((row) => ({
    id: str(row.id),
    name: str(row.name),
    tier: sourceTier(row.tier),
    status: healthStatus(row),
    lastSuccessAt: str(row.last_success_at) || undefined,
    message: str(row.last_error) || (Number(row.enabled) === 1 ? undefined : '尚未接入'),
  }))
}

export async function getTodayPayload(tradeDate?: string): Promise<TodayPayload | null> {
  const db = await getDb()
  const res = tradeDate
    ? await db.execute({
        sql: `SELECT payload_json FROM reports
              WHERE kind = 'daily_brief' AND subject_code = '' AND status = 'published'
                AND trade_date = ?
              ORDER BY version DESC LIMIT 1`,
        args: [tradeDate],
      })
    : await db.execute({
        sql: `SELECT payload_json FROM reports
              WHERE kind = 'daily_brief' AND status = 'published'
              ORDER BY trade_date DESC, version DESC LIMIT 1`,
        args: [],
      })
  if (!res.rows[0]) return null
  return parseJson<TodayPayload | null>(res.rows[0].payload_json, null)
}

export async function getWatchlist(): Promise<WatchlistItem[]> {
  const db = await getDb()
  const [itemsRes, barsRes, thesisRes, sourcesRes, symbolsRes] = await Promise.all([
    db.execute({ sql: 'SELECT code, note, created_at FROM watchlist_items ORDER BY created_at', args: [] }),
    db.execute({
      sql: `SELECT b.code, b.trade_date, b.close, b.source_id, b.fetched_at, b.is_demo
            FROM market_bars b JOIN watchlist_items w ON w.code = b.code
            WHERE b.adjust_type = 'raw'
            ORDER BY b.code, b.trade_date ASC`,
      args: [],
    }),
    db.execute({ sql: 'SELECT code, status FROM theses', args: [] }),
    db.execute({ sql: 'SELECT * FROM source_registry', args: [] }),
    db.execute({ sql: 'SELECT code, name FROM symbols', args: [] }),
  ])

  const barsByCode = new Map<string, Row[]>()
  for (const row of barsRes.rows as unknown as Row[]) {
    const list = barsByCode.get(str(row.code)) || []
    list.push(row)
    barsByCode.set(str(row.code), list)
  }
  const sourceMap = new Map((sourcesRes.rows as unknown as Row[]).map((row) => [str(row.id), row]))
  const nameMap = new Map((symbolsRes.rows as unknown as Row[]).map((row) => [str(row.code), str(row.name)]))
  const thesisMap = new Map((thesisRes.rows as unknown as Row[]).map((row) => [str(row.code), str(row.status)]))

  return (itemsRes.rows as unknown as Row[]).map((item) => {
    const code = str(item.code)
    const bars = (barsByCode.get(code) || []).slice(-20)
    const last = bars[bars.length - 1]
    const closes = bars.map((row) => num(row.close))
    const prev = closes.length > 1 ? closes[closes.length - 2] : null
    const price = closes[closes.length - 1] ?? 0
    const sourceId = last ? str(last.source_id) : 'unknown'
    return {
      code,
      name: nameMap.get(code) || code,
      price,
      changePct: prev && prev > 0 ? round2(((price - prev) / prev) * 100) : 0,
      sparkline: closes,
      thesisStatus: thesisMap.get(code) as WatchlistItem['thesisStatus'],
      source: sourceRef(sourceMap.get(sourceId), sourceId, last ? str(last.fetched_at) : ''),
    }
  })
}

export async function getPortfolio(): Promise<PortfolioView> {
  const db = await getDb()
  const accountRes = await db.execute({
    sql: 'SELECT * FROM portfolio_accounts ORDER BY created_at LIMIT 1',
    args: [],
  })
  const account = accountRes.rows[0] as Row | undefined
  if (!account) {
    return computePortfolio({ positions: [], prices: {} })
  }
  const accountId = str(account.id)

  const [positionsRes, barsRes, symbolsRes, sourcesRes, thesesRes] = await Promise.all([
    db.execute({
      sql: 'SELECT code, shares, avg_cost_cents FROM positions WHERE account_id = ? AND shares > 0',
      args: [accountId],
    }),
    db.execute({
      sql: `SELECT b.code, b.close, b.source_id, b.fetched_at, b.is_demo
            FROM market_bars b
            JOIN (SELECT code, MAX(trade_date) AS md FROM market_bars
                  WHERE adjust_type = 'raw' GROUP BY code) latest
              ON latest.code = b.code AND latest.md = b.trade_date
            WHERE b.adjust_type = 'raw'`,
      args: [],
    }),
    db.execute({ sql: 'SELECT code, name, industry_l1 FROM symbols', args: [] }),
    db.execute({ sql: 'SELECT * FROM source_registry', args: [] }),
    db.execute({ sql: 'SELECT code, status FROM theses', args: [] }),
  ])

  const prices: Record<string, number> = {}
  const sources: Record<string, SourceRef> = {}
  let isDemo = accountId === 'demo-account'
  const sourceMap = new Map((sourcesRes.rows as unknown as Row[]).map((row) => [str(row.id), row]))
  for (const row of barsRes.rows as unknown as Row[]) {
    const code = str(row.code)
    prices[code] = num(row.close)
    const sourceId = str(row.source_id)
    sources[code] = sourceRef(sourceMap.get(sourceId), sourceId, str(row.fetched_at))
    isDemo = isDemo || Number(row.is_demo) === 1
  }
  const names: Record<string, string> = {}
  const industries: Record<string, string> = {}
  for (const row of symbolsRes.rows as unknown as Row[]) {
    names[str(row.code)] = str(row.name)
    industries[str(row.code)] = str(row.industry_l1) || '未分类'
  }
  const positions = (positionsRes.rows as unknown as Row[]).map((row) => ({
    code: str(row.code),
    shares: num(row.shares),
    avgCostCents: num(row.avg_cost_cents),
  }))

  return computePortfolio({ positions, prices, names, industries, sources, isDemo })
}

export async function getTheses(): Promise<ThesisView[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT t.*, s.name,
                 COALESCE(SUM(CASE WHEN e.direction = 'support' THEN 1 ELSE 0 END), 0) AS support_count,
                 COALESCE(SUM(CASE WHEN e.direction = 'oppose' THEN 1 ELSE 0 END), 0) AS oppose_count
          FROM theses t
          LEFT JOIN symbols s ON s.code = t.code
          LEFT JOIN thesis_evidence e ON e.thesis_id = t.id
          GROUP BY t.id
          ORDER BY t.updated_at DESC`,
    args: [],
  })
  return (res.rows as unknown as Row[]).map(mapThesis)
}

export async function getJournal(limit = 20): Promise<JournalEntry[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: 'SELECT * FROM journal_entries ORDER BY entry_date DESC, id DESC LIMIT ?',
    args: [Math.max(1, Math.min(100, limit))],
  })
  return (res.rows as unknown as Row[]).map((row) => ({
    id: num(row.id),
    entryDate: str(row.entry_date),
    code: str(row.code) || undefined,
    action: str(row.action),
    reason: str(row.reason),
    outcomeNote: str(row.outcome_note) || undefined,
    createdAt: str(row.created_at),
  }))
}

export async function getStockDetail(code: string): Promise<StockDetail | null> {
  const db = await getDb()
  const symbolRes = await db.execute({ sql: 'SELECT * FROM symbols WHERE code = ?', args: [code] })
  const symbol = symbolRes.rows[0] as Row | undefined
  if (!symbol) return null
  const [barsRes, docsRes, sourcesRes, theses] = await Promise.all([
    db.execute({
      sql: `SELECT trade_date, close, source_id, fetched_at, is_demo FROM market_bars
            WHERE code = ? AND adjust_type = 'raw'
            ORDER BY trade_date DESC LIMIT 60`,
      args: [code],
    }),
    db.execute({
      sql: `SELECT * FROM source_documents
            WHERE (json_valid(metadata_json) AND json_extract(metadata_json, '$.code') = ?)
               OR issuer = ?
            ORDER BY published_at DESC LIMIT 10`,
      args: [code, str(symbol.name)],
    }),
    db.execute({ sql: 'SELECT * FROM source_registry', args: [] }),
    getTheses(),
  ])

  const sourceMap = new Map((sourcesRes.rows as unknown as Row[]).map((row) => [str(row.id), row]))
  const bars = (barsRes.rows as unknown as Row[]).reverse()
  const closes = bars.map((row) => num(row.close))
  const last = bars[bars.length - 1]
  const lastSourceId = last ? str(last.source_id) : 'unknown'
  const source = sourceRef(sourceMap.get(lastSourceId), lastSourceId, last ? str(last.fetched_at) : '')
  const price = closes[closes.length - 1] ?? 0
  const prev = closes.length > 1 ? closes[closes.length - 2] : null
  const changePct = prev && prev > 0 ? round2(((price - prev) / prev) * 100) : 0
  const thesis = theses.find((item) => item.code === code)
  const documents = (docsRes.rows as unknown as Row[]).map((row) => documentFromRow(row, sourceMap))
  const isDemo = bars.some((row) => Number(row.is_demo) === 1)
    || documents.some((doc) => doc.source.name.includes('示例'))

  const evidence: EvidenceItem[] = [{
    id: `fact:stock:${code}`,
    kind: 'fact',
    label: `${str(symbol.name)}收盘 ${price.toFixed(2)}，${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`,
    value: price.toFixed(2),
    source,
  }]
  if (documents[0]) {
    evidence.push({
      id: `document:${documents[0].id}`,
      kind: 'fact',
      label: documents[0].title,
      source: documents[0].source,
    })
  }
  if (thesis) {
    evidence.push({
      id: 'inference:thesis',
      kind: 'inference',
      label: `论点「${thesis.title}」当前状态：${thesis.status}；支持 ${thesis.supportCount} 条，反证 ${thesis.opposeCount} 条。`,
    })
    evidence.push({
      id: 'conclusion:thesis',
      kind: 'conclusion',
      label: '下一步逐条复核失效条件，不因单日价格改变论点。',
    })
  }

  return {
    code,
    name: str(symbol.name),
    exchange: str(symbol.exchange),
    industry: str(symbol.industry_l1) || '未分类',
    price,
    changePct,
    asOf: last ? str(last.fetched_at) : '',
    bars: bars.map((row) => ({ date: str(row.trade_date), close: num(row.close) })),
    evidence,
    documents,
    thesis,
    isDemo,
  }
}
