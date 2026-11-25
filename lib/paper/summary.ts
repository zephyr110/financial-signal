import { getDb } from '../db'
import { shanghaiClock } from '../cockpit/market-hours'
import { loadPaperSymbolNames, parseJsonColumn } from './api'
import { isPaperTradingDay } from './calendar'
import { listPaperExperimentHistory, paperProtocolHash } from './experiment'
import {
  computePaperGateReport,
  type PaperGateReport,
} from './gates'
import { computePaperMetrics, type PaperMetricsReport } from './metrics'
import {
  getCurrentPaperExperiment,
  getPaperRiskState,
  listPaperAccounts,
  loadPaperLedger,
  type PaperExperimentRow,
} from './repo'

/**
 * 模拟盘总览：一屏回答「今天要不要动」。
 * 没有实验时仍返回 200 + setupRequired，首次使用不需要先猜一个错误码。
 */

type Row = Record<string, unknown>

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function nullableNum(value: unknown): number | null {
  return value == null ? null : num(value)
}

function nullableStr(value: unknown): string | null {
  return value == null ? null : String(value)
}

function clockTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export interface PaperSummaryTodo {
  kind: 'action' | 'warning' | 'info'
  label: string
  detail?: string
}

export type PaperSummaryAction =
  | 'setup'
  | 'start'
  | 'resume'
  | 'review_cards'
  | 'wait_settlement'
  | 'hold'
  | 'blocked'

export interface PaperSummaryAccount {
  id: string
  kind: 'user' | 'shadow'
  name: string
  status: string
  isDemo: boolean
  initialCashCents: number
  cashCents: number
  frozenCashCents: number
  nav: {
    tradeDate: string
    cashCents: number
    frozenCashCents: number
    marketValueCents: number
    totalEquityCents: number
    dailyReturnBp: number | null
    drawdownBp: number | null
    quality: string
  } | null
  risk: {
    killSwitch: boolean
    killReason: string | null
    killSince: string | null
    dataQuality: string
    missingPriceSince: string | null
    releaseAfterDate: string | null
  }
}

export interface PaperSummaryCard {
  id: string
  tradeDate: string
  symbolCode: string
  symbolName: string | null
  stance: string
  status: string
  thesis: string
  triggerPriceCents: number | null
  stopPriceCents: number | null
  maxPositionPctBp: number
  confidenceScore: number
  expiresAt: string | null
}

export interface PaperSummaryOrder {
  id: string
  cardId: string | null
  symbolCode: string
  symbolName: string | null
  side: string
  qty: number
  status: string
  targetTradeDate: string
  rejectCode: string | null
  confirmedAt: string | null
  createdAt: string
}

export interface PaperSummaryFill {
  id: string
  orderId: string
  symbolCode: string
  symbolName: string | null
  side: string
  qty: number
  priceCents: number
  totalFeesCents: number
  tradeDate: string
  priceBasis: string
}

export interface PaperSummaryReconciliation {
  accountId: string
  kind: 'user' | 'shadow'
  tradeDate: string
  status: string
  mismatchCents: number
  diffs: unknown
  createdAt: string
}

export interface PaperSummaryReview {
  id: string
  kind: 'daily' | 'weekly'
  periodStart: string
  periodEnd: string
  narrative: string | null
  actualNavCents: number | null
  shadowNavCents: number | null
  executionRateBp: number | null
  deviations: unknown
  createdAt: string
}

export interface PaperSummaryExperiment {
  id: string
  name: string
  protocolVersion: string
  policyVersion: string
  protocolHash: string
  benchmarkCode: string
  initialCashCents: number
  status: PaperExperimentRow['status']
  startedAt: string | null
  plannedEndAt: string | null
  endedAt: string | null
  validDays: number
  pauseReason: string | null
  resetCount: number
  resetOf: string | null
  protocol: unknown
  baseline: unknown
  createdAt: string
}

