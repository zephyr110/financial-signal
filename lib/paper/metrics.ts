import { dateShanghai, todayShanghai } from '../cockpit/format'
import { getDb } from '../db'
import {
  getPaperExperiment,
  getPaperExperimentPolicy,
  listPaperAccounts,
  PaperRepoError,
  type PaperExperimentRow,
} from './repo'
import type { PaperPolicy } from './types'

/**
 * 实验指标：净值/基准/回撤/费用/执行率与结果 cohort。
 * 统计纪律：不足 120 个有效交易日、最后一张卡不满 60 日或触发卡不足 30 张时，
 * 只返回计数，不返回命中率与 alpha 百分比。
 */

type Row = Record<string, unknown>

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function dayOf(iso: string | null): string {
  return iso ? iso.slice(0, 10) : ''
}

export interface PaperAccountMetrics {
  kind: 'user' | 'shadow'
  startDate: string | null
  endDate: string | null
  validDays: number
  startEquityCents: number | null
  endEquityCents: number | null
  returnBp: number | null
  annualizedReturnBp: number | null
  maxDrawdownBp: number | null
  sharpe: number | null
  sortino: number | null
  averageEquityCents: number | null
  totalFeesCents: number
  feesDragBp: number | null
  feesDragAnnualizedBp: number | null
  turnoverAnnualizedBp: number | null
  fillCount: number
  buyAmountCents: number
  sellAmountCents: number
}

export interface PaperBenchmarkMetrics {
  code: string
  /** total_return_index 才是全收益；price_index 不得冒充，估算口径会写进 note。 */
  basis: 'total_return_index' | 'price_index' | 'unavailable'
  startDate: string | null
  endDate: string | null
  startCloseCents: number | null
  endCloseCents: number | null
  returnBp: number | null
}

export interface PaperEqualWeightMetrics {
  symbols: number
  method: 'monthly_equal_weight' | 'insufficient_data'
  returnBp: number | null
  turnoverCostBp: number | null
  months: number
  note: string
}

export interface PaperExecutionMetrics {
  triggeredCards: number
  confirmedCards: number
  filledCards: number
  executionRateBp: number | null
  deviations: Array<{ reason: string; count: number }>
}

export interface PaperOutcomeHorizon {
  horizonDays: 5 | 20 | 60
  matured: number
  hitCount: number
  averageAlphaBp: number | null
  hitRateBp: number | null
}

export interface PaperOutcomeCohort {
  cohort: 'all' | 'triggered' | 'executed'
  cards: number
  matured: number
  hitRateBp: number | null
  averageAlphaBp: number | null
  horizons: PaperOutcomeHorizon[]
}

export interface PaperMetricsReport {
  experimentId: string
  asOf: string
  sample: {
    validDays: number
    triggeredCards: number
    lastCardTradeDate: string | null
    lastCardMature60: boolean
    sufficientForDescriptive: boolean
    sufficientForSignificance: boolean
    rules: string
  }
  accounts: { user: PaperAccountMetrics; shadow: PaperAccountMetrics }
  benchmark: PaperBenchmarkMetrics
  equalWeightUniverse: PaperEqualWeightMetrics
  excessBp: { user: number | null; shadow: number | null }
  execution: PaperExecutionMetrics
  outcomes: PaperOutcomeCohort[]
  calibration: {
    status: 'uncalibrated' | 'calibrated' | 'unavailable'
    brier: number | null
    eligible: boolean
    note: string
  }
  notes: string[]
}

const DESCRIPTIVE_MIN_DAYS = 120
const SIGNIFICANCE_MIN_DAYS = 250
const DESCRIPTIVE_MIN_TRIGGERED = 30
const SIGNIFICANCE_MIN_TRIGGERED = 100
const ANNUALIZE_DAYS = 252

function ratioBp(numerator: number, denominator: number): number | null {
  if (!denominator) return null
  return Math.round(numerator * 10_000 / denominator)
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null
}

function stdev(values: number[]): number | null {
  if (values.length < 2) return null
  const avg = mean(values) as number
  const variance = values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (values.length - 1)
  return Math.sqrt(variance)
}

