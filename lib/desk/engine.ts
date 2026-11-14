import crypto from 'crypto'
import { getDb } from '../db'
import { dateShanghai, formatTime } from '../cockpit/format'
import type { IndustryDailyView, DeskEvidence, DeskRefreshResult, DeskSeverity } from './types'
import { personalIndustrySet } from './personal'
import { refreshOverseasQuotes } from './overseas'

type Row = Record<string, unknown>

const INDEX_CODES = ['000001.SH', '399001.SZ', '399006.SZ'] as const
const RECENT_TRADE_DATES = 25
// 预警只跟持仓相关与波动最大的行业，行业判断本身全量生成
const MAX_ALERT_INDUSTRIES = 8
const MAX_ALERTS = 6

const NEGATIVE_EVENT_WORDS = /下滑|亏损|减持|处罚|立案|退市|风险|下调|召回|事故|监管|违约|爆雷|冻结/
const POSITIVE_EVENT_WORDS = /增长|中标|回购|增持|分红|上调|突破|获批|补贴|签约|超预期|扭亏/
const CRITICAL_EVENT_WORDS = /立案|处罚|退市|重大风险|违约|爆雷|冻结/

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
}

function median(values: number[]): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function hash(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16)
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export async function latestDeskTradeDate(): Promise<string | null> {
  const db = await getDb()
  // 取三张表的公共最大值：派生表 industry_daily 停在首次刷新日，不能作为行情最新日的依据。
  const res = await db.execute({
    sql: `SELECT MAX(d) AS d FROM (
            SELECT MAX(trade_date) AS d FROM industry_daily
            UNION ALL SELECT MAX(trade_date) FROM market_overview
            UNION ALL SELECT MAX(trade_date) FROM market_bars WHERE adjust_type = 'raw'
          )`,
    args: [],
  })
  const value = res.rows[0]?.d
  return value ? String(value) : null
}

async function resolveTradeDate(requested?: string): Promise<string> {
  const db = await getDb()
  if (requested) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) throw new Error('交易日格式应为 YYYY-MM-DD')
    const res = await db.execute({
      sql: "SELECT 1 FROM market_bars WHERE trade_date = ? AND adjust_type = 'raw' LIMIT 1",
      args: [requested],
    })
    if (!res.rows[0]) throw new Error(`${requested} 没有可用行情，先完成行情入库`)
    return requested
  }
  const latest = await latestDeskTradeDate()
  if (!latest) throw new Error('没有可用行情，先完成行情入库')
  return latest
}

interface IndustryBuild {
  aggregates: IndustryDailyView[]
  events: IndustryEventInput[]
  sourceMap: Map<string, Row>
  personalIndustries: Set<string>
}

export interface IndustryEventInput {
  id: string
  tradeDate: string
  industry: string
  eventType: string
  sourceId: string | null
  sourceRef: string | null
  title: string
  summary: string | null
  impact: 'positive' | 'negative' | 'neutral' | 'mixed'
  severity: DeskSeverity
  publishedAt: string
  documentId: string
  isDemo: boolean
}