export interface PaperSummary {
  setupRequired: boolean
  generatedAt: string
  today: {
    tradeDate: string
    isTradingDay: boolean
    now: string
    cutoffAt: string
    action: PaperSummaryAction
    headline: string
    todos: PaperSummaryTodo[]
  }
  experiment: PaperSummaryExperiment | null
  accounts: PaperSummaryAccount[]
  nav: {
    latest: PaperSummaryAccount['nav']
    series: Array<{
      tradeDate: string
      totalEquityCents: number
      dailyReturnBp: number | null
      drawdownBp: number | null
    }>
  }
  metrics: PaperMetricsReport | null
  metricsError: string | null
  gates: { l1: PaperGateReport; l2: PaperGateReport } | null
  gatesError: string | null
  cards: {
    latestTradeDate: string | null
    counts: Record<string, number>
    pendingToday: number
    pendingFuture: number
    items: PaperSummaryCard[]
  }
  orders: {
    recent: PaperSummaryOrder[]
    openCount: number
    counts: Record<string, number>
  }
  fills: { recent: PaperSummaryFill[] }
  reconciliation: {
    user: PaperSummaryReconciliation | null
    shadow: PaperSummaryReconciliation | null
    allPass: boolean
  }
  reviews: {
    daily: PaperSummaryReview | null
    weekly: PaperSummaryReview | null
  }
  history: Array<{
    id: string
    name: string
    status: string
    resetCount: number
    resetOf: string | null
    validDays: number
    startedAt: string | null
    endedAt: string | null
    createdAt: string
  }>
  recentExperiments: Array<{
    id: string
    name: string
    status: string
    validDays: number
    resetCount: number
    pauseReason: string | null
    createdAt: string
    endedAt: string | null
  }>
}

function mapExperiment(row: PaperExperimentRow): PaperSummaryExperiment {
  return {
    id: row.id,
    name: row.name,
    protocolVersion: row.protocolVersion,
    policyVersion: row.policyVersion,
    protocolHash: paperProtocolHash(row.protocolJson),
    benchmarkCode: row.benchmarkCode,
    initialCashCents: row.initialCashCents,
    status: row.status,
    startedAt: row.startedAt,
    plannedEndAt: row.plannedEndAt,
    endedAt: row.endedAt,
    validDays: row.validDays,
    pauseReason: row.pauseReason,
    resetCount: row.resetCount,
    resetOf: row.resetOf,
    protocol: parseJsonColumn(row.protocolJson, {}),
    baseline: parseJsonColumn(row.baselineJson, {}),
    createdAt: row.createdAt,
  }
}

async function recentExperiments(): Promise<PaperSummary['recentExperiments']> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT id, name, status, valid_days, reset_count, pause_reason, created_at, ended_at
          FROM paper_experiments ORDER BY created_at DESC LIMIT 10`,
    args: [],
  })
  return r.rows.map((row) => ({
    id: str(row.id),
    name: str(row.name),
    status: str(row.status),
    validDays: num(row.valid_days),
    resetCount: num(row.reset_count),
    pauseReason: nullableStr(row.pause_reason),
    createdAt: str(row.created_at),
    endedAt: nullableStr(row.ended_at),
  }))
}

async function loadAccounts(experimentId: string): Promise<{
  accounts: PaperSummaryAccount[]
  user: PaperSummaryAccount | null
  shadow: PaperSummaryAccount | null
}> {
  const rows = await listPaperAccounts(experimentId)
  const db = await getDb()
  const accounts: PaperSummaryAccount[] = []
  for (const account of rows) {
    const [ledger, risk, navR] = await Promise.all([
      loadPaperLedger(account.id),
      getPaperRiskState(account.id),
      db.execute({
        sql: `SELECT * FROM paper_nav WHERE account_id = ?
              ORDER BY trade_date DESC LIMIT 1`,
        args: [account.id],
      }),
    ])
    const navRow = navR.rows[0]
    accounts.push({
      id: account.id,
      kind: account.kind,
      name: account.name,
      status: account.status,
      isDemo: account.isDemo,
      initialCashCents: account.initialCashCents,
      cashCents: account.cashCents,
      frozenCashCents: ledger.frozenCashCents,
      nav: navRow
        ? {
            tradeDate: str(navRow.trade_date),
            cashCents: num(navRow.cash_cents),
            frozenCashCents: num(navRow.frozen_cash_cents),
            marketValueCents: num(navRow.market_value_cents),
            totalEquityCents: num(navRow.total_equity_cents),
            dailyReturnBp: nullableNum(navRow.daily_return_bp),
            drawdownBp: nullableNum(navRow.drawdown_bp),
            quality: str(navRow.quality),
          }
        : null,
      risk: {
        killSwitch: risk.killSwitch,
        killReason: risk.killReason,
        killSince: risk.killSince,
        dataQuality: risk.dataQuality,
        missingPriceSince: risk.missingPriceSince,
        releaseAfterDate: risk.releaseAfterDate,
      },
    })
  }
  return {
    accounts,
    user: accounts.find((a) => a.kind === 'user') ?? null,
    shadow: accounts.find((a) => a.kind === 'shadow') ?? null,
  }
}

async function loadNavSeries(accountId: string): Promise<PaperSummary['nav']['series']> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT trade_date, total_equity_cents, daily_return_bp, drawdown_bp
          FROM paper_nav WHERE account_id = ? ORDER BY trade_date DESC LIMIT 60`,
    args: [accountId],
  })
  return r.rows.map((row) => ({
    tradeDate: str(row.trade_date),
    totalEquityCents: num(row.total_equity_cents),
    dailyReturnBp: nullableNum(row.daily_return_bp),
    drawdownBp: nullableNum(row.drawdown_bp),
  })).reverse()
}

