import { getDb } from '../db'
import { todayShanghai } from '../cockpit/format'
import {
  AGENT_ACTION_LABEL,
  type AgentAction,
  type AgentHorizon,
} from './agent'
import { computePaperNav } from './jobs'
import {
  getCurrentPaperExperiment,
  getPaperExperiment,
  listPaperAccounts,
  loadLatestClosePriceCents,
  type PaperExperimentRow,
} from './repo'

/**
 * Agent 战绩页的数据聚合：正确率、alpha、置信度校准与逐条决策回溯。
 * 口径只认已落库的 paper_agent_outcomes；没有结果就显示“待评估”，不做推断。
 */

type Row = Record<string, unknown>
const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
const maybeNum = (v: unknown): number | null => (v == null ? null : Number(v))
const maybeBool = (v: unknown): boolean | null => (v == null ? null : num(v) === 1)

const MAX_STATS_DECISIONS = 1000
const DISPLAY_DECISIONS = 80
const RUNS_SHOWN = 30

export interface AgentOutcomeView {
  horizonDays: AgentHorizon
  entryDate: string | null
  evaluateDate: string | null
  entryPriceCents: number | null
  endPriceCents: number | null
  returnBp: number | null
  benchmarkReturnBp: number | null
  alphaBp: number | null
  maxFavorableBp: number | null
  maxAdverseBp: number | null
  directionHit: boolean | null
  alphaHit: boolean | null
  invalidationHit: boolean | null
  dataQuality: string
}

export interface AgentDecisionView {
  id: string
  runId: string
  decidedForDate: string
  symbolCode: string
  symbolName: string
  action: AgentAction
  actionLabel: string
  conviction: number
  thesis: string
  evidence: string[]
  counterEvidence: string[]
  invalidation: string
  plannedQty: number | null
  plannedPriceCents: number | null
  stopPriceCents: number | null
  status: string
  statusReason: string | null
  positionQtyBefore: number
  cardStatus: string | null
  orderStatus: string | null
  outcomes: AgentOutcomeView[]
}

export interface AgentAccuracyBucket {
  key: string
  label: string
  evaluated: number
  directionHitRate: number | null
  alphaHitRate: number | null
  avgReturnBp: number | null
  avgAlphaBp: number | null
}

export interface AgentHorizonAccuracy {
  horizonDays: AgentHorizon
  outcomes: number
  directional: number
  directionHitRate: number | null
  alphaEvaluated: number
  alphaHitRate: number | null
  invalidationRate: number | null
  avgReturnBp: number | null
  avgAlphaBp: number | null
  avgMfeBp: number | null
  avgMaeBp: number | null
  executed: {
    outcomes: number
    directionHitRate: number | null
    alphaHitRate: number | null
    avgReturnBp: number | null
    avgAlphaBp: number | null
  }
  byAction: AgentAccuracyBucket[]
  byConviction: AgentAccuracyBucket[]
}

export interface AgentRunSummaryView {
  id: string
  barsDate: string
  planTradeDate: string
  status: string
  triggerSource: string
  model: string | null
  marketView: string | null
  review: string | null
  errorCode: string | null
  errorMessage: string | null
  decisions: number
  executed: number
  createdAt: string
  completedAt: string | null
}

export interface AgentDashboard {
  generatedAt: string
  experiment: {
    id: string
    name: string
    status: string
    benchmarkCode: string
    initialCashCents: number
    startedAt: string | null
  } | null
  nav: {
    totalEquityCents: number
    cashCents: number
    marketValueCents: number
    positionCount: number
    returnBp: number | null
    benchmarkReturnBp: number | null
  } | null
  counts: {
    runs: number
    failedRuns: number
    decisions: number
    executed: number
    evaluated: number
  }
  runs: AgentRunSummaryView[]
  stats: AgentHorizonAccuracy[]
  recentDecisions: AgentDecisionView[]
  curve: Array<{ date: string; totalEquityCents: number; dailyReturnBp: number | null; drawdownBp: number | null }>
}