async function buildIndustryData(tradeDate: string): Promise<IndustryBuild> {
  const db = await getDb()
  const sourceRes = await db.execute({ sql: 'SELECT * FROM source_registry', args: [] })
  const sourceMap = new Map((sourceRes.rows as unknown as Row[]).map((row) => [str(row.id), row]))

  const recentRes = await db.execute({
    sql: `SELECT DISTINCT trade_date FROM market_bars
          WHERE adjust_type = 'raw' AND trade_date <= ?
          ORDER BY trade_date DESC LIMIT ?`,
    args: [tradeDate, RECENT_TRADE_DATES],
  })
  const recentDates = (recentRes.rows as unknown as Row[]).map((row) => str(row.trade_date)).filter(Boolean)
  if (!recentDates.includes(tradeDate)) throw new Error(`${tradeDate} 没有可用行情`)

  const barsRes = await db.execute({
    sql: `SELECT b.code, b.trade_date, b.close, b.amount, b.source_id, b.is_demo,
                 s.name, s.industry_l1
          FROM market_bars b
          JOIN symbols s ON s.code = b.code
          JOIN (SELECT DISTINCT trade_date FROM market_bars
                WHERE adjust_type = 'raw' AND trade_date <= ?
                ORDER BY trade_date DESC LIMIT ?) recent
            ON recent.trade_date = b.trade_date
          WHERE b.adjust_type = 'raw'
            AND s.industry_l1 IS NOT NULL AND s.industry_l1 <> '' AND s.industry_l1 <> '指数'
          ORDER BY b.code, b.trade_date ASC`,
    args: [tradeDate, RECENT_TRADE_DATES],
  })

  const byCode = new Map<string, {
    name: string
    industry: string
    rows: Row[]
  }>()
  for (const row of barsRes.rows as unknown as Row[]) {
    const code = str(row.code)
    const item = byCode.get(code) || {
      name: str(row.name, code),
      industry: str(row.industry_l1),
      rows: [],
    }
    item.rows.push(row)
    byCode.set(code, item)
  }

  // date -> industry -> per-stock daily return rows
  const daily = new Map<string, Map<string, Array<{
    code: string
    name: string
    pct: number
    amount: number
    sourceId: string
    isDemo: boolean
  }>>>()
  for (const [code, item] of byCode) {
    let prevClose: number | null = null
    for (const row of item.rows) {
      const close = num(row.close)
      if (prevClose && prevClose > 0) {
        const date = str(row.trade_date)
        const dateMap = daily.get(date) || new Map()
        const list = dateMap.get(item.industry) || []
        list.push({
          code,
          name: item.name,
          pct: ((close - prevClose) / prevClose) * 100,
          amount: num(row.amount),
          sourceId: str(row.source_id),
          isDemo: Number(row.is_demo) === 1,
        })
        dateMap.set(item.industry, list)
        daily.set(date, dateMap)
      }
      prevClose = close
    }
  }

  const dailyAvg = new Map<string, Map<string, number>>()
  for (const [date, industryMap] of daily) {
    const avgMap = new Map<string, number>()
    for (const [industry, rows] of industryMap) {
      avgMap.set(industry, mean(rows.map((row) => row.pct)))
    }
    dailyAvg.set(date, avgMap)
  }

  const orderedDates = [...dailyAvg.keys()].sort()
  const targetIndex = orderedDates.indexOf(tradeDate)
  const targetData = daily.get(tradeDate) || new Map()
  const previousDate = targetIndex > 0 ? orderedDates[targetIndex - 1] : null
  const aggregates: IndustryDailyView[] = []

  for (const [industry, rows] of targetData) {
    if (rows.length === 0) continue
    const pcts = rows.map((row) => row.pct)
    const upCount = pcts.filter((pct) => pct > 0.01).length
    const downCount = pcts.filter((pct) => pct < -0.01).length
    const flatCount = rows.length - upCount - downCount
    const limitUpCount = pcts.filter((pct) => pct >= 9.8).length
    const limitDownCount = pcts.filter((pct) => pct <= -9.8).length
    const leader = [...rows].sort((a, b) => b.pct - a.pct)[0]
    const turnover = rows.reduce((sum, row) => sum + row.amount, 0)
    const prevTotal = previousDate
      ? (daily.get(previousDate)?.get(industry) || []).reduce((sum, row) => sum + row.amount, 0)
      : null
    const momentumWindow = orderedDates
      .slice(Math.max(0, targetIndex - 19), targetIndex + 1)
      .map((date) => dailyAvg.get(date)?.get(industry))
      .filter((value): value is number => typeof value === 'number')
    const momentum5 = momentumWindow.slice(-5)
    const sourceId = leader?.sourceId || str([...sourceMap.keys()][0], 'unknown')

    aggregates.push({
      tradeDate,
      industry,
      members: rows.length,
      upCount,
      downCount,
      flatCount,
      limitUpCount,
      limitDownCount,
      avgPct: round2(mean(pcts)),
      medianPct: round2(median(pcts)),
      breadth: round2((upCount / rows.length) * 100),
      turnover: round2(turnover),
      turnoverChangePct: prevTotal && prevTotal > 0 ? round2(((turnover - prevTotal) / prevTotal) * 100) : null,
      momentum5d: momentum5.length >= 2 ? round2(mean(momentum5)) : null,
      momentum20d: momentumWindow.length >= 2 ? round2(mean(momentumWindow)) : null,
      leaderCode: leader?.code,
      leaderName: leader?.name,
      leaderPct: leader ? round2(leader.pct) : undefined,
      sourceId,
      isDemo: rows.some((row) => row.isDemo),
    })
  }

  const events = await buildIndustryEvents(tradeDate)
  const personal = await personalIndustrySet()
  return {
    aggregates,
    events,
    sourceMap,
    personalIndustries: personal,
  }
}