async function loadCards(experimentId: string, today: string): Promise<PaperSummary['cards']> {
  const db = await getDb()
  const latestR = await db.execute({
    sql: `SELECT MAX(trade_date) AS d FROM paper_decision_cards
          WHERE experiment_id = ? AND id NOT LIKE 'acard-%'`,
    args: [experimentId],
  })
  const latestTradeDate = nullableStr(latestR.rows[0]?.d)

  const counts: Record<string, number> = {}
  // 只有 candidate 卡能确认买入；observe/caution 计入“待确认”会给出无法执行的动作。
  const pendingR = await db.execute({
    sql: `SELECT trade_date, status, COUNT(*) AS n FROM paper_decision_cards
          WHERE experiment_id = ? AND status IN ('active','triggered') AND stance = 'candidate'
            AND id NOT LIKE 'acard-%'
          GROUP BY trade_date, status`,
    args: [experimentId],
  })
  let pendingToday = 0
  let pendingFuture = 0
  for (const row of pendingR.rows) {
    const tradeDate = str(row.trade_date)
    const n = num(row.n)
    if (tradeDate === today) pendingToday += n
    else if (tradeDate > today) pendingFuture += n
  }
  if (latestTradeDate) {
    const batchR = await db.execute({
      sql: `SELECT status, COUNT(*) AS n FROM paper_decision_cards
            WHERE experiment_id = ? AND trade_date = ? AND id NOT LIKE 'acard-%'
            GROUP BY status`,
      args: [experimentId, latestTradeDate],
    })
    for (const row of batchR.rows) counts[str(row.status)] = num(row.n)
  }

  let items: PaperSummaryCard[] = []
  if (latestTradeDate) {
    const r = await db.execute({
      sql: `SELECT c.*, m.name AS symbol_name
            FROM paper_decision_cards c
            LEFT JOIN paper_symbol_meta m ON m.symbol_code = c.symbol_code
              AND m.valid_from = (
                SELECT MAX(m2.valid_from) FROM paper_symbol_meta m2
                WHERE m2.symbol_code = c.symbol_code
                  AND m2.valid_from <= c.trade_date
                  AND (m2.valid_to IS NULL OR m2.valid_to >= c.trade_date)
              )
            WHERE c.experiment_id = ? AND c.trade_date = ? AND c.id NOT LIKE 'acard-%'
            ORDER BY c.confidence_score DESC, c.created_at, c.id
            LIMIT 8`,
      args: [experimentId, latestTradeDate],
    })
    items = r.rows.map((row: Row) => ({
      id: str(row.id),
      tradeDate: str(row.trade_date),
      symbolCode: str(row.symbol_code),
      symbolName: nullableStr(row.symbol_name),
      stance: str(row.stance),
      status: str(row.status),
      thesis: str(row.thesis),
      triggerPriceCents: nullableNum(row.trigger_price_cents),
      stopPriceCents: nullableNum(row.stop_price_cents),
      maxPositionPctBp: num(row.max_position_pct_bp),
      confidenceScore: num(row.confidence_score),
      expiresAt: nullableStr(row.expires_at),
    }))
  }

  return { latestTradeDate, counts, pendingToday, pendingFuture, items }
}