function maxDrawdownBp(equities: number[]): number | null {
  if (!equities.length) return null
  let peak = equities[0]
  let worst = 0
  for (const equity of equities) {
    peak = Math.max(peak, equity)
    if (peak > 0) worst = Math.max(worst, Math.round((peak - equity) * 10_000 / peak))
  }
  return worst
}

/** 配置的基准可能从未入库（默认 H00300 无数据源），统一回退到确实有行情的上证指数。 */
export async function resolvePaperBenchmarkCode(preferred: string, since?: string): Promise<string> {
  const db = await getDb()
  for (const code of [preferred, '000001.SH']) {
    if (!code) continue
    const r = await db.execute({
      sql: `SELECT 1 AS ok FROM market_bars
            WHERE code = ? AND adjust_type = 'raw'
            ${since ? 'AND trade_date >= ?' : ''} LIMIT 1`,
      args: since ? [code, 'raw', since] : [code, 'raw'],
    })
    if (r.rows.length) return code
  }
  return preferred
}

function benchmarkBasis(code: string): PaperBenchmarkMetrics['basis'] {
  if (!code) return 'unavailable'
  // 中证全收益指数以 H0 开头；其余代码按价格指数处理，避免把股息算成 alpha。
  return /^H0\d{4}$/i.test(code) ? 'total_return_index' : 'price_index'
}

async function loadBenchmark(
  experiment: PaperExperimentRow,
  startDate: string,
  endDate: string,
): Promise<PaperBenchmarkMetrics> {
  const db = await getDb()
  const candidates = [experiment.benchmarkCode, '000001.SH'].filter(Boolean)
  for (const code of candidates) {
    const r = await db.execute({
      sql: `SELECT trade_date, close FROM market_bars
            WHERE code = ? AND adjust_type = 'raw' AND trade_date >= ? AND trade_date <= ?
            ORDER BY trade_date`,
      args: [code, startDate, endDate],
    })
    if (r.rows.length < 2) continue
    const first = r.rows[0]
    const last = r.rows[r.rows.length - 1]
    const startCloseCents = Math.round(num(first.close) * 100) || null
    const endCloseCents = Math.round(num(last.close) * 100) || null
    return {
      code,
      basis: benchmarkBasis(code),
      startDate: str(first.trade_date),
      endDate: str(last.trade_date),
      startCloseCents,
      endCloseCents,
      returnBp: startCloseCents && endCloseCents
        ? Math.round((endCloseCents - startCloseCents) * 10_000 / startCloseCents)
        : null,
    }
  }
  return {
    code: experiment.benchmarkCode,
    basis: 'unavailable',
    startDate: null,
    endDate: null,
    startCloseCents: null,
    endCloseCents: null,
    returnBp: null,
  }
}

