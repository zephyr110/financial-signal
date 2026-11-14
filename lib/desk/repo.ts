import { getDb } from '../db'
import { getSourceHealth } from '../cockpit/repo'
import { personalIndustrySets } from './personal'
import type {
  AlertView,
  DeskEvidence,
  DeskSnapshot,
  DeskStatus,
  JudgmentEvaluation,
  JudgmentView,
  OverseasQuoteView,
} from './types'

type Row = Record<string, unknown>

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function evidenceFromRow(row: Row): DeskEvidence {
  return {
    id: str(row.id),
    kind: str(row.kind),
    label: str(row.label),
    value: str(row.value) || undefined,
    sourceId: str(row.source_id) || undefined,
    sourceName: str(row.source_name) || undefined,
    documentId: str(row.document_id) || undefined,
    asOf: str(row.as_of) || undefined,
    freshnessSeconds: row.freshness_seconds == null ? undefined : num(row.freshness_seconds),
  }
}

function judgmentFromRow(
  row: Row,
  evidence: DeskEvidence[] = [],
  evaluations: JudgmentEvaluation[] = [],
): JudgmentView {
  return {
    id: str(row.id),
    tradeDate: str(row.trade_date),
    kind: str(row.kind) as JudgmentView['kind'],
    industry: str(row.industry) || undefined,
    stance: str(row.stance) as JudgmentView['stance'],
    confidence: str(row.confidence) as JudgmentView['confidence'],
    score: num(row.score),
    headline: str(row.headline),
    summary: str(row.summary),
    drivers: parseJson<string[]>(row.drivers_json, []),
    risks: parseJson<string[]>(row.risks_json, []),
    reviewAt: str(row.review_at) || undefined,
    status: str(row.status) as JudgmentView['status'],
    version: num(row.version, 1),
    sourceId: str(row.source_id) || undefined,
    evidence,
    evaluations,
    computedAt: str(row.computed_at),
    isDemo: Number(row.is_demo) === 1,
  }
}

function alertFromRow(row: Row): AlertView {
  return {
    id: str(row.id),
    tradeDate: str(row.trade_date),
    severity: str(row.severity) as AlertView['severity'],
    category: str(row.category),
    industry: str(row.industry) || undefined,
    symbolCode: str(row.symbol_code) || undefined,
    title: str(row.title),
    summary: str(row.summary),
    whyNow: str(row.why_now),
    evidence: parseJson<DeskEvidence[]>(row.evidence_json, []),
    judgmentId: str(row.judgment_id) || undefined,
    status: str(row.status) as AlertView['status'],
    triggeredAt: str(row.triggered_at),
    acknowledgedAt: str(row.acknowledged_at) || undefined,
    isDemo: Number(row.is_demo) === 1,
  }
}

export async function listJudgmentDates(limit = 30): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT DISTINCT trade_date FROM judgments WHERE status <> 'superseded'
          ORDER BY trade_date DESC LIMIT ?`,
    args: [Math.max(1, Math.min(100, limit))],
  })
  return (res.rows as unknown as Row[]).map((row) => str(row.trade_date))
}

async function loadEvidence(judgmentIds: string[]): Promise<Map<string, DeskEvidence[]>> {
  const map = new Map<string, DeskEvidence[]>()
  if (!judgmentIds.length) return map
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT e.*, s.name AS source_name
          FROM judgment_evidence e
          LEFT JOIN source_registry s ON s.id = e.source_id
          WHERE e.judgment_id IN (${judgmentIds.map(() => '?').join(',')})
          ORDER BY e.rowid ASC`,
    args: judgmentIds,
  })
  for (const row of res.rows as unknown as Row[]) {
    const id = str(row.judgment_id)
    const list = map.get(id) || []
    list.push(evidenceFromRow(row))
    map.set(id, list)
  }
  return map
}

