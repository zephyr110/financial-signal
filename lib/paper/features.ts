import { getDb } from '../db'
import { averageDailyTurnoverCents, resolveBoard } from './market'
import {
  evaluateMarketGate,
  type CardCandidateFeatures,
  type CardEvidence,
  type MarketGateResult,
} from './cards'
import type { DataQuality, MarketStatus, PaperBoard, PaperPolicy, SymbolMeta } from './types'

/**
 * 决策卡特征：只从本地日线、元数据与市场概览推导，不读新闻或 LLM 结论。
 * 同一交易日重跑必须得到同一组特征，因此所有窗口都按 trade_date 固定。
 */

interface BarRow {
  tradeDate: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  amount: number
}

interface SymbolStats {
  bars: BarRow[]
  lastCloseCents: number | null
  lastBarDate: string | null
  ma20Cents: number | null
  ma60Cents: number | null
  atr20Cents: number | null
  volumeRatio5d20d: number | null
  adv20Cents: number | null
  listedTradingDays: number | null
}

interface IndustryStats {
  count: number
  aboveMa20: number
}

export interface PaperFeatureBundle {
  tradeDate: string
  gate: MarketGateResult
  gateFacts: {
    indexCode: string
    indexAboveMa20: boolean | null
    indexAboveMa60: boolean | null
    breadthUpPct: number | null
    turnoverRatio: number | null
  }
  features: CardCandidateFeatures[]
  warnings: string[]
  quality: DataQuality
}