async function loadAccountMetrics(input: {
  accountId: string
  kind: 'user' | 'shadow'
  startDate: string
  endDate: string
}): Promise<PaperAccountMetrics> {
  const db = await getDb()
  const navR = await db.execute({
    sql: `SELECT trade_date, total_equity_cents, daily_return_bp
          FROM paper_nav WHERE account_id = ? AND trade_date >= ? AND trade_date <= ?
          ORDER BY trade_date`,
    args: [input.accountId, input.startDate, input.endDate],
  })
  const rows = navR.rows
  const equities = rows.map((row) => num(row.total_equity_cents))
  const startEquity = equities.length ? equities[0] : null
  const endEquity = equities.length ? equities[equities.length - 1] : null
  const returnBp = startEquity && endEquity
    ? Math.round((endEquity - startEquity) * 10_000 / startEquity)
    : null
  const dailyReturnsBp = rows.map((row, index) => {
    const stored = row.daily_return_bp == null ? null : num(row.daily_return_bp)
    if (stored != null) return stored / 10_000
    if (index === 0) return null
    const prev = equities[index - 1]
    return prev > 0 ? (equities[index] - prev) / prev : null
  }).filter((v): v is number => v != null)

  const validDays = rows.length
  const avgEquity = mean(equities)
  const dailyStd = stdev(dailyReturnsBp)
  const downside = dailyReturnsBp.filter((v) => v < 0)
  const downsideStd = stdev(downside)
  const annualize = (bp: number | null): number | null => (
    bp == null || validDays < ANNUALIZE_DAYS ? null : Math.round(bp * ANNUALIZE_DAYS / validDays)
  )

  const fillR = await db.execute({
    sql: `SELECT
            COUNT(*) AS n,
            COALESCE(SUM(total_fees_cents), 0) AS fees,
            COALESCE(SUM(CASE WHEN side = 'buy' THEN gross_cents ELSE 0 END), 0) AS buys,
            COALESCE(SUM(CASE WHEN side = 'sell' THEN gross_cents ELSE 0 END), 0) AS sells
          FROM paper_fills
          WHERE account_id = ? AND trade_date >= ? AND trade_date <= ?`,
    args: [input.accountId, input.startDate, input.endDate],
  })
  const fillRow = fillR.rows[0] ?? {}
  const totalFeesCents = num(fillRow.fees)
  const buyAmountCents = num(fillRow.buys)
  const sellAmountCents = num(fillRow.sells)
  const feesDragBp = avgEquity && avgEquity > 0 ? ratioBp(totalFeesCents, avgEquity) : null
  const turnoverBp = avgEquity && avgEquity > 0
    ? ratioBp(buyAmountCents + sellAmountCents, avgEquity)
    : null

  return {
    kind: input.kind,
    startDate: rows.length ? str(rows[0].trade_date) : null,
    endDate: rows.length ? str(rows[rows.length - 1].trade_date) : null,
    validDays,
    startEquityCents: startEquity,
    endEquityCents: endEquity,
    returnBp,
    annualizedReturnBp: annualize(returnBp),
    maxDrawdownBp: maxDrawdownBp(equities),
    sharpe: dailyStd && dailyStd > 0 ? Math.round((mean(dailyReturnsBp) as number) / dailyStd * Math.sqrt(ANNUALIZE_DAYS) * 100) / 100 : null,
    sortino: downsideStd && downsideStd > 0 ? Math.round((mean(dailyReturnsBp) as number) / downsideStd * Math.sqrt(ANNUALIZE_DAYS) * 100) / 100 : null,
    averageEquityCents: avgEquity == null ? null : Math.round(avgEquity),
    totalFeesCents,
    feesDragBp,
    feesDragAnnualizedBp: annualize(feesDragBp),
    turnoverAnnualizedBp: annualize(turnoverBp),
    fillCount: num(fillRow.n),
    buyAmountCents,
    sellAmountCents,
  }
}

interface CardExecutionInfo {
  triggeredCardIds: Set<string>
  confirmedCardIds: Set<string>
  filledCardIds: Set<string>
  deviations: Map<string, number>
}

/** 触发卡口径与日复盘一致：候选卡至少有一笔非 trigger_not_met 委托；没有委托按已触发保守计。 */
async function loadCardExecution(experimentId: string): Promise<CardExecutionInfo> {
  const db = await getDb()
  const cardsR = await db.execute({
    sql: `SELECT id, stance, status FROM paper_decision_cards WHERE experiment_id = ?`,
    args: [experimentId],
  })
  const ordersR = await db.execute({
    sql: `SELECT card_id, status, actor, reject_code, off_plan_reason
          FROM paper_orders WHERE experiment_id = ?`,
    args: [experimentId],
  })
  const byCard = new Map<string, Array<{ status: string; actor: string; rejectCode: string; offPlanReason: string }>>()
  for (const row of ordersR.rows) {
    const cardId = str(row.card_id)
    if (!cardId) continue
    const list = byCard.get(cardId) ?? []
    list.push({
      status: str(row.status),
      actor: str(row.actor),
      rejectCode: str(row.reject_code),
      offPlanReason: str(row.off_plan_reason),
    })
    byCard.set(cardId, list)
  }

  const triggered = new Set<string>()
  const confirmed = new Set<string>()
  const filled = new Set<string>()
  const deviations = new Map<string, number>()
  for (const row of cardsR.rows) {
    const cardId = str(row.id)
    const stance = str(row.stance)
    const orders = byCard.get(cardId) ?? []
    const userOrders = orders.filter((order) => order.actor === 'user')
    const nonTriggered = orders.some((order) => order.status !== 'trigger_not_met')
    if (stance === 'candidate' && (!orders.length || nonTriggered)) {
      triggered.add(cardId)
    } else if (stance !== 'candidate' && nonTriggered) {
      triggered.add(cardId)
    }
    if (userOrders.some((order) => order.status === 'filled')) filled.add(cardId)
    if (userOrders.length) confirmed.add(cardId)

    if (stance !== 'candidate' || !triggered.has(cardId)) continue
    if (filled.has(cardId)) continue
    const user = userOrders[0]
    let reason = 'not_confirmed'
    if (user?.offPlanReason) reason = 'off_plan'
    else if (user && (user.status === 'rejected' || user.status === 'expired')) {
      reason = /RISK_/.test(user.rejectCode) ? 'risk_blocked' : 'data_blocked'
    } else if (str(row.status) === 'invalidated') {
      reason = 'data_blocked'
    }
    deviations.set(reason, (deviations.get(reason) ?? 0) + 1)
  }

  return {
    triggeredCardIds: triggered,
    confirmedCardIds: confirmed,
    filledCardIds: filled,
    deviations,
  }
}