async function buildIndustryEvents(tradeDate: string): Promise<IndustryEventInput[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT d.id, d.source_id, d.doc_type, d.external_id, d.title, d.full_text,
                 d.published_at, d.metadata_json, d.is_demo,
                 s.industry_l1 AS industry, s.code AS symbol_code
          FROM source_documents d
          JOIN symbols s ON s.code = json_extract(d.metadata_json, '$.code')
          WHERE d.published_at >= date(?, '-3 days')
            AND d.published_at < date(?, '+2 days')
            AND s.industry_l1 IS NOT NULL AND s.industry_l1 <> '' AND s.industry_l1 <> '指数'
          ORDER BY d.published_at DESC
          LIMIT 200`,
    args: [tradeDate, tradeDate],
  })
  const events: IndustryEventInput[] = []
  for (const row of res.rows as unknown as Row[]) {
    const title = str(row.title)
    if (!title) continue
    const sourceId = str(row.source_id) || null
    const sourceRef = str(row.external_id) || str(row.id)
    const impact = NEGATIVE_EVENT_WORDS.test(title)
      ? 'negative'
      : POSITIVE_EVENT_WORDS.test(title)
        ? 'positive'
        : 'neutral'
    const severity: DeskSeverity = CRITICAL_EVENT_WORDS.test(title)
      ? 'critical'
      : str(row.doc_type) === 'policy' || impact !== 'neutral'
        ? 'important'
        : 'watch'
    events.push({
      id: `event:${str(row.id)}`,
      tradeDate,
      industry: str(row.industry),
      eventType: str(row.doc_type, 'document'),
      sourceId,
      sourceRef,
      title: title.slice(0, 300),
      summary: str(row.full_text).slice(0, 400) || null,
      impact,
      severity,
      publishedAt: str(row.published_at),
      documentId: str(row.id),
      isDemo: Number(row.is_demo) === 1,
    })
  }
  return events
}

function judgmentScore(aggregate: IndustryDailyView): number {
  const breadthScore = ((aggregate.breadth - 50) / 50) * 40
  const moveScore = clamp(aggregate.avgPct * 6, -25, 25)
  const momentumScore = clamp((aggregate.momentum5d || 0) * 4, -20, 20)
  const limitScore = clamp((aggregate.limitUpCount - aggregate.limitDownCount) * 1.2, -10, 10)
  return round2(clamp(breadthScore + moveScore + momentumScore + limitScore, -100, 100))
}

function stanceOf(score: number): 'bullish' | 'neutral' | 'bearish' {
  if (score >= 15) return 'bullish'
  if (score <= -15) return 'bearish'
  return 'neutral'
}

function confidenceOf(score: number, sample: number, events: number): 'low' | 'medium' | 'high' {
  const magnitude = Math.abs(score)
  if (sample >= 8 && (magnitude >= 40 || events >= 2)) return 'high'
  if (sample >= 5 || magnitude >= 20) return 'medium'
  return 'low'
}

function sourceEvidence(
  sourceId: string,
  sourceMap: Map<string, Row>,
  asOf: string,
  freshnessSeconds: number | null,
): { sourceId: string; sourceName: string; asOf: string; freshnessSeconds?: number } {
  return {
    sourceId,
    sourceName: str(sourceMap.get(sourceId)?.name, sourceId),
    asOf,
    freshnessSeconds: freshnessSeconds ?? undefined,
  }
}

function industryJudgment(
  aggregate: IndustryDailyView,
  events: IndustryEventInput[],
  sourceMap: Map<string, Row>,
  tradeDate: string,
): {
  id: string
  scopeKey: string
  stance: 'bullish' | 'neutral' | 'bearish'
  confidence: 'low' | 'medium' | 'high'
  score: number
  headline: string
  summary: string
  drivers: string[]
  risks: string[]
  evidence: DeskEvidence[]
} {
  const score = judgmentScore(aggregate)
  const stance = stanceOf(score)
  const related = events.filter((event) => event.industry === aggregate.industry)
  // 证据 id 是全局主键，必须带交易日，否则次日刷新会与旧证据冲突。
  const evidence: DeskEvidence[] = [
    {
      id: `ie:${tradeDate}:${aggregate.industry}:breadth`,
      kind: 'breadth',
      label: '上涨家数占比',
      value: `${aggregate.breadth}%（${aggregate.upCount}/${aggregate.members}）`,
      ...sourceEvidence(aggregate.sourceId, sourceMap, tradeDate, null),
    },
    {
      id: `ie:${tradeDate}:${aggregate.industry}:avg`,
      kind: 'return',
      label: '成分股平均涨跌',
      value: `${aggregate.avgPct > 0 ? '+' : ''}${aggregate.avgPct}%`,
      ...sourceEvidence(aggregate.sourceId, sourceMap, tradeDate, null),
    },
    {
      id: `ie:${tradeDate}:${aggregate.industry}:momentum`,
      kind: 'momentum',
      label: '5 日平均动量',
      value: aggregate.momentum5d == null ? '样本不足' : `${aggregate.momentum5d > 0 ? '+' : ''}${aggregate.momentum5d}%`,
      ...sourceEvidence(aggregate.sourceId, sourceMap, tradeDate, null),
    },
  ]
  for (const event of related.slice(0, 2)) {
    evidence.push({
      id: `ie:${tradeDate}:${aggregate.industry}:event:${hash(event.id)}`,
      kind: 'document',
      label: event.title,
      value: event.impact === 'negative' ? '偏负面' : event.impact === 'positive' ? '偏正面' : '中性',
      sourceId: event.sourceId || undefined,
      sourceName: event.sourceId ? str(sourceMap.get(event.sourceId)?.name, event.sourceId) : undefined,
      documentId: event.documentId,
      asOf: event.publishedAt,
    })
  }

  const leaderText = aggregate.leaderName && aggregate.leaderPct != null
    ? `领涨 ${aggregate.leaderName}（${aggregate.leaderPct > 0 ? '+' : ''}${aggregate.leaderPct}%）`
    : ''
  const eventText = related.length ? `；相关公告/政策 ${related.length} 条` : ''
  const label = stance === 'bullish' ? '短线偏强' : stance === 'bearish' ? '短线偏弱' : '多空均衡'
  return {
    id: `j:${tradeDate}:industry:${hash(aggregate.industry)}`,
    scopeKey: `industry:${aggregate.industry}`,
    stance,
    confidence: confidenceOf(score, aggregate.members, related.length),
    score,
    headline: `${aggregate.industry}${label}`,
    summary: `${aggregate.members} 只成分股，上涨 ${aggregate.upCount} / 下跌 ${aggregate.downCount}，中位涨跌 ${aggregate.medianPct > 0 ? '+' : ''}${aggregate.medianPct}%。${leaderText}${eventText}。`,
    drivers: [
      `上涨家数占比 ${aggregate.breadth}%`,
      `成分股平均涨跌 ${aggregate.avgPct > 0 ? '+' : ''}${aggregate.avgPct}%`,
      aggregate.momentum5d != null ? `5 日动量 ${aggregate.momentum5d > 0 ? '+' : ''}${aggregate.momentum5d}%` : '5 日动量样本不足',
    ],
    risks: [
      aggregate.breadth < 50 && aggregate.avgPct > 0 ? '平均涨幅为正但多数个股下跌，上涨集中' : '',
      aggregate.momentum5d != null && aggregate.momentum5d < 0 ? '5 日动量为负，短线趋势尚未修复' : '',
      related.some((event) => event.impact === 'negative') ? '存在偏负面公告/政策，需要核查原文' : '',
    ].filter(Boolean),
    evidence,
  }
}

interface MarketInputs {
  breadth: { up: number; flat: number; down: number; limitUp: number; limitDown: number; available: boolean }
  turnover: { value: number; changePct: number | null }
  indexChange: number | null
  overseasChange: number | null
  overseas: Array<{ symbol: string; price: number; previousClose?: number; changePct?: number; tradeTime: string; sourceId: string; delayMinutes?: number; fetchedAt: string }>
}

async function loadMarketInputs(tradeDate: string): Promise<MarketInputs> {
  const db = await getDb()
  const [overviewRes, indexRes, overseasRes] = await Promise.all([
    db.execute({ sql: 'SELECT * FROM market_overview WHERE trade_date = ?', args: [tradeDate] }),
    db.execute({
      sql: `SELECT code, trade_date, close FROM market_bars
            WHERE adjust_type = 'raw' AND code IN (${INDEX_CODES.map(() => '?').join(',')})
              AND trade_date <= ? AND trade_date >= date(?, '-30 days')
            ORDER BY code, trade_date DESC`,
      args: [...INDEX_CODES, tradeDate, tradeDate],
    }),
    db.execute({
      // 每个 symbol 先取最新一行再截断；先 LIMIT 会让历史累积后排在末尾的指数整段消失。
      sql: `SELECT * FROM (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY trade_time DESC) AS rn
              FROM overseas_quotes
            ) WHERE rn = 1`,
      args: [],
    }),
  ])

  const row = overviewRes.rows[0] as unknown as Row | undefined
  const breadthRaw = parseJson<Record<string, unknown>>(row?.breadth_json, {})
  const turnoverRaw = parseJson<Record<string, unknown>>(row?.turnover_json, {})
  const breadth = {
    up: num(breadthRaw.up),
    flat: num(breadthRaw.flat),
    down: num(breadthRaw.down),
    limitUp: num(breadthRaw.limitUp),
    limitDown: num(breadthRaw.limitDown),
    available: breadthRaw.limitUpDownAvailable !== false && Boolean(row),
  }

  const byCode = new Map<string, Row[]>()
  for (const indexRow of indexRes.rows as unknown as Row[]) {
    const code = str(indexRow.code)
    const list = byCode.get(code) || []
    list.push(indexRow)
    byCode.set(code, list)
  }
  const indexChanges: number[] = []
  for (const list of byCode.values()) {
    if (list.length < 2) continue
    const close = num(list[0].close)
    const prev = num(list[1].close)
    if (prev > 0) indexChanges.push(((close - prev) / prev) * 100)
  }

  const seen = new Set<string>()
  const overseas = []
  for (const quoteRow of overseasRes.rows as unknown as Row[]) {
    const symbol = str(quoteRow.symbol)
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    overseas.push({
      symbol,
      price: num(quoteRow.price),
      previousClose: quoteRow.previous_close == null ? undefined : num(quoteRow.previous_close),
      changePct: quoteRow.change_pct == null ? undefined : num(quoteRow.change_pct),
      tradeTime: str(quoteRow.trade_time),
      sourceId: str(quoteRow.source_id),
      delayMinutes: quoteRow.delay_minutes == null ? undefined : num(quoteRow.delay_minutes),
      fetchedAt: str(quoteRow.fetched_at),
    })
  }

  return {
    breadth,
    turnover: { value: num(turnoverRaw.value), changePct: turnoverRaw.changePct == null ? null : num(turnoverRaw.changePct) },
    indexChange: indexChanges.length ? round2(mean(indexChanges)) : null,
    overseasChange: overseas.length ? round2(mean(overseas.filter((quote) => quote.changePct != null).map((quote) => quote.changePct as number))) : null,
    overseas,
  }
}

function marketJudgment(
  inputs: MarketInputs,
  tradeDate: string,
  sourceMap: Map<string, Row>,
): {
  id: string
  scopeKey: string
  stance: 'bullish' | 'neutral' | 'bearish'
  confidence: 'low' | 'medium' | 'high'
  score: number
  headline: string
  summary: string
  drivers: string[]
  risks: string[]
  evidence: DeskEvidence[]
} {
  const total = inputs.breadth.up + inputs.breadth.down
  const breadthPct = total > 0 ? (inputs.breadth.up / total) * 100 : 50
  const breadthScore = ((breadthPct - 50) / 50) * 35
  const limitScore = inputs.breadth.available
    ? clamp((inputs.breadth.limitUp - inputs.breadth.limitDown) * 0.35, -12, 12)
    : 0
  const indexScore = inputs.indexChange == null ? 0 : clamp(inputs.indexChange * 6, -30, 30)
  const overseasScore = inputs.overseasChange == null ? 0 : clamp(inputs.overseasChange * 3, -18, 18)
  const turnoverScore = inputs.turnover.changePct == null ? 0 : clamp(inputs.turnover.changePct * 0.2, -8, 8)
  const score = round2(clamp(breadthScore + limitScore + indexScore + overseasScore + turnoverScore, -100, 100))
  const stance = stanceOf(score)
  const sourceId = str(inputs.overseas[0]?.sourceId, 'tushare')
  const evidence: DeskEvidence[] = [
    {
      id: `mj:${tradeDate}:breadth`,
      kind: 'breadth',
      label: '全市场上涨/下跌',
      value: `${inputs.breadth.up} / ${inputs.breadth.down}（上涨占比 ${round2(breadthPct)}%）`,
      ...sourceEvidence('tushare', sourceMap, tradeDate, null),
    },
    {
      id: `mj:${tradeDate}:turnover`,
      kind: 'turnover',
      label: '两市成交额',
      value: inputs.turnover.value > 0 ? `${round2(inputs.turnover.value / 100_000_000)} 亿元` : '未取到',
      ...sourceEvidence('tushare', sourceMap, tradeDate, null),
    },
  ]
  if (inputs.indexChange != null) {
    evidence.push({
      id: `mj:${tradeDate}:index`,
      kind: 'index',
      label: '主要指数平均涨跌',
      value: `${inputs.indexChange > 0 ? '+' : ''}${inputs.indexChange}%`,
      ...sourceEvidence('tushare', sourceMap, tradeDate, null),
    })
  }
  if (inputs.overseasChange != null) {
    evidence.push({
      id: `mj:${tradeDate}:overseas`,
      kind: 'overseas',
      label: '外盘隔夜平均涨跌',
      value: `${inputs.overseasChange > 0 ? '+' : ''}${inputs.overseasChange}%（延迟行情）`,
      ...sourceEvidence(sourceId, sourceMap, inputs.overseas[0]?.tradeTime || tradeDate, inputs.overseas[0]?.delayMinutes ? inputs.overseas[0].delayMinutes * 60 : null),
    })
  }

  const label = stance === 'bullish' ? '风险偏好回升' : stance === 'bearish' ? '宽度转弱，防守优先' : '多空拉锯，等待方向'
  const indexText = inputs.indexChange == null ? '' : `指数平均 ${inputs.indexChange > 0 ? '+' : ''}${inputs.indexChange}%`
  const overseasText = inputs.overseasChange == null ? '' : `外盘平均 ${inputs.overseasChange > 0 ? '+' : ''}${inputs.overseasChange}%`
  return {
    id: `j:${tradeDate}:market`,
    scopeKey: 'market',
    stance,
    confidence: confidenceOf(score, total, 0),
    score,
    headline: `市场${label}`,
    summary: `上涨 ${inputs.breadth.up} 家 / 下跌 ${inputs.breadth.down} 家，上涨占比 ${round2(breadthPct)}%；${indexText}${indexText && overseasText ? '，' : ''}${overseasText}。确定性来自宽度与指数是否同向。`,
    drivers: [
      `上涨占比 ${round2(breadthPct)}%`,
      inputs.breadth.available ? `涨停 ${inputs.breadth.limitUp} / 跌停 ${inputs.breadth.limitDown}` : '涨跌停数据缺失',
      inputs.turnover.changePct == null ? '成交额变化不可用' : `成交额变化 ${inputs.turnover.changePct > 0 ? '+' : ''}${inputs.turnover.changePct}%`,
    ],
    risks: [
      inputs.indexChange != null && inputs.indexChange > 0 && breadthPct < 50 ? '指数上涨但多数个股下跌，可能存在权重拉抬' : '',
      inputs.overseasChange != null && inputs.overseasChange < -1 ? '外盘偏弱，开盘情绪可能承压' : '',
      !inputs.breadth.available ? '涨跌停数据未取到，广度结论置信度下调' : '',
    ].filter(Boolean),
    evidence,
  }
}

function alertSeverity(value: number): DeskSeverity {
  if (Math.abs(value) >= 5) return 'critical'
  if (Math.abs(value) >= 3) return 'important'
  return 'watch'
}

function buildAlerts(
  tradeDate: string,
  aggregates: IndustryDailyView[],
  judgments: Array<ReturnType<typeof industryJudgment> | ReturnType<typeof marketJudgment>>,
  market: ReturnType<typeof marketJudgment>,
  events: IndustryEventInput[],
  selectedIndustries: string[],
): Array<Record<string, unknown>> {
  const alerts: Array<Record<string, unknown>> = []
  const triggeredAt = new Date().toISOString()

  if (market.stance === 'bearish' && market.score <= -30) {
    alerts.push({
      id: `alert:${tradeDate}:market:${hash(market.id)}`,
      dedupeKey: `${tradeDate}|market|breadth-weak`,
      severity: market.score <= -50 ? 'critical' : 'important',
      category: 'market_breadth',
      title: '市场宽度转弱',
      summary: market.summary,
      whyNow: `市场判断分 ${market.score}，上涨占比与指数同步偏弱。`,
      evidence: market.evidence.slice(0, 3),
      judgmentId: market.id,
      triggeredAt,
    })
  }

  for (const aggregate of aggregates) {
    if (!selectedIndustries.includes(aggregate.industry)) continue
    const extremeMove = Math.abs(aggregate.avgPct) >= 3
    const extremeBreadth = aggregate.breadth >= 85 || aggregate.breadth <= 15
    if (!extremeMove && !extremeBreadth) continue
    const direction = aggregate.avgPct >= 0 ? '走强' : '走弱'
    const judgment = judgments.find((item) => item.scopeKey === `industry:${aggregate.industry}`)
    alerts.push({
      id: `alert:${tradeDate}:industry:${hash(aggregate.industry)}:${direction}`,
      dedupeKey: `${tradeDate}|industry|${aggregate.industry}|${direction}`,
      severity: alertSeverity(aggregate.avgPct),
      category: 'industry_move',
      industry: aggregate.industry,
      title: `${aggregate.industry}${direction}`,
      summary: `${aggregate.members} 只成分股平均 ${aggregate.avgPct > 0 ? '+' : ''}${aggregate.avgPct}%，上涨占比 ${aggregate.breadth}%。`,
      whyNow: extremeMove
        ? `成分股平均涨跌达到 ${aggregate.avgPct}%，超过 3% 观察阈值。`
        : `上涨/下跌家数占比达到 ${aggregate.breadth}%，接近单边。`,
      evidence: judgment?.evidence.slice(0, 3) || [],
      judgmentId: judgment?.id,
      triggeredAt,
    })
  }

  for (const event of events) {
    if (event.severity !== 'critical' && event.severity !== 'important') continue
    if (!selectedIndustries.includes(event.industry)) continue
    const judgment = judgments.find((item) => item.scopeKey === `industry:${event.industry}`)
    alerts.push({
      id: `alert:${tradeDate}:event:${hash(event.id)}`,
      dedupeKey: `${tradeDate}|event|${event.id}`,
      severity: event.severity,
      category: 'document',
      industry: event.industry,
      title: `公告/政策：${event.title}`,
      summary: event.summary || `${event.industry}出现需要核查的公告或政策。`,
      whyNow: `发布于 ${dateShanghai(event.publishedAt)} ${formatTime(event.publishedAt)}，影响标记为${event.impact === 'negative' ? '偏负面' : event.impact === 'positive' ? '偏正面' : '中性'}。`,
      evidence: [{
        id: `alert-evidence:${event.id}`,
        kind: 'document',
        label: event.title,
        value: event.impact,
        sourceId: event.sourceId || undefined,
        documentId: event.documentId,
        asOf: event.publishedAt,
      }],
      judgmentId: judgment?.id,
      triggeredAt,
    })
  }

  return alerts.slice(0, MAX_ALERTS)
}

export async function refreshDesk(options: {
  tradeDate?: string
  onProgress?: (progress: number, step: string) => Promise<void> | void
  fetchImpl?: typeof fetch
} = {}): Promise<DeskRefreshResult> {
  const db = await getDb()
  const warnings: string[] = []
  await options.onProgress?.(8, '读取行情并聚合行业')
  const tradeDate = await resolveTradeDate(options.tradeDate)
  const industryData = await buildIndustryData(tradeDate)
  if (industryData.aggregates.length === 0) {
    throw new Error(`${tradeDate} 没有可聚合的行业行情；先确认 symbols.industry_l1 与日线已入库`)
  }

  await options.onProgress?.(25, '拉取外盘延迟行情')
  let overseasCount = 0
  try {
    const overseas = await refreshOverseasQuotes({ fetchImpl: options.fetchImpl })
    overseasCount = overseas.written
    warnings.push(...overseas.warnings)
  } catch (err) {
    warnings.push(`外盘行情未更新：${err instanceof Error ? err.message : String(err)}`)
  }

  const marketInputs = await loadMarketInputs(tradeDate)
  const market = marketJudgment(marketInputs, tradeDate, industryData.sourceMap)

  const ranked = [...industryData.aggregates].sort((a, b) => {
    const aPersonal = industryData.personalIndustries.has(a.industry) ? 1 : 0
    const bPersonal = industryData.personalIndustries.has(b.industry) ? 1 : 0
    if (aPersonal !== bPersonal) return bPersonal - aPersonal
    return Math.abs(judgmentScore(b)) - Math.abs(judgmentScore(a))
  })
  const alertIndustries = ranked.slice(0, MAX_ALERT_INDUSTRIES).map((row) => row.industry)
  const judgments = ranked.map((aggregate) =>
    industryJudgment(aggregate, industryData.events, industryData.sourceMap, tradeDate),
  )
  const allJudgments = [market, ...judgments]
  const alerts = buildAlerts(tradeDate, industryData.aggregates, judgments, market, industryData.events, alertIndustries)
  const isDemo = industryData.aggregates.some((row) => row.isDemo) || industryData.events.some((event) => event.isDemo)

  await options.onProgress?.(55, '写入行业聚合与公告')
  const tx = await db.transaction('write')
  try {
    for (const aggregate of industryData.aggregates) {
      await tx.execute({
        sql: `INSERT INTO industry_daily
          (trade_date, industry, members, up_count, down_count, flat_count, limit_up_count,
           limit_down_count, avg_pct, median_pct, breadth, turnover, turnover_change_pct,
           amount, momentum_5d, momentum_20d, leader_code, leader_name, leader_pct,
           source_id, computed_at, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(trade_date, industry) DO UPDATE SET
            members = excluded.members, up_count = excluded.up_count, down_count = excluded.down_count,
            flat_count = excluded.flat_count, limit_up_count = excluded.limit_up_count,
            limit_down_count = excluded.limit_down_count, avg_pct = excluded.avg_pct,
            median_pct = excluded.median_pct, breadth = excluded.breadth, turnover = excluded.turnover,
            turnover_change_pct = excluded.turnover_change_pct, amount = excluded.amount,
            momentum_5d = excluded.momentum_5d, momentum_20d = excluded.momentum_20d,
            leader_code = excluded.leader_code, leader_name = excluded.leader_name,
            leader_pct = excluded.leader_pct, source_id = excluded.source_id,
            computed_at = excluded.computed_at, is_demo = excluded.is_demo`,
        args: [
          aggregate.tradeDate, aggregate.industry, aggregate.members, aggregate.upCount,
          aggregate.downCount, aggregate.flatCount, aggregate.limitUpCount, aggregate.limitDownCount,
          aggregate.avgPct, aggregate.medianPct, aggregate.breadth, aggregate.turnover,
          aggregate.turnoverChangePct, aggregate.turnover, aggregate.momentum5d, aggregate.momentum20d,
          aggregate.leaderCode || null, aggregate.leaderName || null, aggregate.leaderPct ?? null,
          aggregate.sourceId, new Date().toISOString(), aggregate.isDemo ? 1 : 0,
        ],
      })
    }

    for (const event of industryData.events) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO industry_events
          (id, trade_date, industry, event_type, source_id, source_ref, title, summary,
           impact, severity, published_at, metadata_json, is_demo, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          event.id, event.tradeDate, event.industry, event.eventType, event.sourceId,
          event.sourceRef, event.title, event.summary, event.impact, event.severity,
          event.publishedAt, JSON.stringify({ documentId: event.documentId }), event.isDemo ? 1 : 0,
          new Date().toISOString(),
        ],
      })
    }

    const activeScopeKeys = judgments.map((judgment) => judgment.scopeKey)
    await tx.execute({
      sql: `UPDATE judgments SET status = 'superseded'
            WHERE trade_date = ? AND kind = 'industry' AND status = 'open'
              AND scope_key NOT IN (${activeScopeKeys.map(() => '?').join(',') || "''"})`,
      args: [tradeDate, ...activeScopeKeys],
    })

    const now = new Date().toISOString()
    const sourceByIndustry = new Map(industryData.aggregates.map((row) => [row.industry, row.sourceId]))
    for (const judgment of allJudgments) {
      const industry = 'scopeKey' in judgment && judgment.scopeKey.startsWith('industry:')
        ? judgment.scopeKey.slice('industry:'.length)
        : null
      await tx.execute({
        sql: `INSERT INTO judgments
          (id, trade_date, kind, scope_key, industry, stance, confidence, score, headline, summary,
           drivers_json, risks_json, review_at, status, version, source_id, computed_at, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?)
          ON CONFLICT(trade_date, scope_key, version) DO UPDATE SET
            stance = excluded.stance, confidence = excluded.confidence, score = excluded.score,
            headline = excluded.headline, summary = excluded.summary,
            drivers_json = excluded.drivers_json, risks_json = excluded.risks_json,
            review_at = excluded.review_at, status = 'open', source_id = excluded.source_id,
            computed_at = excluded.computed_at, is_demo = excluded.is_demo`,
        args: [
          judgment.id, tradeDate, industry ? 'industry' : 'market', judgment.scopeKey, industry,
          judgment.stance, judgment.confidence, judgment.score, judgment.headline, judgment.summary,
          JSON.stringify(judgment.drivers), JSON.stringify(judgment.risks),
          addDays(tradeDate, 1), industry ? sourceByIndustry.get(industry) || null : 'tushare',
          now, isDemo ? 1 : 0,
        ],
      })
      await tx.execute({ sql: 'DELETE FROM judgment_evidence WHERE judgment_id = ?', args: [judgment.id] })
      for (const item of judgment.evidence) {
        await tx.execute({
          sql: `INSERT INTO judgment_evidence
            (id, judgment_id, kind, label, value, source_id, source_ref, document_id, as_of,
             freshness_seconds, is_citation, created_at)
            VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
          args: [
            item.id, judgment.id, item.kind, item.label, item.value || null, item.sourceId || null,
            item.documentId || null, item.asOf || null, item.freshnessSeconds ?? null, now,
          ],
        })
      }
    }

    for (const alert of alerts) {
      await tx.execute({
        sql: `INSERT OR IGNORE INTO alerts
          (id, trade_date, dedupe_key, severity, category, industry, symbol_code, title, summary,
           why_now, evidence_json, judgment_id, status, triggered_at, expires_at, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
        args: [
          alert.id, tradeDate, alert.dedupeKey, alert.severity, alert.category,
          alert.industry || null, alert.title, alert.summary, alert.whyNow,
          JSON.stringify(alert.evidence), alert.judgmentId || null, alert.triggeredAt,
          addDays(tradeDate, 7), isDemo ? 1 : 0,
        ],
      })
    }

    await tx.execute({
      sql: `UPDATE alerts SET status = 'expired'
            WHERE status = 'open' AND trade_date < date(?, '-5 days')`,
      args: [tradeDate],
    })
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }

  await options.onProgress?.(80, '评估历史判断')
  const evaluations = await evaluateJudgments(tradeDate).catch((err) => {
    warnings.push(`判断评估未完成：${err instanceof Error ? err.message : String(err)}`)
    return 0
  })
  await options.onProgress?.(95, '汇总快照')

  return {
    tradeDate,
    industries: industryData.aggregates.length,
    judgments: allJudgments.length,
    alerts: alerts.length,
    events: industryData.events.length,
    evaluations,
    overseas: overseasCount,
    warnings,
    isDemo,
  }
}

/** 用行业日聚合给历史判断打分，只写一次；不改变判断原文。 */
async function evaluateJudgments(tradeDate: string): Promise<number> {
  const db = await getDb()
  const datesRes = await db.execute({
    sql: 'SELECT DISTINCT trade_date FROM industry_daily WHERE trade_date <= ? ORDER BY trade_date ASC',
    args: [tradeDate],
  })
  const dates = (datesRes.rows as unknown as Row[]).map((row) => str(row.trade_date)).filter(Boolean)
  const indexByDate = new Map(dates.map((date, index) => [date, index]))
  // 只回看最近 90 个交易日：更早的判断早已评估完，全历史逐条查询会拖慢每次刷新。
  const cutoff = dates[Math.max(0, dates.length - 90)] || tradeDate
  const [priorRes, doneRes] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM judgments
            WHERE trade_date < ? AND trade_date >= ?
              AND kind = 'industry' AND stance IN ('bullish','bearish','neutral')
            ORDER BY trade_date ASC`,
      args: [tradeDate, cutoff],
    }),
    db.execute({
      sql: 'SELECT judgment_id, horizon_days FROM judgment_evaluations',
      args: [],
    }),
  ])
  const done = new Set(
    (doneRes.rows as unknown as Row[]).map((row) => `${str(row.judgment_id)}:${num(row.horizon_days)}`),
  )
  let written = 0
  for (const row of priorRes.rows as unknown as Row[]) {
    const judgmentDate = str(row.trade_date)
    const industry = str(row.industry)
    const startIndex = indexByDate.get(judgmentDate)
    if (startIndex == null || !industry) continue
    const judgmentId = str(row.id)
    const stance = str(row.stance)
    for (const horizon of [1, 5, 20]) {
      const endIndex = startIndex + horizon
      if (endIndex >= dates.length) break
      if (done.has(`${judgmentId}:${horizon}`)) continue
      const pathDates = dates.slice(startIndex + 1, endIndex + 1)
      const perDateRes = await db.execute({
        sql: `SELECT trade_date, avg_pct FROM industry_daily
              WHERE industry = ? AND trade_date IN (${pathDates.map(() => '?').join(',')})`,
        args: [industry, ...pathDates],
      })
      const values = new Map((perDateRes.rows as unknown as Row[]).map((item) => [str(item.trade_date), num(item.avg_pct)]))
      if (values.size !== pathDates.length) continue
      const returnPct = round2(pathDates.reduce((sum, date) => sum + (values.get(date) || 0), 0))
      const hit = stance === 'bullish' ? returnPct > 0 : stance === 'bearish' ? returnPct < 0 : Math.abs(returnPct) <= 1.5
      const result = await db.execute({
        sql: `INSERT OR IGNORE INTO judgment_evaluations
          (judgment_id, eval_date, horizon_days, hit, return_pct, benchmark_pct, note, created_at)
          VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        args: [
          judgmentId, dates[endIndex], horizon, hit ? 1 : 0, returnPct,
          stance === 'neutral' ? '中性判断以 ±1.5% 内为命中' : null, new Date().toISOString(),
        ],
      })
      written += Number(result.rowsAffected || 0)
    }
  }
  return written
}