async function loadEvaluations(judgmentIds: string[]): Promise<Map<string, JudgmentEvaluation[]>> {
  const map = new Map<string, JudgmentEvaluation[]>()
  if (!judgmentIds.length) return map
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT judgment_id, eval_date, horizon_days, hit, return_pct, benchmark_pct
          FROM judgment_evaluations
          WHERE judgment_id IN (${judgmentIds.map(() => '?').join(',')})
          ORDER BY horizon_days ASC`,
    args: judgmentIds,
  })
  for (const row of res.rows as unknown as Row[]) {
    const id = str(row.judgment_id)
    const list = map.get(id) || []
    list.push({
      horizonDays: num(row.horizon_days),
      evalDate: str(row.eval_date),
      hit: Number(row.hit) === 1,
      returnPct: row.return_pct == null ? null : num(row.return_pct),
      benchmarkPct: row.benchmark_pct == null ? null : num(row.benchmark_pct),
    })
    map.set(id, list)
  }
  return map
}

async function withEvidence(rows: Row[]): Promise<JudgmentView[]> {
  const ids = rows.map((row) => str(row.id))
  const [evidenceMap, evaluationMap] = await Promise.all([loadEvidence(ids), loadEvaluations(ids)])
  return rows.map((row) => judgmentFromRow(row, evidenceMap.get(str(row.id)) || [], evaluationMap.get(str(row.id)) || []))
}

export async function getDeskSnapshot(tradeDate?: string): Promise<DeskSnapshot> {
  const db = await getDb()
  const dateRes = tradeDate
    ? await db.execute({ sql: 'SELECT 1 FROM judgments WHERE trade_date = ? LIMIT 1', args: [tradeDate] })
    : await db.execute({ sql: 'SELECT MAX(trade_date) AS d FROM judgments', args: [] })
  if (tradeDate && !dateRes.rows[0]) throw new Error(`${tradeDate} 没有投研台快照`)
  const date = tradeDate || (dateRes.rows[0]?.d ? String(dateRes.rows[0].d) : null)
  const [sourceHealth, overseas] = await Promise.all([getSourceHealth(), getOverseasQuotes()])
  if (!date) {
    return {
      tradeDate: null,
      asOf: new Date().toISOString(),
      market: null,
      industries: [],
      alerts: [],
      overseas,
      dataQuality: sourceHealth,
      isDemo: false,
      generatedAt: new Date().toISOString(),
    }
  }

  const [marketRes, industryRes, alertRes, personal] = await Promise.all([
    db.execute({
      sql: "SELECT * FROM judgments WHERE trade_date = ? AND kind = 'market' AND status = 'open' ORDER BY version DESC LIMIT 1",
      args: [date],
    }),
    db.execute({
      sql: "SELECT * FROM judgments WHERE trade_date = ? AND kind = 'industry' AND status = 'open' ORDER BY ABS(score) DESC LIMIT 80",
      args: [date],
    }),
    db.execute({
      // 快照只展示未处理预警；驾驶舱（未指定日期）连历史未处理一起列出，
      // 否则面板正文只显示当日、计数 status.openAlerts 却是全量，两边长期对不上。
      sql: `SELECT * FROM alerts WHERE status = 'open'${tradeDate ? ' AND trade_date = ?' : ''}
            ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 WHEN 'watch' THEN 2 ELSE 3 END,
                     triggered_at DESC
            LIMIT 6`,
      args: tradeDate ? [tradeDate] : [],
    }),
    personalIndustrySets(),
  ])
  const judgmentRows = [
    ...(marketRes.rows as unknown as Row[]),
    ...(industryRes.rows as unknown as Row[]),
  ]
  const judgments = await withEvidence(judgmentRows)
  const market = judgments.find((judgment) => judgment.kind === 'market') || null
  // 持仓行业置顶、其次自选，其余按判断强度排序
  const relationRank = (judgment: JudgmentView): number => {
    if (judgment.industry && personal.holdings.has(judgment.industry)) return 0
    if (judgment.industry && personal.watchlist.has(judgment.industry)) return 1
    return 2
  }
  const industries = judgments
    .filter((judgment) => judgment.kind === 'industry')
    .map((judgment) => ({
      ...judgment,
      relation: judgment.industry && personal.holdings.has(judgment.industry)
        ? 'holding' as const
        : judgment.industry && personal.watchlist.has(judgment.industry)
          ? 'watch' as const
          : undefined,
    }))
    .sort((a, b) => relationRank(a) - relationRank(b) || Math.abs(b.score) - Math.abs(a.score))
  const alerts = (alertRes.rows as unknown as Row[]).map(alertFromRow)
  const generatedAt = judgments.reduce((latest, judgment) => judgment.computedAt > latest ? judgment.computedAt : latest, '')
  return {
    tradeDate: date,
    asOf: generatedAt || new Date().toISOString(),
    market,
    industries,
    alerts,
    overseas,
    dataQuality: sourceHealth,
    isDemo: judgments.some((judgment) => judgment.isDemo) || alerts.some((alert) => alert.isDemo),
    generatedAt: generatedAt || new Date().toISOString(),
  }
}

export async function getDeskStatus(): Promise<DeskStatus> {
  const db = await getDb()
  const [dateRes, computedRes, alertRes, countRes, sourceHealth] = await Promise.all([
    db.execute({ sql: 'SELECT MAX(trade_date) AS d FROM judgments', args: [] }),
    db.execute({ sql: 'SELECT MAX(computed_at) AS at FROM judgments', args: [] }),
    db.execute({ sql: "SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'", args: [] }),
    db.execute({
      sql: `SELECT
              (SELECT COUNT(*) FROM judgments WHERE status = 'open') AS judgments,
              (SELECT COUNT(*) FROM industry_daily) AS industries,
              (SELECT COALESCE(MAX(is_demo), 0) FROM judgments WHERE status = 'open') AS judgments_demo,
              (SELECT COALESCE(MAX(is_demo), 0) FROM alerts WHERE status = 'open') AS alerts_demo`,
      args: [],
    }),
    getSourceHealth(),
  ])
  const date = dateRes.rows[0]?.d ? String(dateRes.rows[0].d) : null
  const lastComputedAt = computedRes.rows[0]?.at ? String(computedRes.rows[0].at) : null
  const staleSeconds = lastComputedAt
    ? Math.max(0, Math.round((Date.now() - new Date(lastComputedAt).getTime()) / 1000))
    : null
  return {
    tradeDate: date,
    hasSnapshot: Boolean(date),
    stale: staleSeconds == null || staleSeconds > 24 * 3600,
    staleSeconds,
    openAlerts: num(alertRes.rows[0]?.n),
    judgments: num(countRes.rows[0]?.judgments),
    industries: num(countRes.rows[0]?.industries),
    lastComputedAt,
    sourceHealth,
    isDemo: Boolean(date) && (
      num(countRes.rows[0]?.judgments_demo) === 1 || num(countRes.rows[0]?.alerts_demo) === 1
    ),
  }
}

export async function getOverseasQuotes(): Promise<OverseasQuoteView[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY trade_time DESC) AS rn
            FROM overseas_quotes
          ) WHERE rn = 1 ORDER BY symbol`,
    args: [],
  })
  return (res.rows as unknown as Row[]).map((row) => ({
    symbol: str(row.symbol),
    tradeTime: str(row.trade_time),
    price: num(row.price),
    previousClose: row.previous_close == null ? undefined : num(row.previous_close),
    changePct: row.change_pct == null ? undefined : num(row.change_pct),
    sourceId: str(row.source_id),
    delayMinutes: row.delay_minutes == null ? undefined : num(row.delay_minutes),
    fetchedAt: str(row.fetched_at),
  }))
}