function summarizeExecution(cards: CardExecutionInfo): PaperExecutionMetrics {
  const triggeredCards = cards.triggeredCardIds.size
  const filledCards = cards.filledCardIds.size
  return {
    triggeredCards,
    confirmedCards: cards.confirmedCardIds.size,
    filledCards,
    executionRateBp: triggeredCards ? Math.round(filledCards * 10_000 / triggeredCards) : null,
    deviations: [...cards.deviations.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
  }
}

function tradeCostPpm(policy: PaperPolicy): { buy: number; sell: number } {
  const { fees } = policy
  const buy = fees.commissionPpm + fees.transferFeePpm + fees.slippagePpm
  return { buy, sell: buy + fees.stampTaxPpm }
}

/** 等权自选：每月末恢复等权，按权重漂移估算换手成本；缺失月份用 0 收益占位。 */
async function loadEqualWeight(
  experimentId: string,
  startDate: string,
  endDate: string,
  policy: PaperPolicy,
): Promise<PaperEqualWeightMetrics> {
  const db = await getDb()
  const universeR = await db.execute({
    sql: `SELECT symbol_code FROM paper_universe
          WHERE experiment_id = ? AND removed_at IS NULL ORDER BY symbol_code`,
    args: [experimentId],
  })
  const symbols = universeR.rows.map((row) => str(row.symbol_code)).filter(Boolean)
  if (!symbols.length) {
    return {
      symbols: 0,
      method: 'insufficient_data',
      returnBp: null,
      turnoverCostBp: null,
      months: 0,
      note: '股票池为空，无法计算等权基准',
    }
  }

  const series = new Map<string, Map<string, number>>()
  for (const symbol of symbols) {
    const r = await db.execute({
      sql: `SELECT trade_date, close FROM market_bars
            WHERE code = ? AND adjust_type = 'raw' AND trade_date >= ? AND trade_date <= ?
            ORDER BY trade_date`,
      args: [symbol, startDate, endDate],
    })
    const byMonth = new Map<string, { first: number; last: number }>()
    for (const row of r.rows) {
      const month = str(row.trade_date).slice(0, 7)
      const close = num(row.close)
      if (close <= 0) continue
      const current = byMonth.get(month)
      if (!current) byMonth.set(month, { first: close, last: close })
      else current.last = close
    }
    if (byMonth.size) {
      const closes = new Map<string, { first: number; last: number }>(byMonth)
      series.set(symbol, new Map([...closes].map(([month, value]) => [month, value.last / value.first - 1])))
    }
  }

  const months = [...new Set([...series.values()].flatMap((returns) => [...returns.keys()]))].sort()
  if (months.length < 2) {
    return {
      symbols,
      method: 'insufficient_data',
      returnBp: null,
      turnoverCostBp: null,
      months: months.length,
      note: '有效月份不足 2 个，暂不计算等权再平衡收益',
    }
  }

  const costs = tradeCostPpm(policy)
  const buyRate = costs.buy / 10_000
  const roundTripRate = (costs.buy + costs.sell) / 10_000
  let weights = new Map<string, number>()
  let cumulative = 1
  let turnoverCost = 0
  for (const [index, month] of months.entries()) {
    const available = symbols.filter((symbol) => series.get(symbol)?.has(month))
    if (!available.length) continue
    const monthReturn = available.reduce((sum, symbol) => sum + (series.get(symbol)?.get(month) ?? 0), 0) / available.length
    if (index === 0 || weights.size === 0) {
      weights = new Map(available.map((symbol) => [symbol, 1 / available.length]))
      turnoverCost += buyRate
      cumulative *= 1 + monthReturn - buyRate
      continue
    }
    // 上月末权重按本月收益漂移，再与新的等权目标比较换手。
    const held = [...weights.entries()]
    const grossReturns = new Map(held.map(([symbol, weight]) => [
      symbol,
      (series.get(symbol)?.get(month) ?? 0) * weight,
    ]))
    const portfolioReturn = [...grossReturns.values()].reduce((sum, v) => sum + v, 0)
    const before = new Map(held.map(([symbol, weight]) => [
      symbol,
      portfolioReturn !== -1 ? weight * (1 + (series.get(symbol)?.get(month) ?? 0)) / (1 + portfolioReturn) : weight,
    ]))
    const targetWeight = 1 / available.length
    const allSymbols = new Set([...before.keys(), ...available])
    let turnover = 0
    for (const symbol of allSymbols) turnover += Math.abs((before.get(symbol) ?? 0) - (available.includes(symbol) ? targetWeight : 0))
    turnover /= 2
    const cost = turnover * roundTripRate
    turnoverCost += cost
    cumulative *= 1 + portfolioReturn - cost
    weights = new Map(available.map((symbol) => [symbol, targetWeight]))
  }

  return {
    symbols: symbols.length,
    method: 'monthly_equal_weight',
    returnBp: Math.round((cumulative - 1) * 10_000),
    turnoverCostBp: Math.round(turnoverCost * 10_000),
    months: months.length,
    note: '等权自选按月末恢复等权估算，已扣双边佣金/过户费/滑点与卖出印花税；行情未复权。',
  }
}

async function loadOutcomes(
  experimentId: string,
  input: { sufficientForDescriptive: boolean; execution: CardExecutionInfo },
): Promise<PaperOutcomeCohort[]> {
  const db = await getDb()
  const cardsR = await db.execute({
    sql: 'SELECT id FROM paper_decision_cards WHERE experiment_id = ?',
    args: [experimentId],
  })
  // 一次取全量再按 cohort 归类，避免 IN (...) 超过 SQLite 变量上限。
  const outcomesR = await db.execute({
    sql: `SELECT o.card_id, o.horizon_days, o.hit, o.alpha_bp
          FROM paper_decision_outcomes o
          JOIN paper_decision_cards c ON c.id = o.card_id
          WHERE c.experiment_id = ?`,
    args: [experimentId],
  })
  const byCard = new Map<string, Array<{ horizon: number; hit: number | null; alpha: number | null }>>()
  for (const row of outcomesR.rows) {
    const cardId = str(row.card_id)
    const list = byCard.get(cardId) ?? []
    list.push({
      horizon: num(row.horizon_days),
      hit: row.hit == null ? null : num(row.hit),
      alpha: row.alpha_bp == null ? null : num(row.alpha_bp),
    })
    byCard.set(cardId, list)
  }

  const cohorts: Array<{ key: PaperOutcomeCohort['cohort']; ids: string[] }> = [
    { key: 'all', ids: cardsR.rows.map((row) => str(row.id)) },
    {
      key: 'triggered',
      ids: cardsR.rows
        .map((row) => str(row.id))
        .filter((id) => input.execution.triggeredCardIds.has(id)),
    },
    { key: 'executed', ids: [...input.execution.filledCardIds] },
  ]

  const result: PaperOutcomeCohort[] = []
  for (const cohort of cohorts) {
    const horizons: PaperOutcomeHorizon[] = []
    let matured = 0
    let hitCount = 0
    let hitEvaluated = 0
    let alphaSum = 0
    let alphaCount = 0
    for (const horizon of [5, 20, 60] as const) {
      let hMatured = 0
      let hHit = 0
      let hHitEvaluated = 0
      let hAlpha = 0
      let hAlphaCount = 0
      for (const cardId of cohort.ids) {
        for (const row of byCard.get(cardId) ?? []) {
          if (row.horizon !== horizon) continue
          hMatured += 1
          if (row.hit != null) {
            hHit += row.hit
            hHitEvaluated += 1
          }
          if (row.alpha != null) {
            hAlpha += row.alpha
            hAlphaCount += 1
          }
        }
      }
      matured += hMatured
      hitCount += hHit
      hitEvaluated += hHitEvaluated
      alphaSum += hAlpha
      alphaCount += hAlphaCount
      horizons.push({
        horizonDays: horizon,
        matured: hMatured,
        hitCount: hHit,
        averageAlphaBp: input.sufficientForDescriptive && hAlphaCount
          ? Math.round(hAlpha / hAlphaCount)
          : null,
        hitRateBp: input.sufficientForDescriptive && hHitEvaluated
          ? Math.round(hHit * 10_000 / hHitEvaluated)
          : null,
      })
    }
    result.push({
      cohort: cohort.key,
      cards: cohort.ids.length,
      matured,
      hitRateBp: input.sufficientForDescriptive && hitEvaluated
        ? Math.round(hitCount * 10_000 / hitEvaluated)
        : null,
      averageAlphaBp: input.sufficientForDescriptive && alphaCount ? Math.round(alphaSum / alphaCount) : null,
      horizons,
    })
  }
  return result
}

async function loadMaturity(input: {
  experimentId: string
  startDate: string
  endDate: string
  asOfDate: string
}): Promise<{ lastCardTradeDate: string | null; mature60: boolean; validDays: number }> {
  const db = await getDb()
  // 17:30 会写入 trade_date=次日 的卡；不排除未来日期会把观察窗起点推到还没开市的一天。
  const lastCardR = await db.execute({
    sql: `SELECT MAX(trade_date) AS d FROM paper_decision_cards
          WHERE experiment_id = ? AND trade_date <= ?`,
    args: [input.experimentId, input.asOfDate],
  })
  const lastCard = lastCardR.rows[0]?.d == null ? null : String(lastCardR.rows[0].d)
  const userAccountR = await db.execute({
    sql: `SELECT id FROM paper_accounts WHERE experiment_id = ? AND kind = 'user' LIMIT 1`,
    args: [input.experimentId],
  })
  const accountId = userAccountR.rows.length ? str(userAccountR.rows[0].id) : ''
  const navR = accountId
    ? await db.execute({
      // 缺行情当天只记录 warn 净值供人看，不能算进统计门槛的有效日。
      sql: `SELECT COUNT(*) AS n FROM paper_nav
            WHERE account_id = ? AND quality = 'pass'
              AND trade_date >= ? AND trade_date <= ?`,
      args: [accountId, input.startDate, input.endDate],
    })
    : { rows: [] as Row[] }
  const validDays = num(navR.rows[0]?.n)
  if (!lastCard) return { lastCardTradeDate: null, mature60: false, validDays }

  const calendarR = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM trading_calendar
          WHERE is_open = 1 AND trade_date > ? AND trade_date <= ?`,
    args: [lastCard, input.asOfDate],
  })
  let openDays = num(calendarR.rows[0]?.n)
  if (!openDays && accountId) {
    const navAfterR = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM paper_nav
            WHERE account_id = ? AND trade_date > ? AND trade_date <= ?`,
      args: [accountId, lastCard, input.asOfDate],
    })
    openDays = num(navAfterR.rows[0]?.n)
  }
  return { lastCardTradeDate: lastCard, mature60: openDays >= 60, validDays }
}