function avg(values: number[]): number | null {
  if (!values.length) return null
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function rate(hits: number, total: number): number | null {
  if (!total) return null
  return Math.round(hits * 1000 / total) / 10
}

function parseTexts(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

interface DecisionStatRow {
  id: string
  action: AgentAction
  conviction: number
  status: string
  outcomes: AgentOutcomeView[]
}

type OutcomeStatRow = DecisionStatRow & { outcome?: AgentOutcomeView }

interface OutcomeAccumulator {
  returns: number[]
  alphas: number[]
  mfes: number[]
  maes: number[]
  directionHits: number
  directional: number
  alphaHits: number
  alphaEvaluated: number
  invalidations: number
  invalidationEligible: number
}

function emptyAccumulator(): OutcomeAccumulator {
  return {
    returns: [], alphas: [], mfes: [], maes: [],
    directionHits: 0, directional: 0, alphaHits: 0, alphaEvaluated: 0,
    invalidations: 0, invalidationEligible: 0,
  }
}

function accumulate(acc: OutcomeAccumulator, outcome: AgentOutcomeView): void {
  if (outcome.returnBp != null) acc.returns.push(outcome.returnBp)
  if (outcome.alphaBp != null) acc.alphas.push(outcome.alphaBp)
  if (outcome.maxFavorableBp != null) acc.mfes.push(outcome.maxFavorableBp)
  if (outcome.maxAdverseBp != null) acc.maes.push(outcome.maxAdverseBp)
  if (outcome.directionHit != null) {
    acc.directional += 1
    if (outcome.directionHit) acc.directionHits += 1
  }
  if (outcome.alphaHit != null) {
    acc.alphaEvaluated += 1
    if (outcome.alphaHit) acc.alphaHits += 1
  }
  if (outcome.invalidationHit != null) {
    acc.invalidationEligible += 1
    if (outcome.invalidationHit) acc.invalidations += 1
  }
}

function groupBuckets(
  rows: OutcomeStatRow[],
  keyOf: (row: OutcomeStatRow) => string,
  labelOf: (key: string) => string,
): AgentAccuracyBucket[] {
  const groups = new Map<string, OutcomeStatRow[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, group]) => {
      const acc = emptyAccumulator()
      for (const row of group) if (row.outcome) accumulate(acc, row.outcome)
      return {
        key,
        label: labelOf(key),
        evaluated: group.filter((row) => row.outcome).length,
        directionHitRate: rate(acc.directionHits, acc.directional),
        alphaHitRate: rate(acc.alphaHits, acc.alphaEvaluated),
        avgReturnBp: avg(acc.returns),
        avgAlphaBp: avg(acc.alphas),
      }
    })
}

function convictionBucket(conviction: number): string {
  if (conviction >= 85) return '85-100'
  if (conviction >= 70) return '70-84'
  if (conviction >= 50) return '50-69'
  return '0-49'
}

function flatForHorizon(rows: DecisionStatRow[], horizon: AgentHorizon): OutcomeStatRow[] {
  return rows
    .map((row) => ({ ...row, outcome: row.outcomes.find((outcome) => outcome.horizonDays === horizon) }))
    .filter((row) => Boolean(row.outcome))
}

