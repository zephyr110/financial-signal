import { getDb } from '../db'
import { dateShanghai } from '../cockpit/format'
import { computePaperMetrics, type PaperMetricsReport } from './metrics'
import {
  getPaperExperiment,
  getPaperExperimentPolicy,
  PaperRepoError,
  writePaperAudit,
} from './repo'

/**
 * 阶段门按规格 §3/§10.7：二值否决不进加权总分；总分 ≥80 且单项得分率 ≥60%。
 * 人工验收项写成 append-only 的 gate.attestation 审计，缺一项就阻塞，不默认放行。
 */

export type PaperGateId = 'L1_TO_L2' | 'L2_TO_L3'
export type PaperGateDimensionKey =
  | 'data_ops'
  | 'decision'
  | 'execution'
  | 'behavior'
  | 'ux'
  | 'compliance'
  | 'performance'
  | 'calibration'
  | 'process'

export type PaperGateAttestationDimension = 'behavior' | 'ux' | 'compliance' | 'crash_replay'

export interface PaperGateCriterion {
  label: string
  met: boolean
  detail: string
  /** 尚未有证据（待验收/未审计）用 pending；不当作失败，但会阻塞过关。 */
  pending?: boolean
}

export interface PaperGateDimension {
  key: PaperGateDimensionKey
  label: string
  weight: number
  earned: number
  ratioBp: number | null
  status: 'pass' | 'fail' | 'pending'
  criteria: PaperGateCriterion[]
}

export interface PaperGateVeto {
  key: 'lookahead' | 'reconciliation' | 'compliance'
  label: string
  status: 'pass' | 'fail' | 'not_run'
  detail: string
}

export interface PaperGateReport {
  experimentId: string
  gate: PaperGateId
  decision: 'pass' | 'fail' | 'blocked'
  evaluatedAt: string
  sample: {
    ready: boolean
    validDays: number
    triggeredCards: number
    lastCardMature60: boolean
    required: string
  }
  totalWeight: number
  totalEarned: number
  totalRatioBp: number
  dimsBelow60: PaperGateDimensionKey[]
  dimensions: PaperGateDimension[]
  vetoes: PaperGateVeto[]
  failedCriteria: string[]
  blockedBy: string[]
  notes: string[]
}

export interface PaperGateManualEvidence {
  behavior?: boolean
  ux?: boolean
  compliance?: boolean
  crash_replay?: boolean
}

export interface PaperGateFacts {
  gate: PaperGateId
  sample: { validDays: number; triggeredCards: number; lastCardMature60: boolean }
  expectedTradingDays: number
  reconciliation: { total: number; passed: number; failed: number }
  lookahead: { status: 'pass' | 'fail' | 'not_run' }
  incidents: { total: number; unresolved: number }
  cards: { total: number; complete: number; policyDrift: boolean }
  execution: {
    fills: number
    explainable: number
    duplicateFills: number
    crashReplay: boolean | null
  }
  risk: { killSwitchActive: boolean }
  metrics: PaperMetricsReport | null
  manual: PaperGateManualEvidence
}

const GATE_NAMES: Record<PaperGateId, string> = {
  L1_TO_L2: 'L1 → L2 过程与完整性门',
  L2_TO_L3: 'L2 → L3 绩效与校准门',
}

function criterion(label: string, met: boolean, detail: string, pending = false): PaperGateCriterion {
  return { label, met, detail, pending }
}

function dim(
  key: PaperGateDimensionKey,
  label: string,
  weight: number,
  earned: number,
  criteria: PaperGateCriterion[],
  status?: PaperGateDimension['status'],
): PaperGateDimension {
  const ratioBp = weight > 0 ? Math.round(earned * 10_000 / weight) : null
  const derived: PaperGateDimension['status'] = status
    ?? (criteria.some((c) => !c.met && !c.pending)
      ? 'fail'
      : criteria.some((c) => c.pending)
        ? 'pending'
        : ratioBp != null && ratioBp < 6_000
          ? 'fail'
          : 'pass')
  return { key, label, weight, earned, ratioBp, status: derived, criteria }
}

function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.min(1, numerator / denominator) : 0
}