export async function computePaperMetrics(input: {
  experimentId: string
  now?: string
}): Promise<PaperMetricsReport> {
  const experiment = await getPaperExperiment(input.experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', '实验不存在')
  const { policy } = await getPaperExperimentPolicy(experiment.id)
  const accounts = await listPaperAccounts(experiment.id)
  const user = accounts.find((a) => a.kind === 'user')
  const shadow = accounts.find((a) => a.kind === 'shadow')
  if (!user || !shadow) throw new PaperRepoError('NOT_FOUND', '实验账户不完整')

  const startDate = dayOf(experiment.startedAt) || dayOf(experiment.createdAt)
  const endR = await getDb().then((db) => db.execute({
    sql: `SELECT MAX(trade_date) AS d FROM paper_nav WHERE account_id = ?`,
    args: [user.id],
  }))
  const endDate = endR.rows[0]?.d == null ? startDate : String(endR.rows[0].d)
  const [maturity, cardExecution] = await Promise.all([
    loadMaturity({
      experimentId: experiment.id,
      startDate,
      endDate,
      asOfDate: dateShanghai(input.now) || todayShanghai(),
    }),
    loadCardExecution(experiment.id),
  ])
  const execution = summarizeExecution(cardExecution)
  const sufficientForDescriptive = maturity.validDays >= DESCRIPTIVE_MIN_DAYS
    && maturity.mature60
    && execution.triggeredCards >= DESCRIPTIVE_MIN_TRIGGERED
  const sufficientForSignificance = maturity.validDays >= SIGNIFICANCE_MIN_DAYS
    && execution.triggeredCards >= SIGNIFICANCE_MIN_TRIGGERED

  const [userMetrics, shadowMetrics, benchmark, equalWeight] = await Promise.all([
    loadAccountMetrics({ accountId: user.id, kind: 'user', startDate, endDate }),
    loadAccountMetrics({ accountId: shadow.id, kind: 'shadow', startDate, endDate }),
    loadBenchmark(experiment, startDate, endDate),
    loadEqualWeight(experiment.id, startDate, endDate, policy),
  ])
  const excessBp = {
    user: userMetrics.returnBp != null && benchmark.returnBp != null
      ? userMetrics.returnBp - benchmark.returnBp
      : null,
    shadow: shadowMetrics.returnBp != null && benchmark.returnBp != null
      ? shadowMetrics.returnBp - benchmark.returnBp
      : null,
  }
  const outcomes = await loadOutcomes(experiment.id, {
    sufficientForDescriptive,
    execution: cardExecution,
  })
  const notes: string[] = []
  if (benchmark.basis === 'price_index') {
    notes.push(`基准 ${benchmark.code} 是价格指数，未叠加股息；当前超额不是全收益口径，不能把股息算成 alpha。`)
  } else if (benchmark.basis === 'unavailable') {
    notes.push('缺少基准行情，超额暂不可用。')
  }
  if (!sufficientForDescriptive) {
    notes.push('样本不足：不足 120 个有效交易日、最后一张卡不满 60 日或触发卡不足 30 张，只展示计数。')
  }
  if (!sufficientForSignificance) {
    notes.push('未达 250 个有效交易日或 100 张触发卡，不做显著性结论。')
  }
  notes.push('夏普与索提诺按无风险利率 0 计算。')
  notes.push('p_outperform 尚未校准，本报告不计算、不展示 Brier 分数。')

  return {
    experimentId: experiment.id,
    asOf: input.now ?? new Date().toISOString(),
    sample: {
      validDays: maturity.validDays,
      triggeredCards: execution.triggeredCards,
      lastCardTradeDate: maturity.lastCardTradeDate,
      lastCardMature60: maturity.mature60,
      sufficientForDescriptive,
      sufficientForSignificance,
      rules: '不足 120 日/最后一张卡不满 60 日/触发卡少于 30 张只显示计数；不足 250 日/100 张不做显著性结论。',
    },
    accounts: { user: userMetrics, shadow: shadowMetrics },
    benchmark,
    equalWeightUniverse: equalWeight,
    excessBp,
    execution,
    outcomes,
    calibration: {
      status: 'uncalibrated',
      brier: null,
      eligible: false,
      note: '尚无 calibration_status=calibrated 的校准记录；概率只记录，不进入阶段门。',
    },
    notes,
  }
}