async function loadOrders(accountId: string): Promise<PaperSummary['orders']> {
  const db = await getDb()
  const [recentR, countR] = await Promise.all([
    db.execute({
      sql: `SELECT * FROM paper_orders WHERE account_id = ?
            ORDER BY created_at DESC, id DESC LIMIT 8`,
      args: [accountId],
    }),
    db.execute({
      sql: `SELECT status, COUNT(*) AS n FROM paper_orders WHERE account_id = ?
            GROUP BY status`,
      args: [accountId],
    }),
  ])
  const counts: Record<string, number> = {}
  for (const row of countR.rows) counts[str(row.status)] = num(row.n)
  const names = await loadPaperSymbolNames(recentR.rows.map((row) => str(row.symbol_code)))
  return {
    counts,
    openCount: (counts.confirmed ?? 0) + (counts.settlement_pending ?? 0),
    recent: recentR.rows.map((row) => ({
      id: str(row.id),
      cardId: nullableStr(row.card_id),
      symbolCode: str(row.symbol_code),
      symbolName: names[str(row.symbol_code)] ?? null,
      side: str(row.side),
      qty: num(row.qty),
      status: str(row.status),
      targetTradeDate: str(row.target_trade_date),
      rejectCode: nullableStr(row.reject_code),
      confirmedAt: nullableStr(row.confirmed_at),
      createdAt: str(row.created_at),
    })),
  }
}

async function loadFills(accountId: string): Promise<PaperSummary['fills']> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT * FROM paper_fills WHERE account_id = ?
          ORDER BY settled_at DESC, id DESC LIMIT 8`,
    args: [accountId],
  })
  const names = await loadPaperSymbolNames(r.rows.map((row) => str(row.symbol_code)))
  return {
    recent: r.rows.map((row) => ({
      id: str(row.id),
      orderId: str(row.order_id),
      symbolCode: str(row.symbol_code),
      symbolName: names[str(row.symbol_code)] ?? null,
      side: str(row.side),
      qty: num(row.qty),
      priceCents: num(row.price_cents),
      totalFeesCents: num(row.total_fees_cents),
      tradeDate: str(row.trade_date),
      priceBasis: str(row.price_basis),
    })),
  }
}

async function loadReconciliations(accounts: PaperSummaryAccount[]): Promise<PaperSummary['reconciliation']> {
  const db = await getDb()
  const latest = new Map<string, PaperSummaryReconciliation>()
  for (const account of accounts) {
    const r = await db.execute({
      sql: `SELECT * FROM paper_reconciliations WHERE account_id = ?
            ORDER BY trade_date DESC LIMIT 1`,
      args: [account.id],
    })
    const row = r.rows[0]
    if (!row) continue
    latest.set(account.id, {
      accountId: account.id,
      kind: account.kind,
      tradeDate: str(row.trade_date),
      status: str(row.status),
      mismatchCents: num(row.mismatch_cents),
      diffs: parseJsonColumn(row.diffs_json, []),
      createdAt: str(row.created_at),
    })
  }
  const user = accounts.find((a) => a.kind === 'user')
  const shadow = accounts.find((a) => a.kind === 'shadow')
  const records = [user, shadow]
    .map((a) => (a ? latest.get(a.id) ?? null : null))
    .filter((r): r is PaperSummaryReconciliation => r !== null)
  return {
    user: user ? latest.get(user.id) ?? null : null,
    shadow: shadow ? latest.get(shadow.id) ?? null : null,
    allPass: records.length > 0 && records.every((r) => r.status === 'pass'),
  }
}

async function loadReviews(experimentId: string): Promise<PaperSummary['reviews']> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT * FROM paper_reviews WHERE experiment_id = ?
          ORDER BY period_end DESC, created_at DESC LIMIT 8`,
    args: [experimentId],
  })
  const map = (row: Row): PaperSummaryReview => ({
    id: str(row.id),
    kind: str(row.kind) === 'weekly' ? 'weekly' : 'daily',
    periodStart: str(row.period_start),
    periodEnd: str(row.period_end),
    narrative: nullableStr(row.narrative),
    actualNavCents: nullableNum(row.actual_nav_cents),
    shadowNavCents: nullableNum(row.shadow_nav_cents),
    executionRateBp: nullableNum(row.execution_rate_bp),
    deviations: parseJsonColumn(row.deviations_json, []),
    createdAt: str(row.created_at),
  })
  const reviews = r.rows.map(map)
  return {
    daily: reviews.find((x) => x.kind === 'daily') ?? null,
    weekly: reviews.find((x) => x.kind === 'weekly') ?? null,
  }
}