export interface HeldPositionInput {
  symbolCode: string
  totalQty: number
  /** 最近一次已成交买入卡的止损价；没有止损记录的持仓不推断证伪。 */
  stopPriceCents?: number | null
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

function avg(values: number[]): number | null {
  if (!values.length) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function normalizeBar(row: Record<string, unknown>): BarRow | null {
  const close = Number(row.close)
  const open = Number(row.open)
  const high = Number(row.high)
  const low = Number(row.low)
  if (![close, open, high, low].every((v) => Number.isFinite(v) && v > 0)) return null
  const volume = Number(row.volume)
  const amount = Number(row.amount)
  return {
    tradeDate: String(row.trade_date),
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : 0,
    amount: Number.isFinite(amount) ? amount : 0,
  }
}

function computeStats(barsDesc: BarRow[], listedTradingDays: number | null): SymbolStats {
  const closes = barsDesc.map((bar) => Math.round(bar.close * 100))
  const ma20 = avg(closes.slice(0, 20))
  const ma60 = avg(closes.slice(0, 60))
  let atr20: number | null = null
  if (barsDesc.length >= 21) {
    const ranges: number[] = []
    for (let i = 0; i < 20; i += 1) {
      const bar = barsDesc[i]
      const prevClose = barsDesc[i + 1].close
      const high = bar.high
      const low = bar.low
      ranges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
    }
    const ratio = avg(ranges)
    atr20 = ratio == null ? null : Math.round(ratio * 100)
  }
  const vol5 = avg(barsDesc.slice(0, 5).map((bar) => bar.volume).filter((v) => v > 0))
  const vol20 = avg(barsDesc.slice(0, 20).map((bar) => bar.volume).filter((v) => v > 0))
  const volumeRatio = vol5 != null && vol20 != null && vol20 > 0 ? vol5 / vol20 : null
  const dailyBars = barsDesc.map((bar) => ({
    symbolCode: '',
    tradeDate: bar.tradeDate,
    openCents: 0,
    closeCents: Math.round(bar.close * 100),
    prevCloseCents: null,
    amountCents: Math.round(bar.amount * 100),
  }))
  return {
    bars: barsDesc,
    lastCloseCents: closes.length ? closes[0] : null,
    lastBarDate: barsDesc.length ? barsDesc[0].tradeDate : null,
    ma20Cents: ma20 == null ? null : Math.round(ma20),
    ma60Cents: ma60 == null ? null : Math.round(ma60),
    atr20Cents: atr20,
    volumeRatio5d20d: volumeRatio,
    adv20Cents: averageDailyTurnoverCents(dailyBars, 20),
    listedTradingDays,
  }
}

async function loadStats(symbolCode: string, tradeDate: string): Promise<SymbolStats> {
  const db = await getDb()
  const [barsR, countR] = await Promise.all([
    db.execute({
      sql: `SELECT trade_date, open, high, low, close, volume, amount
            FROM market_bars
            WHERE code = ? AND trade_date <= ? AND adjust_type = 'raw'
            ORDER BY trade_date DESC LIMIT 61`,
      args: [symbolCode, tradeDate],
    }),
    db.execute({
      sql: `SELECT COUNT(DISTINCT trade_date) AS n FROM market_bars
            WHERE code = ? AND trade_date <= ? AND adjust_type = 'raw'`,
      args: [symbolCode, tradeDate],
    }),
  ])
  const bars = barsR.rows
    .map((row) => normalizeBar(row as Record<string, unknown>))
    .filter((bar): bar is BarRow => bar !== null)
  return computeStats(bars, Number(countR.rows[0]?.n) || 0)
}

async function loadMeta(symbolCode: string, tradeDate: string): Promise<SymbolMeta | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT * FROM paper_symbol_meta
          WHERE symbol_code = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
          ORDER BY valid_from DESC LIMIT 1`,
    args: [symbolCode, tradeDate, tradeDate],
  })
  if (!r.rows.length) return null
  const row = r.rows[0]
  return {
    symbolCode: String(row.symbol_code),
    name: String(row.name),
    exchange: String(row.exchange) as SymbolMeta['exchange'],
    board: String(row.board) as PaperBoard,
    industryCode: row.industry_code == null ? null : String(row.industry_code),
    industryName: row.industry_name == null ? null : String(row.industry_name),
    isSt: Number(row.is_st) === 1,
    lotSize: Number(row.lot_size),
    limitPctBp: row.limit_pct_bp == null ? null : Number(row.limit_pct_bp),
    noPriceLimit: Number(row.no_price_limit) === 1,
    listDate: row.listed_at == null ? null : String(row.listed_at),
    delistDate: row.delisted_at == null ? null : String(row.delisted_at),
    sourceId: String(row.source_id),
    validFrom: String(row.valid_from),
    validTo: row.valid_to == null ? null : String(row.valid_to),
  }
}

async function loadStatus(symbolCode: string, tradeDate: string): Promise<MarketStatus | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT * FROM paper_market_status_daily WHERE symbol_code = ? AND trade_date = ?',
    args: [symbolCode, tradeDate],
  })
  if (!r.rows.length) return null
  const row = r.rows[0]
  return {
    symbolCode: String(row.symbol_code),
    tradeDate: String(row.trade_date),
    isSuspended: Number(row.is_suspended) === 1,
    isSt: Number(row.is_st) === 1,
    source: String(row.status_source),
  }
}

async function loadBenchmarkBars(benchmarkCode: string, tradeDate: string): Promise<{ code: string; bars: BarRow[] }> {
  const db = await getDb()
  const codes = [benchmarkCode, '000001.SH', '399001.SZ']
  for (const code of codes) {
    if (!code) continue
    const r = await db.execute({
      sql: `SELECT trade_date, open, high, low, close, volume, amount
            FROM market_bars
            WHERE code = ? AND trade_date <= ? AND adjust_type = 'raw'
            ORDER BY trade_date DESC LIMIT 61`,
      args: [code, tradeDate],
    })
    if (r.rows.length) {
      return {
        code,
        bars: r.rows
          .map((row) => normalizeBar(row as Record<string, unknown>))
          .filter((bar): bar is BarRow => bar !== null),
      }
    }
  }
  return { code: benchmarkCode, bars: [] }
}

async function loadBreadth(tradeDate: string): Promise<number | null> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'SELECT breadth_json FROM market_overview WHERE trade_date = ?',
    args: [tradeDate],
  })
  if (!r.rows.length) return null
  const breadth = parseJson<{ up?: number; flat?: number; down?: number }>(r.rows[0].breadth_json, {})
  const total = (breadth.up ?? 0) + (breadth.flat ?? 0) + (breadth.down ?? 0)
  return total > 0 ? (breadth.up ?? 0) / total : null
}

export async function loadPaperMarketGate(input: {
  tradeDate: string
  benchmarkCode: string
  policy: PaperPolicy
}): Promise<{ gate: MarketGateResult; facts: PaperFeatureBundle['gateFacts']; quality: DataQuality }> {
  const { code, bars } = await loadBenchmarkBars(input.benchmarkCode, input.tradeDate)
  const closes = bars.map((bar) => Math.round(bar.close * 100))
  const ma20 = avg(closes.slice(0, 20))
  const ma60 = avg(closes.slice(0, 60))
  const latestClose = closes.length ? closes[0] : null
  const indexAboveMa20 = latestClose != null && ma20 != null && closes.length >= 20
    ? latestClose >= ma20
    : null
  const indexAboveMa60 = latestClose != null && ma60 != null && closes.length >= 60
    ? latestClose >= ma60
    : null
  const prevAmounts = bars.slice(1, 21).map((bar) => bar.amount).filter((value) => value > 0)
  const avgAmount = avg(prevAmounts)
  const turnoverRatio = bars.length >= 21 && avgAmount != null && avgAmount > 0
    ? bars[0].amount / avgAmount
    : null
  const breadthUpPct = await loadBreadth(input.tradeDate)
  const facts: PaperFeatureBundle['gateFacts'] = {
    indexCode: code,
    indexAboveMa20,
    indexAboveMa60,
    breadthUpPct,
    turnoverRatio,
  }
  const gate = evaluateMarketGate({
    indexAboveMa20,
    indexAboveMa60,
    breadthUpPct,
    turnoverRatio,
  }, input.policy)
  const quality: DataQuality = indexAboveMa20 === null || breadthUpPct === null || turnoverRatio === null
    ? 'warn'
    : 'pass'
  return { gate, facts, quality }
}

function evidenceFor(input: {
  meta: SymbolMeta | null
  stats: SymbolStats
  industry: IndustryStats | null
  held: boolean
  invalidationHit: boolean
}): {
  evidence: CardEvidence[]
  counter: CardEvidence[]
  industryStrength: number
  counterStrength: number
  invalidation: string
} {
  const { meta, stats, industry, held, invalidationHit } = input
  const evidence: CardEvidence[] = []
  const lastClose = stats.lastCloseCents
  const ma20 = stats.ma20Cents

  const industryName = meta?.industryName ?? '未分类'
  const industryStrength = industry && industry.count >= 2
    ? industry.aboveMa20 / industry.count
    : lastClose != null && ma20 != null && lastClose >= ma20 ? 1 : 0
  evidence.push({
    kind: 'industry',
    text: industry && industry.count >= 2
      ? `行业「${industryName}」内 ${Math.round(industryStrength * 100)}% 的样本站上 20 日线（${industry.aboveMa20}/${industry.count}）`
      : `行业「${industryName}」样本不足，按个股自身趋势近似：${industryStrength >= 1 ? '站上' : '低于'} 20 日线`,
    value: Number(industryStrength.toFixed(3)),
  })

  if (lastClose != null && ma20 != null) {
    const diffPct = (lastClose - ma20) / ma20 * 100
    evidence.push({
      kind: 'price',
      text: `收盘 ${yuan(lastClose)} 元，${lastClose >= ma20 ? '高于' : '低于'} 20 日线 ${Math.abs(diffPct).toFixed(2)}%`,
      value: Number(diffPct.toFixed(2)),
    })
  }
  if (stats.volumeRatio5d20d != null) {
    evidence.push({
      kind: 'volume',
      text: `5 日量能为 20 日均值的 ${stats.volumeRatio5d20d.toFixed(2)} 倍`,
      value: Number(stats.volumeRatio5d20d.toFixed(3)),
    })
  }
  if (stats.adv20Cents != null) {
    const atrPct = stats.atr20Cents != null && lastClose
      ? stats.atr20Cents / lastClose * 100
      : null
    evidence.push({
      kind: 'risk',
      text: `20 日日均成交额 ${(stats.adv20Cents / 100 / 10_000).toFixed(0)} 万元${atrPct == null ? '' : `，ATR20 占收盘价 ${atrPct.toFixed(2)}%`}`,
      value: Number((stats.adv20Cents / 100 / 10_000).toFixed(0)),
    })
  }

  let counterText = '单日行情可能受大盘波动影响，需按证伪条件复核'
  let counterStrength = 0.2
  const atrPct = stats.atr20Cents != null && lastClose ? stats.atr20Cents / lastClose : null
  if (lastClose != null && ma20 != null && lastClose < ma20) {
    counterText = '收盘仍在 20 日线下方，趋势尚未确认'
    counterStrength = 0.8
  } else if (stats.volumeRatio5d20d != null && stats.volumeRatio5d20d < 1) {
    counterText = '量能低于 20 日均值，突破可能乏力'
    counterStrength = 0.5
  } else if (atrPct != null && atrPct >= 0.04) {
    counterText = `ATR20 占收盘价 ${(atrPct * 100).toFixed(2)}%，波动偏大`
    counterStrength = 0.5
  }
  if (held && invalidationHit) {
    counterText = '持仓已触及最近的数字止损或风险状态，优先考虑退出'
    counterStrength = 1
  }
  const counter: CardEvidence[] = [{
    kind: 'counter',
    text: counterText,
    value: Number(counterStrength.toFixed(2)),
  }]

  const invalidation = held
    ? '收盘跌破最近一次买入卡的止损价，或标的变为 ST/停牌'
    : `收盘跌破 20 日线（${ma20 == null ? '不可用' : yuan(ma20)} 元）且行业强度连续 3 日低于 30%`
  return { evidence, counter, industryStrength, counterStrength, invalidation }
}

/** 一次装载全宇宙特征；行业强度按同一批标的统计，避免每只票各算一套。 */
export async function loadPaperFeatureBundle(input: {
  tradeDate: string
  benchmarkCode: string
  symbols: string[]
  positions: HeldPositionInput[]
  policy: PaperPolicy
}): Promise<PaperFeatureBundle> {
  const warnings: string[] = []
  const unique = [...new Set(input.symbols)]
  const heldBySymbol = new Map(input.positions.map((p) => [p.symbolCode, p]))
  const { gate, facts, quality: gateQuality } = await loadPaperMarketGate({
    tradeDate: input.tradeDate,
    benchmarkCode: input.benchmarkCode,
    policy: input.policy,
  })

  const base: Array<{
    symbolCode: string
    meta: SymbolMeta | null
    status: MarketStatus | null
    stats: SymbolStats
  }> = []
  for (const symbolCode of unique) {
    const [meta, status, stats] = await Promise.all([
      loadMeta(symbolCode, input.tradeDate),
      loadStatus(symbolCode, input.tradeDate),
      loadStats(symbolCode, input.tradeDate),
    ])
    if (!stats.bars.length) {
      warnings.push(`${symbolCode} 缺少日线，跳过`)
      continue
    }
    if (!meta) warnings.push(`${symbolCode} 缺少标的元数据，卡将降级为观察`)
    base.push({ symbolCode, meta, status, stats })
  }

  const industryMap = new Map<string, IndustryStats>()
  for (const item of base) {
    const key = item.meta?.industryName ?? '未分类'
    const current = industryMap.get(key) ?? { count: 0, aboveMa20: 0 }
    current.count += 1
    if (item.stats.lastCloseCents != null && item.stats.ma20Cents != null
      && item.stats.lastCloseCents >= item.stats.ma20Cents) {
      current.aboveMa20 += 1
    }
    industryMap.set(key, current)
  }

  const features: CardCandidateFeatures[] = []
  for (const item of base) {
    const held = heldBySymbol.get(item.symbolCode)
    const invalidationHit = Boolean(held?.stopPriceCents && item.stats.lastCloseCents
      && item.stats.lastCloseCents <= held.stopPriceCents)
    const evidencePack = evidenceFor({
      meta: item.meta,
      stats: item.stats,
      industry: industryMap.get(item.meta?.industryName ?? '未分类') ?? null,
      held: Boolean(held && held.totalQty > 0),
      invalidationHit,
    })
    const dataQuality: DataQuality = item.stats.lastBarDate !== input.tradeDate
      ? 'fail'
      : item.meta
        ? 'pass'
        : 'warn'
    features.push({
      symbolCode: item.symbolCode,
      name: item.meta?.name ?? item.symbolCode,
      industryCode: item.meta?.industryCode ?? null,
      industryName: item.meta?.industryName ?? null,
      horizon: 'short',
      board: item.meta?.board ?? resolveBoard(item.symbolCode),
      meta: item.meta,
      status: item.status,
      lastCloseCents: item.stats.lastCloseCents,
      ma20Cents: item.stats.ma20Cents,
      ma60Cents: item.stats.ma60Cents,
      atr20Cents: item.stats.atr20Cents,
      volumeRatio5d20d: item.stats.volumeRatio5d20d,
      adv20Cents: item.stats.adv20Cents,
      listedTradingDays: item.stats.listedTradingDays,
      policyEventStrength: 0,
      industryStrength: evidencePack.industryStrength,
      counterEvidenceStrength: evidencePack.counterStrength,
      evidence: [...evidencePack.evidence, ...evidencePack.counter],
      invalidation: evidencePack.invalidation,
      isHeld: Boolean(held && held.totalQty > 0),
      heldQty: held?.totalQty ?? 0,
      invalidationHit,
      dataQuality,
    })
  }

  const quality: DataQuality = features.some((f) => f.dataQuality === 'fail')
    ? 'fail'
    : gateQuality === 'warn' || features.some((f) => f.dataQuality === 'warn')
      ? 'warn'
      : 'pass'
  return { tradeDate: input.tradeDate, gate, gateFacts: facts, features, warnings, quality }
}