export async function listJudgments(options: {
  kind?: 'market' | 'industry'
  industry?: string
  from?: string
  to?: string
  limit?: number
  offset?: number
} = {}): Promise<{ items: JudgmentView[]; total: number }> {
  const db = await getDb()
  const where: string[] = ["status <> 'superseded'"]
  const args: unknown[] = []
  if (options.kind) {
    where.push('kind = ?')
    args.push(options.kind)
  }
  if (options.industry) {
    where.push('industry = ?')
    args.push(options.industry)
  }
  if (options.from) {
    where.push('trade_date >= ?')
    args.push(options.from)
  }
  if (options.to) {
    where.push('trade_date <= ?')
    args.push(options.to)
  }
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 30)))
  const offset = Math.max(0, Math.floor(options.offset || 0))
  const totalRes = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM judgments WHERE ${where.join(' AND ')}`,
    args,
  })
  const res = await db.execute({
    sql: `SELECT * FROM judgments WHERE ${where.join(' AND ')}
          ORDER BY trade_date DESC, kind ASC, ABS(score) DESC
          LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  })
  return {
    items: await withEvidence(res.rows as unknown as Row[]),
    total: num(totalRes.rows[0]?.n),
  }
}

export async function listAlerts(options: { status?: string; limit?: number } = {}): Promise<AlertView[]> {
  const db = await getDb()
  const where: string[] = []
  const args: unknown[] = []
  if (options.status) {
    where.push('status = ?')
    args.push(options.status)
  }
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 50)))
  const res = await db.execute({
    sql: `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY triggered_at DESC LIMIT ?`,
    args: [...args, limit],
  })
  return (res.rows as unknown as Row[]).map(alertFromRow)
}

export async function acknowledgeAlert(id: string, status: 'acknowledged' | 'expired' = 'acknowledged'): Promise<AlertView | null> {
  const db = await getDb()
  const now = new Date().toISOString()
  await db.execute({
    sql: `UPDATE alerts SET status = ?, acknowledged_at = ?
          WHERE id = ? AND status IN ('open','acknowledged')`,
    args: [status, status === 'acknowledged' ? now : null, id],
  })
  const res = await db.execute({ sql: 'SELECT * FROM alerts WHERE id = ?', args: [id] })
  return res.rows[0] ? alertFromRow(res.rows[0] as unknown as Row) : null
}

export async function getAlert(id: string): Promise<AlertView | null> {
  const db = await getDb()
  const res = await db.execute({ sql: 'SELECT * FROM alerts WHERE id = ?', args: [id] })
  return res.rows[0] ? alertFromRow(res.rows[0] as unknown as Row) : null
}