function buildTodos(input: {
  experiment: PaperExperimentRow
  accounts: PaperSummaryAccount[]
  isTradingDay: boolean
  beforeCutoff: boolean
  cards: PaperSummary['cards']
  orders: PaperSummary['orders']
  reconciliation: PaperSummary['reconciliation']
}): { action: PaperSummaryAction; headline: string; todos: PaperSummaryTodo[] } {
  const todos: PaperSummaryTodo[] = []
  const user = input.accounts.find((a) => a.kind === 'user') ?? null
  const shadow = input.accounts.find((a) => a.kind === 'shadow') ?? null
  const riskBlocked = [user, shadow].some(
    (a) => a && (a.risk.killSwitch || a.risk.dataQuality === 'fail'),
  )

  if (input.experiment.status === 'planned') {
    todos.push({ kind: 'action', label: '实验尚未开始', detail: '开始后按交易日累计有效天数，暂停不会重开计时。' })
    return { action: 'start', headline: '实验还没开始：确认协议后点开始', todos }
  }
  if (input.experiment.status === 'paused') {
    todos.push({
      kind: 'action',
      label: '实验已暂停',
      detail: input.experiment.pauseReason ?? '恢复后继续沿用原计时。',
    })
    return { action: 'resume', headline: '实验已暂停，今天不产生新决策', todos }
  }

  if (riskBlocked) {
    todos.push({
      kind: 'warning',
      label: '风控停牌或数据质量失败',
      detail: user?.risk.killReason
        ?? user?.risk.missingPriceSince
        ?? '先修复数据或风控问题，暂不生成新卡与成交。',
    })
  }
  if (input.reconciliation.user && input.reconciliation.user.status !== 'pass') {
    todos.push({
      kind: 'warning',
      label: '最近一次对账不平衡',
      detail: `${input.reconciliation.user.tradeDate} 主账户对账为 ${input.reconciliation.user.status}。`,
    })
  }
  if (input.orders.openCount > 0) {
    todos.push({
      kind: 'info',
      label: `${input.orders.openCount} 笔委托未结束`,
      detail: '确认后的委托等收盘按官方开盘价结算；09:15 前可撤销 confirmed。',
    })
  }

  if (!input.isTradingDay) {
    todos.push({ kind: 'info', label: '今天休市', detail: '只采集分析新闻与政策，不处理行情和成交。' })
    return { action: 'hold', headline: '今天休市：只看新闻与政策，不用动模拟盘', todos }
  }

  // 停在 hold 会让用户以为“今天不用动”；风控停牌必须显式标出来。
  if (riskBlocked) {
    return { action: 'blocked', headline: '风控停牌：先修复数据或风控问题，今天不产生新决策', todos }
  }

  if (input.cards.pendingToday > 0) {
    if (input.beforeCutoff) {
      todos.push({
        kind: 'action',
        label: `${input.cards.pendingToday} 张决策卡待确认`,
        detail: '09:15 前决定是否按开盘条件买入；不确认就不会成交。',
      })
      return {
        action: 'review_cards',
        headline: `今天有 ${input.cards.pendingToday} 张卡等你决定（09:15 截止）`,
        todos,
      }
    } else {
      todos.push({
        kind: 'warning',
        label: '今日确认已截止',
        detail: '09:15 后未确认的卡不会再成交，继续留着只作观察。',
      })
    }
  }

  if (input.orders.openCount > 0) {
    todos.push({ kind: 'info', label: '今天不用加新单', detail: '等收盘结算后，再看复盘与明日卡。' })
    return { action: 'wait_settlement', headline: '今天不用再加新单：等收盘结算', todos }
  }

  if (input.cards.pendingFuture > 0) {
    todos.push({
      kind: 'info',
      label: `明日有 ${input.cards.pendingFuture} 张候选卡`,
      detail: '明早 09:15 前再确认；今天收盘后再看复盘。',
    })
  }
  if (user?.risk.dataQuality === 'warn') {
    todos.push({ kind: 'warning', label: '数据质量为 warn', detail: '卡上会标注警告；确认前先看缺失项。' })
  }
  if (!todos.length) {
    todos.push({ kind: 'info', label: '今天没有待办', detail: '没有待确认的卡，也没有在途委托。' })
  }
  return { action: 'hold', headline: '今天不用动：没有待确认的卡或在途委托', todos }
}