function buildHorizonStats(rows: DecisionStatRow[], horizon: AgentHorizon): AgentHorizonAccuracy {
  const withOutcome = flatForHorizon(rows, horizon)
  const acc = emptyAccumulator()
  for (const row of withOutcome) if (row.outcome) accumulate(acc, row.outcome)
  const executedRows = withOutcome.filter((row) => row.status === 'executed')
  const executedAcc = emptyAccumulator()
  for (const row of executedRows) if (row.outcome) accumulate(executedAcc, row.outcome)
  return {
    horizonDays: horizon,
    outcomes: withOutcome.length,
    directional: acc.directional,
    directionHitRate: rate(acc.directionHits, acc.directional),
    alphaEvaluated: acc.alphaEvaluated,
    alphaHitRate: rate(acc.alphaHits, acc.alphaEvaluated),
    invalidationRate: rate(acc.invalidations, acc.invalidationEligible),
    avgReturnBp: avg(acc.returns),
    avgAlphaBp: avg(acc.alphas),
    avgMfeBp: avg(acc.mfes),
    avgMaeBp: avg(acc.maes),
    executed: {
      outcomes: executedRows.length,
      directionHitRate: rate(executedAcc.directionHits, executedAcc.directional),
      alphaHitRate: rate(executedAcc.alphaHits, executedAcc.alphaEvaluated),
      avgReturnBp: avg(executedAcc.returns),
      avgAlphaBp: avg(executedAcc.alphas),
    },
    byAction: groupBuckets(
      withOutcome,
      (row) => row.action,
      (key) => AGENT_ACTION_LABEL[key as AgentAction] ?? key,
    ),
    byConviction: groupBuckets(withOutcome, (row) => convictionBucket(row.conviction), (key) => key),
  }
}

async function resolveExperiment(experimentId?: string | null): Promise<PaperExperimentRow | null> {
  if (experimentId) return getPaperExperiment(experimentId)
  return getCurrentPaperExperiment()
}