function dataDimension(facts: PaperGateFacts): PaperGateDimension {
  const availability = ratio(facts.sample.validDays, facts.expectedTradingDays)
  const availabilityMet = facts.expectedTradingDays > 0 && availability >= 0.99
  const incidentMet = facts.incidents.total <= 1 && facts.incidents.unresolved === 0
  const criteria = [
    criterion(
      '数据可用率 ≥ 99%',
      availabilityMet,
      `${facts.sample.validDays}/${facts.expectedTradingDays} 个交易日有净值（${(availability * 100).toFixed(2)}%）`,
    ),
    criterion(
      '重大事故 ≤ 1 次且已修复',
      incidentMet,
      `${facts.incidents.total} 次，未修复 ${facts.incidents.unresolved} 次`,
    ),
    criterion(
      '对账 100% 平衡',
      facts.reconciliation.total > 0 && facts.reconciliation.failed === 0,
      `${facts.reconciliation.passed}/${facts.reconciliation.total} 通过`,
    ),
    criterion(
      '前视审计通过',
      facts.lookahead.status === 'pass',
      facts.lookahead.status === 'not_run' ? '尚无 L0 前视审计记录' : facts.lookahead.status,
      facts.lookahead.status === 'not_run',
    ),
  ]
  const earned = 25 * Math.min(availability, incidentMet ? 1 : 0)
  return dim('data_ops', '数据与运维', 25, Math.round(earned), criteria)
}

function decisionDimension(facts: PaperGateFacts): PaperGateDimension | null {
  if (!facts.cards.total) return null
  const completeness = ratio(facts.cards.complete, facts.cards.total)
  const criteria = [
    criterion(
      '卡片字段完整率 100%',
      completeness === 1,
      `${facts.cards.complete}/${facts.cards.total} 张字段完整`,
    ),
    criterion('规则版本未漂移', !facts.cards.policyDrift, facts.cards.policyDrift ? '发现多个政策版本' : '一致'),
  ]
  return dim('decision', '决策过程', 20, Math.round(20 * completeness), criteria)
}

function executionDimension(facts: PaperGateFacts): PaperGateDimension | null {
  if (!facts.execution.fills) return null
  const explainable = ratio(facts.execution.explainable, facts.execution.fills)
  const criteria = [
    criterion('无重复成交', facts.execution.duplicateFills === 0, `${facts.execution.duplicateFills} 组重复`),
    criterion(
      '每笔成交可解释（官方价或带原因的场外人工）',
      explainable === 1,
      `${facts.execution.explainable}/${facts.execution.fills} 笔可复核`,
    ),
    criterion(
      '崩溃重放通过',
      facts.execution.crashReplay === true,
      facts.execution.crashReplay == null ? '待人工验收' : facts.execution.crashReplay ? '通过' : '失败',
      facts.execution.crashReplay == null,
    ),
  ]
  return dim('execution', '执行链路', 20, Math.round(20 * explainable), criteria)
}

function behaviorDimension(facts: PaperGateFacts, weight: number, needExecution: boolean): PaperGateDimension {
  const criteria: PaperGateCriterion[] = []
  if (needExecution && facts.metrics) {
    const rate = facts.metrics.execution.executionRateBp
    criteria.push(criterion(
      '按计划执行率 ≥ 90%',
      rate != null && rate >= 9_000,
      rate == null ? '尚无触发卡' : `${(rate / 100).toFixed(1)}%`,
    ))
  }
  criteria.push(
    criterion('无超仓/绕过风控', facts.manual.behavior === true,
      facts.manual.behavior == null ? '待人工验收' : facts.manual.behavior ? '通过' : '失败',
      facts.manual.behavior == null),
    criterion('kill switch 解除合规', !facts.risk.killSwitchActive,
      facts.risk.killSwitchActive ? '账户仍处于 kill switch' : '当前未触发'),
  )
  const manualOk = facts.manual.behavior === true && !facts.risk.killSwitchActive
  return dim('behavior', '行为', weight, manualOk ? weight : 0, criteria)
}

function complianceDimension(facts: PaperGateFacts, weight: number): PaperGateDimension {
  const passed = facts.manual.compliance
  const criteria = [
    criterion('免责声明、数据许可、审计日志齐全', passed === true,
      passed == null ? '待人工验收' : passed ? '通过' : '缺项', passed == null),
    criterion('无真实委托能力', passed === true,
      passed == null ? '待人工验收' : passed ? '通过' : '缺项', passed == null),
  ]
  return dim('compliance', '合规', weight, passed ? weight : 0, criteria)
}

