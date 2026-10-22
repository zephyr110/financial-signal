import { getDb } from '../db'
import type {
  Breadth,
  DataQualityItem,
  DocumentSummary,
  FactPack,
  FactRef,
  HealthStatus,
  MarketIndex,
  PositionInput,
  SourceRef,
  SourceTier,
  Turnover,
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

function changePct(closes: number[]): number {
  if (closes.length < 2) return 0
  const prev = closes[closes.length - 2]
  const last = closes[closes.length - 1]
  return prev > 0 ? round2(((last - prev) / prev) * 100) : 0
}

function sourceTier(value: unknown): SourceTier {
  const n = Number(value)
  return (n === 0 || n === 1 || n === 2 || n === 3 ? n : 2) as SourceTier
}

interface SourceRow {
  id: string
  name: string
  tier: SourceTier
  base_url: string | null
  is_demo: number
  last_success_at: string | null
  last_error: string | null
  consecutive_failures: number
  enabled: number
}

function refFrom(row: SourceRow | undefined, sourceId: string, asOf: string): SourceRef {
  return {
    id: sourceId,
    name: row?.name || sourceId,
    tier: row ? sourceTier(row.tier) : 2,
    asOf,
    url: row?.base_url || undefined,
  }
}

function healthStatus(row: SourceRow): HealthStatus {
  if (row.is_demo) return 'demo'
  if (!row.enabled) return 'inactive'
  if (row.last_error || row.consecutive_failures > 0) return 'error'
  if (row.last_success_at) {
    const age = Date.now() - new Date(row.last_success_at).getTime()
    return age <= 48 * 3600 * 1000 ? 'ok' : 'stale'
  }
  return 'stale'
}

/**
 * 事实包是简报唯一输入：只放可追溯的数据库行与明确公式，
 * 不让模型从新闻正文里自行“找数字”。
 */
export async function buildFactPack(tradeDate: string): Promise<FactPack> {
  const db = await getDb()

  const overviewRes = await db.execute({
    sql: 'SELECT * FROM market_overview WHERE trade_date = ?',
    args: [tradeDate],
  })
  const overview = overviewRes.rows[0] as Row | undefined
  if (!overview) throw new Error(`没有 ${tradeDate} 的市场概览，先完成收盘数据入库`)

  const [sourcesRes, symbolsRes, barsRes, docsRes, positionsRes, thesesRes] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM source_registry ORDER BY tier, id', args: [] }),
    db.execute({ sql: 'SELECT * FROM symbols ORDER BY code', args: [] }),
    db.execute({
      // 只取研究范围内标的的最近 20 根日线；全市场历史会让事实包和快照无谓膨胀。
      sql: `SELECT code, trade_date, close, source_id, fetched_at, is_demo
            FROM (
              SELECT b.code, b.trade_date, b.close, b.source_id, b.fetched_at, b.is_demo,
                     ROW_NUMBER() OVER (PARTITION BY b.code ORDER BY b.trade_date DESC) AS rn
              FROM market_bars b
              WHERE b.trade_date <= ? AND b.adjust_type = 'raw'
                AND (
                  b.code IN (SELECT code FROM watchlist_items)
                  OR b.code IN (
                    SELECT code FROM positions
                    WHERE account_id = (SELECT id FROM portfolio_accounts ORDER BY created_at LIMIT 1)
                      AND shares > 0
                  )
                  OR b.code IN (SELECT code FROM symbols WHERE industry_l1 = '指数')
                )
            )
            WHERE rn <= 20
            ORDER BY code, trade_date ASC`,
      args: [tradeDate],
    }),
    db.execute({
      // 上海日末 = 当日 16:00Z；排他上界避免把次日凌晨公告算进当天简报。
      sql: `SELECT * FROM source_documents
            WHERE published_at < ?
            ORDER BY published_at DESC LIMIT 12`,
      args: [`${tradeDate}T16:00:00.000Z`],
    }),
    db.execute({
      sql: `SELECT code, shares, avg_cost_cents FROM positions
            WHERE account_id = (SELECT id FROM portfolio_accounts ORDER BY created_at LIMIT 1)
              AND shares > 0
            ORDER BY code`,
      args: [],
    }),
    db.execute({
      sql: 'SELECT id, code, title, status, confidence, invalidation_json FROM theses ORDER BY code, id',
      args: [],
    }),
  ])

  const sourceRows = sourcesRes.rows as unknown as SourceRow[]
  const sourceMap = new Map(sourceRows.map((row) => [row.id, row]))
  const symbols = new Map<string, Row>()
  for (const row of symbolsRes.rows as unknown as Row[]) symbols.set(str(row.code), row)
  const barsByCode = new Map<string, Row[]>()
  for (const row of barsRes.rows as unknown as Row[]) {
    const code = str(row.code)
    const list = barsByCode.get(code) || []
    list.push(row)
    barsByCode.set(code, list)
  }

  const overviewSourceId = str(overview.source_id)
  const overviewAsOf = str(overview.created_at, new Date().toISOString())
  const overviewSource = refFrom(sourceMap.get(overviewSourceId), overviewSourceId, overviewAsOf)
  const breadthRaw = parseJson<Partial<Breadth>>(overview.breadth_json, {})
  const breadth: Breadth = {
    up: num(breadthRaw.up),
    flat: num(breadthRaw.flat),
    down: num(breadthRaw.down),
    limitUp: num(breadthRaw.limitUp),
    limitDown: num(breadthRaw.limitDown),
    source: overviewSource,
  }
  const turnoverRaw = parseJson<Partial<Turnover>>(overview.turnover_json, {})
  const turnover: Turnover = {
    value: num(turnoverRaw.value),
    changePct: num(turnoverRaw.changePct),
    source: overviewSource,
  }

  const facts: Record<string, FactRef> = {
    'fact:breadth:up': {
      factId: 'fact:breadth:up', value: breadth.up, unit: '家', asOf: overviewAsOf,
      sourceId: overviewSourceId, sourceUrl: overviewSource.url, tier: overviewSource.tier,
    },
    'fact:breadth:down': {
      factId: 'fact:breadth:down', value: breadth.down, unit: '家', asOf: overviewAsOf,
      sourceId: overviewSourceId, sourceUrl: overviewSource.url, tier: overviewSource.tier,
    },
    'fact:turnover': {
      factId: 'fact:turnover', value: turnover.value, unit: '亿元', asOf: overviewAsOf,
      sourceId: overviewSourceId, sourceUrl: overviewSource.url, tier: overviewSource.tier,
    },
  }

  const indices: MarketIndex[] = []
  const stocks: FactPack['stocks'] = []
  let latestAsOf = overviewAsOf
  let isDemo = Number(overview.is_demo) === 1

  for (const [code, bars] of barsByCode) {
    const row = bars[bars.length - 1]
    // 行情回补滞后时，最后一根可能是前一交易日的；不能把它当成当日收盘写进简报。
    if (!row || str(row.trade_date) !== tradeDate) continue
    const closes = bars.slice(-20).map((b) => num(b.close))
    if (closes.length === 0) continue
    const sourceId = str(row.source_id)
    const asOf = str(row.fetched_at, overviewAsOf)
    const source = refFrom(sourceMap.get(sourceId), sourceId, asOf)
    const name = str(symbols.get(code)?.name, code)
    const industry = str(symbols.get(code)?.industry_l1)
    const last = closes[closes.length - 1]
    const pct = changePct(closes)
    const demo = Number(row.is_demo) === 1
    isDemo = isDemo || demo
    if (asOf > latestAsOf) latestAsOf = asOf

    if (industry === '指数') {
      facts[`fact:index:${code}`] = {
        factId: `fact:index:${code}`, value: last, unit: '点', asOf,
        sourceId, sourceUrl: source.url, tier: source.tier,
      }
      indices.push({ code, name, close: last, changePct: pct, sparkline: closes, source })
    } else {
      facts[`fact:stock:${code}`] = {
        factId: `fact:stock:${code}`, value: last, unit: '元', asOf,
        sourceId, sourceUrl: source.url, tier: source.tier,
      }
      stocks.push({ code, name, price: last, changePct: pct, sparkline: closes, source })
    }
  }

  const documents: DocumentSummary[] = (docsRes.rows as unknown as Row[]).map((row) => {
    const sourceId = str(row.source_id)
    const publishedAt = str(row.published_at)
    const source = refFrom(sourceMap.get(sourceId), sourceId, publishedAt)
    const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {})
    isDemo = isDemo || Number(row.is_demo) === 1
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
      source,
    }
  })

  const positions: PositionInput[] = (positionsRes.rows as unknown as Row[]).map((row) => ({
    code: str(row.code),
    shares: num(row.shares),
    avgCostCents: num(row.avg_cost_cents),
  }))

  const dataQuality: DataQualityItem[] = sourceRows.map((row) => ({
    id: row.id,
    name: row.name,
    tier: sourceTier(row.tier),
    status: healthStatus(row),
    asOf: row.last_success_at || undefined,
    message: row.last_error || (row.enabled ? undefined : '尚未接入'),
  }))

  const theses: FactPack['theses'] = (thesesRes.rows as unknown as Row[]).map((row) => ({
    id: str(row.id),
    code: str(row.code),
    title: str(row.title),
    status: str(row.status) as FactPack['theses'][number]['status'],
    confidence: str(row.confidence) as FactPack['theses'][number]['confidence'],
    invalidation: parseJson<string[]>(row.invalidation_json, []),
  }))

  return {
    tradeDate,
    asOf: latestAsOf,
    indices: indices.sort((a, b) => a.code.localeCompare(b.code)),
    breadth,
    turnover,
    stocks,
    documents,
    positions,
    theses,
    facts,
    dataQuality,
    isDemo,
  }
}