async function loadCurve(accountId: string) {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT trade_date, total_equity_cents, daily_return_bp, drawdown_bp
          FROM paper_nav WHERE account_id = ?
          ORDER BY trade_date DESC LIMIT 120`,
    args: [accountId],
  })
  return r.rows.map((row) => ({
    date: str(row.trade_date),
    totalEquityCents: num(row.total_equity_cents),
    dailyReturnBp: maybeNum(row.daily_return_bp),
    drawdownBp: maybeNum(row.drawdown_bp),
  })).reverse()
}

export async function buildPaperAgentDashboard(input?: {
  experimentId?: string | null
}): Promise<AgentDashboard> {
  const now = new Date().toISOString()
  const experiment = await resolveExperiment(input?.experimentId)
  if (!experiment) {
    return {
      generatedAt: now,
      experiment: null,
      nav: null,
      counts: { runs: 0, failedRuns: 0, decisions: 0, executed: 0, evaluated: 0 },
      runs: [],
      stats: [1, 5, 20].map((h) => buildHorizonStats([], h as AgentHorizon)),
      recentDecisions: [],
      curve: [],
    }
  }
  const db = await getDb()
  const accounts = await listPaperAccounts(experiment.id)
  const user = accounts.find((account) => account.kind === 'user') ?? null

  const runsR = await db.execute({
    sql: `SELECT r.id, r.bars_date, r.plan_trade_date, r.status, r.trigger_source, r.model,
                 r.market_view, r.review, r.error_code, r.error_message, r.created_at, r.completed_at,
                 (SELECT COUNT(*) FROM paper_agent_decisions d WHERE d.run_id = r.id) AS decisions,
                 (SELECT COUNT(*) FROM paper_agent_decisions d WHERE d.run_id = r.id AND d.status = 'executed') AS executed
          FROM paper_agent_runs r WHERE r.experiment_id = ?
          ORDER BY r.bars_date DESC LIMIT ?`,
    args: [experiment.id, RUNS_SHOWN],
  })

  const decisionsR = await db.execute({
    sql: `SELECT d.id, d.run_id, d.decided_for_date, d.symbol_code, d.symbol_name, d.action, d.conviction,
                 d.thesis, d.evidence_json, d.counter_evidence_json, d.invalidation, d.planned_qty,
                 d.planned_price_cents, d.stop_price_cents, d.status, d.status_reason, d.position_qty_before,
                 o.status AS order_status, c.status AS card_status
          FROM paper_agent_decisions d
          LEFT JOIN paper_orders o ON o.id = d.order_id
          LEFT JOIN paper_decision_cards c ON c.id = d.card_id
          WHERE d.experiment_id = ?
          ORDER BY d.decided_for_date DESC, d.seq ASC
          LIMIT ?`,
    args: [experiment.id, MAX_STATS_DECISIONS],
  })
  const decisionIds = decisionsR.rows.map((row) => str(row.id))
  const outcomesByDecision = new Map<string, AgentOutcomeView[]>()
  if (decisionIds.length) {
    const outcomesR = await db.execute({
      sql: `SELECT decision_id, horizon_days, entry_date, evaluate_date, entry_price_cents, end_price_cents,
                   return_bp, benchmark_return_bp, alpha_bp, max_favorable_bp, max_adverse_bp,
                   direction_hit, alpha_hit, invalidation_hit, data_quality
            FROM paper_agent_outcomes
            WHERE decision_id IN (${decisionIds.map(() => '?').join(',')})
            ORDER BY horizon_days ASC`,
      args: decisionIds,
    })
    for (const row of outcomesR.rows) {
      const list = outcomesByDecision.get(str(row.decision_id)) ?? []
      list.push({
        horizonDays: num(row.horizon_days) as AgentHorizon,
        entryDate: str(row.entry_date) || null,
        evaluateDate: str(row.evaluate_date) || null,
        entryPriceCents: maybeNum(row.entry_price_cents),
        endPriceCents: maybeNum(row.end_price_cents),
        returnBp: maybeNum(row.return_bp),
        benchmarkReturnBp: maybeNum(row.benchmark_return_bp),
        alphaBp: maybeNum(row.alpha_bp),
        maxFavorableBp: maybeNum(row.max_favorable_bp),
        maxAdverseBp: maybeNum(row.max_adverse_bp),
        directionHit: maybeBool(row.direction_hit),
        alphaHit: maybeBool(row.alpha_hit),
        invalidationHit: maybeBool(row.invalidation_hit),
        dataQuality: str(row.data_quality) || 'pending',
      })
      outcomesByDecision.set(str(row.decision_id), list)
    }
  }

  const decisions: AgentDecisionView[] = decisionsR.rows.map((row) => {
    const action = str(row.action) as AgentAction
    return {
      id: str(row.id),
      runId: str(row.run_id),
      decidedForDate: str(row.decided_for_date),
      symbolCode: str(row.symbol_code),
      symbolName: str(row.symbol_name) || str(row.symbol_code),
      action,
      actionLabel: AGENT_ACTION_LABEL[action] ?? action,
      conviction: num(row.conviction),
      thesis: str(row.thesis),
      evidence: parseTexts(row.evidence_json),
      counterEvidence: parseTexts(row.counter_evidence_json),
      invalidation: str(row.invalidation),
      plannedQty: maybeNum(row.planned_qty),
      plannedPriceCents: maybeNum(row.planned_price_cents),
      stopPriceCents: maybeNum(row.stop_price_cents),
      status: str(row.status),
      statusReason: str(row.status_reason) || null,
      positionQtyBefore: num(row.position_qty_before),
      cardStatus: str(row.card_status) || null,
      orderStatus: str(row.order_status) || null,
      outcomes: outcomesByDecision.get(str(row.id)) ?? [],
    }
  })

  const statRows: DecisionStatRow[] = decisions.map((decision) => ({
    id: decision.id,
    action: decision.action,
    conviction: decision.conviction,
    status: decision.status,
    outcomes: decision.outcomes,
  }))

  const runs: AgentRunSummaryView[] = runsR.rows.map((row) => ({
    id: str(row.id),
    barsDate: str(row.bars_date),
    planTradeDate: str(row.plan_trade_date),
    status: str(row.status),
    triggerSource: str(row.trigger_source),
    model: str(row.model) || null,
    marketView: str(row.market_view) || null,
    review: str(row.review) || null,
    errorCode: str(row.error_code) || null,
    errorMessage: str(row.error_message) || null,
    decisions: num(row.decisions),
    executed: num(row.executed),
    createdAt: str(row.created_at),
    completedAt: str(row.completed_at) || null,
  }))

  let nav: AgentDashboard['nav'] = null
  let curve: AgentDashboard['curve'] = []
  let benchmarkReturnBp: number | null = null
  if (user) {
    try {
      const today = todayShanghai()
      const snapshot = await computePaperNav(user.id, today)
      const initial = experiment.initialCashCents
      nav = {
        totalEquityCents: snapshot.totalEquityCents,
        cashCents: snapshot.cashCents,
        marketValueCents: snapshot.marketValueCents,
        positionCount: snapshot.positions.filter((position) => position.totalQty > 0).length,
        returnBp: initial > 0 ? Math.round((snapshot.totalEquityCents - initial) * 10_000 / initial) : null,
        benchmarkReturnBp: null,
      }
      curve = await loadCurve(user.id)
    } catch {
      nav = null
    }
    const startDate = experiment.startedAt?.slice(0, 10)
      ?? curve[0]?.date
      ?? null
    if (startDate) {
      const startClose = await loadLatestClosePriceCents(experiment.benchmarkCode, startDate)
      const endClose = await loadLatestClosePriceCents(experiment.benchmarkCode, todayShanghai())
      if (startClose && endClose) {
        benchmarkReturnBp = Math.round((endClose - startClose) * 10_000 / startClose)
      }
    }
    if (nav) nav.benchmarkReturnBp = benchmarkReturnBp
  }

  const failedRuns = runs.filter((run) => run.status === 'failed').length
  const evaluated = decisions.filter((decision) => decision.outcomes.length > 0).length
  return {
    generatedAt: now,
    experiment: {
      id: experiment.id,
      name: experiment.name,
      status: experiment.status,
      benchmarkCode: experiment.benchmarkCode,
      initialCashCents: experiment.initialCashCents,
      startedAt: experiment.startedAt,
    },
    nav,
    counts: {
      runs: runs.length,
      failedRuns,
      decisions: decisions.length,
      executed: decisions.filter((decision) => decision.status === 'executed').length,
      evaluated,
    },
    runs,
    stats: [1, 5, 20].map((horizon) => buildHorizonStats(statRows, horizon as AgentHorizon)),
    recentDecisions: decisions.slice(0, DISPLAY_DECISIONS),
    curve,
  }
}

export interface AgentRunDetail {
  run: {
    id: string
    experimentId: string
    barsDate: string
    planTradeDate: string
    triggerSource: string
    status: string
    model: string | null
    promptVersion: string
    inputJson: string
    rawResponse: string | null
    marketView: string | null
    review: string | null
    usageJson: string | null
    errorCode: string | null
    errorMessage: string | null
    createdAt: string
    completedAt: string | null
  }
  attempts: Array<{
    attemptNo: number
    rawResponse: string | null
    errorMessage: string | null
    usageJson: string | null
    createdAt: string
  }>
  decisions: AgentDecisionView[]
  events: Array<{
    id: number
    decisionId: string | null
    kind: string
    message: string
    payload: string
    createdAt: string
  }>
  cards: Array<{
    id: string
    symbolCode: string
    status: string
    triggerPriceCents: number | null
    stopPriceCents: number | null
    maxLossCents: number | null
    confidenceScore: number
    expiresAt: string
  }>
  orders: Array<{
    id: string
    symbolCode: string
    side: string
    orderType: string
    qty: number
    triggerPriceCents: number | null
    status: string
    rejectCode: string | null
    fillPriceCents: number | null
    fillTradeDate: string | null
  }>
}

/** 单次运行的全量审计视图：模型输入、每次尝试、决策、事件与最终委托/成交。 */
export async function getPaperAgentRunDetail(runId: string): Promise<AgentRunDetail | null> {
  const db = await getDb()
  const runR = await db.execute({ sql: 'SELECT * FROM paper_agent_runs WHERE id = ?', args: [runId] })
  if (!runR.rows.length) return null
  const row = runR.rows[0]
  const experimentId = str(row.experiment_id)

  const [attemptsR, decisionsR, eventsR, cardsR] = await Promise.all([
    db.execute({
      sql: `SELECT attempt_no, raw_response, error_message, usage_json, created_at
            FROM paper_agent_attempts WHERE run_id = ? ORDER BY attempt_no ASC`,
      args: [runId],
    }),
    db.execute({
      sql: `SELECT d.id, d.run_id, d.decided_for_date, d.symbol_code, d.symbol_name, d.action, d.conviction,
                   d.thesis, d.evidence_json, d.counter_evidence_json, d.invalidation, d.planned_qty,
                   d.planned_price_cents, d.stop_price_cents, d.status, d.status_reason, d.position_qty_before,
                   o.status AS order_status, c.status AS card_status
            FROM paper_agent_decisions d
            LEFT JOIN paper_orders o ON o.id = d.order_id
            LEFT JOIN paper_decision_cards c ON c.id = d.card_id
            WHERE d.run_id = ? ORDER BY d.seq ASC`,
      args: [runId],
    }),
    db.execute({
      sql: `SELECT id, decision_id, kind, message, payload_json, created_at
            FROM paper_agent_events WHERE run_id = ? ORDER BY id ASC`,
      args: [runId],
    }),
    db.execute({
      sql: `SELECT c.id, c.symbol_code, c.status, c.trigger_price_cents, c.stop_price_cents,
                   c.max_loss_cents, c.confidence_score, c.expires_at
            FROM paper_decision_cards c
            WHERE c.id LIKE ? ORDER BY c.created_at ASC`,
      args: [`acard-${runId}-%`],
    }),
  ])

  const decisionIds = decisionsR.rows.map((decision) => str(decision.id))
  const outcomesByDecision = new Map<string, AgentOutcomeView[]>()
  if (decisionIds.length) {
    const outcomesR = await db.execute({
      sql: `SELECT decision_id, horizon_days, entry_date, evaluate_date, entry_price_cents, end_price_cents,
                   return_bp, benchmark_return_bp, alpha_bp, max_favorable_bp, max_adverse_bp,
                   direction_hit, alpha_hit, invalidation_hit, data_quality
            FROM paper_agent_outcomes
            WHERE decision_id IN (${decisionIds.map(() => '?').join(',')})
            ORDER BY horizon_days ASC`,
      args: decisionIds,
    })
    for (const outcome of outcomesR.rows) {
      const list = outcomesByDecision.get(str(outcome.decision_id)) ?? []
      list.push({
        horizonDays: num(outcome.horizon_days) as AgentHorizon,
        entryDate: str(outcome.entry_date) || null,
        evaluateDate: str(outcome.evaluate_date) || null,
        entryPriceCents: maybeNum(outcome.entry_price_cents),
        endPriceCents: maybeNum(outcome.end_price_cents),
        returnBp: maybeNum(outcome.return_bp),
        benchmarkReturnBp: maybeNum(outcome.benchmark_return_bp),
        alphaBp: maybeNum(outcome.alpha_bp),
        maxFavorableBp: maybeNum(outcome.max_favorable_bp),
        maxAdverseBp: maybeNum(outcome.max_adverse_bp),
        directionHit: maybeBool(outcome.direction_hit),
        alphaHit: maybeBool(outcome.alpha_hit),
        invalidationHit: maybeBool(outcome.invalidation_hit),
        dataQuality: str(outcome.data_quality) || 'pending',
      })
      outcomesByDecision.set(str(outcome.decision_id), list)
    }
  }

  const decisions: AgentDecisionView[] = decisionsR.rows.map((decision) => {
    const action = str(decision.action) as AgentAction
    return {
      id: str(decision.id),
      runId: str(decision.run_id),
      decidedForDate: str(decision.decided_for_date),
      symbolCode: str(decision.symbol_code),
      symbolName: str(decision.symbol_name) || str(decision.symbol_code),
      action,
      actionLabel: AGENT_ACTION_LABEL[action] ?? action,
      conviction: num(decision.conviction),
      thesis: str(decision.thesis),
      evidence: parseTexts(decision.evidence_json),
      counterEvidence: parseTexts(decision.counter_evidence_json),
      invalidation: str(decision.invalidation),
      plannedQty: maybeNum(decision.planned_qty),
      plannedPriceCents: maybeNum(decision.planned_price_cents),
      stopPriceCents: maybeNum(decision.stop_price_cents),
      status: str(decision.status),
      statusReason: str(decision.status_reason) || null,
      positionQtyBefore: num(decision.position_qty_before),
      cardStatus: str(decision.card_status) || null,
      orderStatus: str(decision.order_status) || null,
      outcomes: outcomesByDecision.get(str(decision.id)) ?? [],
    }
  })

  const ordersR = await db.execute({
    sql: `SELECT o.id, o.symbol_code, o.side, o.order_type, o.qty, o.trigger_price_cents, o.status,
                 o.reject_code, f.price_cents AS fill_price_cents, f.trade_date AS fill_trade_date
          FROM paper_orders o
          LEFT JOIN paper_fills f ON f.order_id = o.id
          WHERE o.client_request_id LIKE ? OR o.idempotency_key LIKE ?
          ORDER BY o.created_at ASC`,
    args: [`agent:adec-${runId}-%`, `agent:adec-${runId}-%`],
  })

  return {
    run: {
      id: str(row.id),
      experimentId,
      barsDate: str(row.bars_date),
      planTradeDate: str(row.plan_trade_date),
      triggerSource: str(row.trigger_source),
      status: str(row.status),
      model: str(row.model) || null,
      promptVersion: str(row.prompt_version),
      inputJson: str(row.input_json),
      rawResponse: str(row.raw_response) || null,
      marketView: str(row.market_view) || null,
      review: str(row.review) || null,
      usageJson: str(row.usage_json) || null,
      errorCode: str(row.error_code) || null,
      errorMessage: str(row.error_message) || null,
      createdAt: str(row.created_at),
      completedAt: str(row.completed_at) || null,
    },
    attempts: attemptsR.rows.map((attempt) => ({
      attemptNo: num(attempt.attempt_no),
      rawResponse: str(attempt.raw_response) || null,
      errorMessage: str(attempt.error_message) || null,
      usageJson: str(attempt.usage_json) || null,
      createdAt: str(attempt.created_at),
    })),
    decisions,
    events: eventsR.rows.map((event) => ({
      id: num(event.id),
      decisionId: str(event.decision_id) || null,
      kind: str(event.kind),
      message: str(event.message),
      payload: str(event.payload_json) || '{}',
      createdAt: str(event.created_at),
    })),
    cards: cardsR.rows.map((card) => ({
      id: str(card.id),
      symbolCode: str(card.symbol_code),
      status: str(card.status),
      triggerPriceCents: maybeNum(card.trigger_price_cents),
      stopPriceCents: maybeNum(card.stop_price_cents),
      maxLossCents: maybeNum(card.max_loss_cents),
      confidenceScore: num(card.confidence_score),
      expiresAt: str(card.expires_at),
    })),
    orders: ordersR.rows.map((order) => ({
      id: str(order.id),
      symbolCode: str(order.symbol_code),
      side: str(order.side),
      orderType: str(order.order_type),
      qty: num(order.qty),
      triggerPriceCents: maybeNum(order.trigger_price_cents),
      status: str(order.status),
      rejectCode: str(order.reject_code) || null,
      fillPriceCents: maybeNum(order.fill_price_cents),
      fillTradeDate: str(order.fill_trade_date) || null,
    })),
  }
}