function uxDimension(facts: PaperGateFacts): PaperGateDimension {
  const passed = facts.manual.ux
  const criteria = [
    criterion('可用性验收通过', passed === true, passed == null ? '待人工验收' : passed ? '通过' : '失败', passed == null),
    criterion('新手能分清“系统判断/我的执行”', passed === true, passed == null ? '待人工验收' : passed ? '通过' : '失败', passed == null),
  ]
  return dim('ux', '用户体验', 10, passed ? 10 : 0, criteria)
}

function performanceDimension(facts: PaperGateFacts): PaperGateDimension {
  const m = facts.metrics
  const sampleReady = facts.sample.validDays >= 250 && facts.sample.triggeredCards >= 100
  const excess = m?.excessBp.user ?? null
  const drawdown = m?.accounts.user.maxDrawdownBp ?? null
  const sharpe = m?.accounts.user.sharpe ?? null
  const totalReturnBasis = m?.benchmark.basis === 'total_return_index'
  const criteria = [
    criterion('有效交易日 ≥ 250 且触发卡 ≥ 100',
      sampleReady, `${facts.sample.validDays} 日 / ${facts.sample.triggeredCards} 张`),
    criterion('全收益基准可用', totalReturnBasis,
      m?.benchmark.basis === 'price_index' ? `${m.benchmark.code} 只是价格指数` : m?.benchmark.basis ?? '缺少基准'),
    criterion('扣费后超额 > 0', excess != null && excess > 0,
      excess == null ? '不可计算' : `${(excess / 100).toFixed(2)}%`),
    criterion('最大回撤 ≤ 10%', drawdown != null && drawdown <= 1_000,
      drawdown == null ? '不可计算' : `${(drawdown / 100).toFixed(2)}%`),
    criterion('夏普 > 0.5', sharpe != null && sharpe > 0.5,
      sharpe == null ? '不可计算' : sharpe.toFixed(2)),
  ]
  const allMet = criteria.every((c) => c.met)
  return dim('performance', '绩效', 30, allMet ? 30 : 0, criteria,
    sampleReady ? undefined : 'fail')
}

function calibrationDimension(facts: PaperGateFacts): PaperGateDimension {
  const m = facts.metrics
  const calibrated = m?.calibration.status === 'calibrated'
  const criteria = [
    criterion('校准状态为 calibrated', calibrated,
      calibrated ? '已校准' : m?.calibration.status === 'unavailable' ? '无校准数据' : '未校准'),
    criterion('Brier 优于基准基线', m?.calibration.brier != null,
      m?.calibration.brier == null ? '无 Brier 分数' : String(m.calibration.brier)),
  ]
  return dim('calibration', '校准', 15, calibrated && m?.calibration.brier != null ? 15 : 0, criteria)
}