export async function buildPaperSummary(input: { now?: string } = {}): Promise<PaperSummary> {
  const now = input.now ?? new Date().toISOString()
  const clock = shanghaiClock(input.now ? new Date(input.now) : new Date())
  const today = clock.date
  const isTradingDay = await isPaperTradingDay(today)
  const [experiment, experiments] = await Promise.all([getCurrentPaperExperiment(), recentExperiments()])

  if (!experiment) {
    return {
      setupRequired: true,
      generatedAt: now,
      today: {
        tradeDate: today,
        isTradingDay,
        now: clockTime(clock.minutes),
        cutoffAt: '09:15',
        action: 'setup',
        headline: '还没有进行中的模拟盘实验',
        todos: [{
          kind: 'action',
          label: '先建一个实验',
          detail: '锁定协议、初始资金与基准后开始；之后不能偷偷改参数。',
        }],
      },
      experiment: null,
      accounts: [],
      nav: { latest: null, series: [] },
      metrics: null,
      metricsError: null,
      gates: null,
      gatesError: null,
      cards: { latestTradeDate: null, counts: {}, pendingToday: 0, pendingFuture: 0, items: [] },
      orders: { recent: [], openCount: 0, counts: {} },
      fills: { recent: [] },
      reconciliation: { user: null, shadow: null, allPass: false },
      reviews: { daily: null, weekly: null },
      history: [],
      recentExperiments: experiments,
    }
  }

  let metrics: PaperMetricsReport | null = null
  let metricsError: string | null = null
  try {
    metrics = await computePaperMetrics({ experimentId: experiment.id, now })
  } catch (err) {
    metricsError = err instanceof Error ? err.message : '指标计算失败'
  }

  const { accounts, user } = await loadAccounts(experiment.id)
  const [navSeries, cards, orders, fills, reconciliation, reviews, history] = await Promise.all([
    user ? loadNavSeries(user.id) : Promise.resolve([]),
    loadCards(experiment.id, today),
    user ? loadOrders(user.id) : Promise.resolve({ recent: [], openCount: 0, counts: {} }),
    user ? loadFills(user.id) : Promise.resolve({ recent: [] }),
    loadReconciliations(accounts),
    loadReviews(experiment.id),
    listPaperExperimentHistory(experiment.id),
  ])

  let gates: PaperSummary['gates'] = null
  let gatesError: string | null = null
  try {
    const [l1, l2] = await Promise.all([
      computePaperGateReport({ experimentId: experiment.id, gate: 'L1_TO_L2', now, metrics: metrics ?? undefined }),
      computePaperGateReport({ experimentId: experiment.id, gate: 'L2_TO_L3', now, metrics: metrics ?? undefined }),
    ])
    gates = { l1, l2 }
  } catch (err) {
    gatesError = err instanceof Error ? err.message : '阶段门计算失败'
  }

  const assessment = buildTodos({
    experiment,
    accounts,
    isTradingDay,
    beforeCutoff: clock.minutes < 9 * 60 + 15,
    cards,
    orders,
    reconciliation,
  })

  return {
    setupRequired: false,
    generatedAt: now,
    today: {
      tradeDate: today,
      isTradingDay,
      now: clockTime(clock.minutes),
      cutoffAt: '09:15',
      ...assessment,
    },
    experiment: mapExperiment(experiment),
    accounts,
    nav: { latest: user?.nav ?? null, series: navSeries },
    metrics,
    metricsError,
    gates,
    gatesError,
    cards,
    orders,
    fills,
    reconciliation,
    reviews,
    history,
    recentExperiments: experiments,
  }
}