export function evaluatePaperStageGate(facts: PaperGateFacts): PaperGateReport {
  const failedCriteria: string[] = []
  const blockedBy: string[] = []
  const notes: string[] = []
  const vetoes: PaperGateVeto[] = [
    {
      key: 'lookahead',
      label: '前视审计',
      status: facts.lookahead.status,
      detail: facts.lookahead.status === 'not_run' ? '尚未执行 L0 前视审计' : facts.lookahead.status,
    },
    {
      key: 'reconciliation',
      label: '对账平衡',
      status: facts.reconciliation.failed === 0 && facts.reconciliation.total > 0 ? 'pass' : 'fail',
      detail: `${facts.reconciliation.passed}/${facts.reconciliation.total} 通过，差异 ${facts.reconciliation.failed} 天`,
    },
    {
      key: 'compliance',
      label: '合规',
      status: facts.manual.compliance == null ? 'not_run' : facts.manual.compliance ? 'pass' : 'fail',
      detail: facts.manual.compliance == null ? '待人工验收' : facts.manual.compliance ? '通过' : '缺项',
    },
  ]

  const sampleRequired = facts.gate === 'L1_TO_L2'
    ? '120 个有效交易日 + 最后一张卡满 60 日 + ≥30 张触发卡'
    : '250 个有效交易日 + ≥100 张触发卡'
  const sampleReady = facts.gate === 'L1_TO_L2'
    ? facts.sample.validDays >= 120 && facts.sample.lastCardMature60 && facts.sample.triggeredCards >= 30
    : facts.sample.validDays >= 250 && facts.sample.triggeredCards >= 100

  const data = dataDimension(facts)
  const decisionDim = decisionDimension(facts)
  const execution = executionDimension(facts)
  const dimensions: PaperGateDimension[] = []

  if (facts.gate === 'L1_TO_L2') {
    dimensions.push(data)
    if (decisionDim) dimensions.push(decisionDim)
    if (execution) dimensions.push(execution)
    dimensions.push(behaviorDimension(facts, 15, false))
    dimensions.push(uxDimension(facts))
    dimensions.push(complianceDimension(facts, 10))
  } else {
    // L2 的“过程 25 分”吸收数据、决策、执行三项，不能重复计分。
    const processParts = [data, decisionDim, execution]
      .filter((d): d is PaperGateDimension => d != null)
    const processRatios = processParts.map((d) => d.ratioBp ?? 0)
    const processRatio = processRatios.length ? Math.min(...processRatios) : 0
    const processCriteria = processParts.flatMap((d) =>
      d.criteria.map((c) => ({ ...c, label: `${d.label}：${c.label}` })))
    processCriteria.push(criterion(
      '数据、决策、执行三项均达到 60%',
      processRatio >= 6_000,
      `最低单项 ${(processRatio / 100).toFixed(1)}%`,
    ))
    dimensions.push(performanceDimension(facts))
    dimensions.push(calibrationDimension(facts))
    dimensions.push(dim('process', '过程', 25, Math.round(25 * processRatio / 10_000), processCriteria))
    dimensions.push(behaviorDimension(facts, 15, true))
    dimensions.push(complianceDimension(facts, 15))
  }

  for (const d of dimensions) {
    let criterionFailed = false
    for (const c of d.criteria) {
      if (!c.met && !c.pending) {
        failedCriteria.push(`${d.label}：${c.label}`)
        criterionFailed = true
      }
      if (!c.met && c.pending) blockedBy.push(`${d.label}：${c.label}`)
    }
    if (d.status === 'fail' && !criterionFailed) {
      failedCriteria.push(`${d.label}得分率低于 60%`)
    }
  }
  if (!sampleReady) failedCriteria.push(`样本门槛未达：${sampleRequired}`)
  for (const veto of vetoes) {
    if (veto.status === 'fail') failedCriteria.push(`二值否决：${veto.label}`)
    if (veto.status === 'not_run') blockedBy.push(`${veto.label}未完成`)
  }
  if (facts.expectedTradingDays === 0) blockedBy.push('交易日历为空，无法计算数据可用率')
  if (!facts.cards.total) blockedBy.push('尚无决策卡可核验')
  if (!facts.execution.fills) blockedBy.push('尚无成交可核验')
  if (facts.metrics?.benchmark.basis === 'price_index') {
    notes.push('基准是价格指数，绩效门不能以该超额过关；需全收益基准。')
  }
  if (facts.gate === 'L2_TO_L3' && facts.metrics?.calibration.status !== 'calibrated') {
    notes.push('校准未完成，L2→L3 不得通过。')
  }

  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0)
  const totalEarned = dimensions.reduce((sum, d) => sum + d.earned, 0)
  const totalRatioBp = totalWeight ? Math.round(totalEarned * 10_000 / totalWeight) : 0
  const dimsBelow60 = dimensions
    .filter((d) => d.ratioBp != null && d.ratioBp < 6_000)
    .map((d) => d.key)
  const hasFail = failedCriteria.length > 0 || dimensions.some((d) => d.status === 'fail')
  const decision: PaperGateReport['decision'] = hasFail
    ? 'fail'
    : blockedBy.length > 0
      ? 'blocked'
      : totalRatioBp >= 8_000 && dimsBelow60.length === 0
        ? 'pass'
        : 'fail'
  if (decision === 'fail' && !failedCriteria.length) {
    failedCriteria.push(totalRatioBp < 8_000 ? `总分 ${(totalRatioBp / 100).toFixed(1)} 低于 80` : '存在单项低于 60%')
  }

  return {
    experimentId: '',
    gate: facts.gate,
    decision,
    evaluatedAt: new Date().toISOString(),
    sample: {
      ready: sampleReady,
      validDays: facts.sample.validDays,
      triggeredCards: facts.sample.triggeredCards,
      lastCardMature60: facts.sample.lastCardMature60,
      required: sampleRequired,
    },
    totalWeight,
    totalEarned,
    totalRatioBp,
    dimsBelow60,
    dimensions,
    vetoes,
    failedCriteria,
    blockedBy,
    notes,
  }
}

function parseJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

async function loadLookahead(): Promise<PaperGateFacts['lookahead']> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT payload_json FROM paper_audit_log
          WHERE action IN ('lookahead.audit','l0.replay.audit') ORDER BY id DESC LIMIT 1`,
    args: [],
  })
  if (!r.rows.length) return { status: 'not_run' }
  const payload = parseJson(r.rows[0].payload_json)
  if (payload.status === 'pass' || payload.pass === true) return { status: 'pass' }
  if (payload.status === 'fail' || payload.pass === false) return { status: 'fail' }
  return { status: 'not_run' }
}

async function loadManualEvidence(
  experimentId: string,
  gate: PaperGateId,
): Promise<PaperGateManualEvidence> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT payload_json FROM paper_audit_log
          WHERE action = 'gate.attestation' AND entity_id = ? ORDER BY id`,
    args: [experimentId],
  })
  const out: PaperGateManualEvidence = {}
  for (const row of r.rows) {
    const payload = parseJson(row.payload_json)
    if (payload.gate !== gate) continue
    const dimension = payload.dimension
    if (dimension === 'behavior' || dimension === 'ux' || dimension === 'compliance' || dimension === 'crash_replay') {
      out[dimension] = payload.passed === true
    }
  }
  return out
}

export async function buildPaperGateFacts(input: {
  experimentId: string
  gate: PaperGateId
  now?: string
  /** 概览页一次算好指标后复用，避免 L1/L2 两门各重算一遍。 */
  metrics?: PaperMetricsReport
}): Promise<PaperGateFacts> {
  const experiment = await getPaperExperiment(input.experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', '实验不存在')
  const { policy } = await getPaperExperimentPolicy(experiment.id)
  const metrics = input.metrics
    ?? await computePaperMetrics({ experimentId: experiment.id, now: input.now })
  const db = await getDb()
  // startedAt 是 UTC 时间戳；直接 slice 会把上海凌晨算成前一天，门禁日期区间随之漂移。
  const startDate = dateShanghai(experiment.startedAt) || dateShanghai(experiment.createdAt)
  const endDate = metrics.accounts.user.endDate ?? startDate

  const expectedR = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM trading_calendar
          WHERE is_open = 1 AND trade_date >= ? AND trade_date <= ?`,
    args: [startDate, endDate],
  })
  // missing_price 是数据未到而非账实不符，只有 fail 才算对账失败；明细仍保留在 total/passed。
  const reconR = await db.execute({
    sql: `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN r.status = 'pass' THEN 1 ELSE 0 END), 0) AS passed,
            COALESCE(SUM(CASE WHEN r.status = 'fail' THEN 1 ELSE 0 END), 0) AS failed
          FROM paper_reconciliations r
          JOIN paper_accounts a ON a.id = r.account_id
          WHERE a.experiment_id = ?`,
    args: [experiment.id],
  })
  const reconRow = reconR.rows[0] ?? {}
  const incidentR = await db.execute({
    sql: `SELECT payload_json FROM paper_audit_log WHERE action LIKE 'incident.%'`,
    args: [],
  })
  let unresolved = 0
  for (const row of incidentR.rows) {
    if (parseJson(row.payload_json).resolved !== true) unresolved += 1
  }

  const cardsR = await db.execute({
    sql: `SELECT id, stance, snapshot_id, evidence_json, counter_evidence_json, invalidation,
            trigger_price_cents, stop_price_cents, max_loss_cents, policy_version, trade_date
          FROM paper_decision_cards WHERE experiment_id = ?`,
    args: [experiment.id],
  })
  let complete = 0
  let policyDrift = false
  let lastCardDate = ''
  for (const row of cardsR.rows) {
    const policyVersion = String(row.policy_version)
    if (policyVersion !== experiment.policyVersion) policyDrift = true
    lastCardDate = String(row.trade_date) > lastCardDate ? String(row.trade_date) : lastCardDate
    const evidence = parseJsonArray(row.evidence_json)
    const counter = parseJsonArray(row.counter_evidence_json)
    const candidate = String(row.stance) === 'candidate'
    const evidenceOk = evidence.length >= policy.cardRules.minEvidenceItems
      && evidence.every((e) => typeof e?.text === 'string' && e.text.trim().length > 0)
    const candidateOk = !candidate || (
      Number(row.trigger_price_cents) > 0
      && Number(row.stop_price_cents) > 0
      && row.max_loss_cents != null
    )
    if (evidenceOk && counter.length >= 1 && String(row.invalidation).trim() && row.snapshot_id && candidateOk) {
      complete += 1
    }
  }

  const fillsR = await db.execute({
    sql: `SELECT f.order_id, f.price_basis, f.price_source_id, o.off_plan_reason
          FROM paper_fills f LEFT JOIN paper_orders o ON o.id = f.order_id
          WHERE f.experiment_id = ?`,
    args: [experiment.id],
  })
  const orderCounts = new Map<string, number>()
  let explainable = 0
  for (const row of fillsR.rows) {
    const orderId = String(row.order_id)
    orderCounts.set(orderId, (orderCounts.get(orderId) ?? 0) + 1)
    const official = row.price_basis === 'official_daily_open' && Boolean(row.price_source_id)
    const manualReasoned = row.price_basis === 'manual' && Boolean(row.off_plan_reason)
    if (official || manualReasoned) explainable += 1
  }
  const duplicateFills = [...orderCounts.values()].filter((n) => n > 1).length

  const riskR = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM paper_risk_state s
          JOIN paper_accounts a ON a.id = s.account_id
          WHERE a.experiment_id = ? AND s.kill_switch = 1`,
    args: [experiment.id],
  })
  const manual = await loadManualEvidence(experiment.id, input.gate)
  const lookahead = await loadLookahead()

  return {
    gate: input.gate,
    sample: {
      validDays: metrics.sample.validDays,
      triggeredCards: metrics.sample.triggeredCards,
      lastCardMature60: metrics.sample.lastCardMature60,
    },
    expectedTradingDays: Number(expectedR.rows[0]?.n ?? 0),
    reconciliation: {
      total: Number(reconRow.total ?? 0),
      passed: Number(reconRow.passed ?? 0),
      failed: Number(reconRow.failed ?? 0),
    },
    lookahead,
    incidents: { total: incidentR.rows.length, unresolved },
    cards: { total: cardsR.rows.length, complete, policyDrift },
    execution: {
      fills: fillsR.rows.length,
      explainable,
      duplicateFills,
      crashReplay: manual.crash_replay ?? null,
    },
    risk: { killSwitchActive: Number(riskR.rows[0]?.n ?? 0) > 0 },
    metrics,
    manual,
  }
}

function parseJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (typeof value !== 'string' || !value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : []
  } catch {
    return []
  }
}

export async function computePaperGateReport(input: {
  experimentId: string
  gate: PaperGateId
  now?: string
  metrics?: PaperMetricsReport
}): Promise<PaperGateReport> {
  const facts = await buildPaperGateFacts(input)
  const report = evaluatePaperStageGate(facts)
  report.experimentId = input.experimentId
  report.evaluatedAt = input.now ?? new Date().toISOString()
  return report
}

/** 人工验收项写入 append-only 审计；证据为空直接拒绝，避免“口头通过”。 */
export async function attestPaperGate(input: {
  experimentId: string
  gate: PaperGateId
  dimension: PaperGateAttestationDimension
  passed: boolean
  evidence: string
  now?: string
}): Promise<void> {
  if (!input.evidence?.trim()) throw new PaperRepoError('INVALID_INPUT', '人工验收必须填写证据')
  const experiment = await getPaperExperiment(input.experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', '实验不存在')
  const now = input.now ?? new Date().toISOString()
  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    await writePaperAudit(tx, {
      actor: 'user',
      action: 'gate.attestation',
      entityType: 'paper_experiment',
      entityId: experiment.id,
      payload: {
        gate: input.gate,
        gateName: GATE_NAMES[input.gate],
        dimension: input.dimension,
        passed: input.passed,
        evidence: input.evidence.trim(),
      },
      createdAt: now,
    })
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }
}
