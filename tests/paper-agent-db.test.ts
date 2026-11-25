import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

/**
 * 战绩页的 SQL 聚合：真实 SQLite，验证运行/决策/结果三表 join 与 T+1/5 口径。
 * 不经过模型；只关心“落库的数据能不能被正确读回来”。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-agent-db-test-'))
const D1 = '2026-06-01'
const D2 = '2026-06-02'
const BENCH = 'H00300'
const INITIAL = 50_000_000
const NOW = `${D1}T08:00:00.000Z`
const RUN1 = `arun-e1-${D1}`
const RUN2 = `arun-e1-2026-05-29`

let db: any
let experimentId = ''
let accountId = ''

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = path.join(dir, 'agent-db.db')
  vi.resetModules()
  const dbMod = await import('../lib/db')
  db = await dbMod.getDb()
  const repo = await import('../lib/paper/repo')
  const created = await repo.createPaperExperiment({
    name: 'Agent 战绩测试',
    protocolVersion: 'v1',
    benchmarkCode: BENCH,
    initialCashCents: INITIAL,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: `${D1}T00:00:00.000Z`,
    now: NOW,
  })
  experimentId = created.experiment.id
  accountId = created.accounts.find((account) => account.kind === 'user')!.id

  await db.execute({
    sql: `INSERT INTO paper_agent_runs
      (id, experiment_id, account_id, bars_date, plan_trade_date, trigger_source, status, model,
       prompt_version, input_json, raw_response, market_view, review, decisions_json, usage_json,
       error_code, error_message, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, 'scheduled', 'planned', 'deepseek-chat', 'paper-agent-v1',
        ?, ?, '震荡偏强', '上一期判断基本兑现', '[]', '{}', NULL, NULL, ?, ?)`,
    args: [RUN1, experimentId, accountId, D1, D2, '{"market":{"gateRiskOff":false}}', '{"marketView":"震荡偏强"}', NOW, NOW],
  })
  await db.execute({
    sql: `INSERT INTO paper_agent_runs
      (id, experiment_id, account_id, bars_date, plan_trade_date, trigger_source, status, model,
       prompt_version, input_json, raw_response, error_code, error_message, created_at)
      VALUES (?, ?, ?, '2026-05-29', ?, 'scheduled', 'failed', NULL, 'paper-agent-v1', '{}', NULL,
        'LLM_NOT_CONFIGURED', '缺少 API key', ?)`,
    args: [RUN2, experimentId, accountId, D1, NOW],
  })

  const decisions = [
    {
      id: `adec-${RUN1}-1`, seq: 1, symbol: '600000.SH', name: '浦发银行', action: 'buy', conviction: 90,
      plannedQty: 8_300, price: 1_200, stop: 1_100, positionBefore: 0, status: 'executed',
    },
    {
      id: `adec-${RUN1}-2`, seq: 2, symbol: '000001.SZ', name: '平安银行', action: 'avoid', conviction: 60,
      plannedQty: null, price: null, stop: null, positionBefore: 0, status: 'noted',
    },
  ]
  for (const decision of decisions) {
    await db.execute({
      sql: `INSERT INTO paper_agent_decisions
        (id, run_id, experiment_id, account_id, seq, symbol_code, symbol_name, action, conviction, thesis,
         evidence_json, counter_evidence_json, invalidation, planned_qty, planned_price_cents,
         stop_price_cents, position_qty_before, card_id, order_id, status, status_reason,
         decided_for_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '测试逻辑', '["证据一","证据二"]', '["反证一"]',
          '跌破止损', ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?)`,
      args: [
        decision.id, RUN1, experimentId, accountId, decision.seq, decision.symbol, decision.name,
        decision.action, decision.conviction, decision.plannedQty, decision.price, decision.stop,
        decision.positionBefore, decision.status, D2, NOW, NOW,
      ],
    })
  }

  const outcomes = [
    // 买入看多：T+1 上涨且跑赢基准；T+5 回落且跑输基准。
    [`adec-${RUN1}-1`, 1, 1_000, 200, 800, 1, 1],
    [`adec-${RUN1}-1`, 5, -200, 100, -300, 0, 0],
    // 回避看空：下跌且跑赢基准。
    [`adec-${RUN1}-2`, 1, -1_000, -100, -900, 1, 1],
  ] as const
  for (const [decisionId, horizon, returnBp, benchBp, alphaBp, directionHit, alphaHit] of outcomes) {
    await db.execute({
      sql: `INSERT INTO paper_agent_outcomes
        (decision_id, horizon_days, entry_date, evaluate_date, entry_price_cents, end_price_cents,
         return_bp, benchmark_return_bp, alpha_bp, max_favorable_bp, max_adverse_bp,
         direction_hit, alpha_hit, invalidation_hit, data_quality, notes, evaluated_at)
        VALUES (?, ?, ?, ?, 1000, 1100, ?, ?, ?, 1200, -400, ?, ?, NULL, 'pass', 'test', ?)`,
      args: [decisionId, horizon, D2, '2026-06-04', returnBp, benchBp, alphaBp, directionHit, alphaHit, NOW],
    })
  }

  await db.execute({
    sql: `INSERT INTO paper_agent_attempts (run_id, attempt_no, raw_response, error_message, usage_json, created_at)
          VALUES (?, 1, '{"marketView":"震荡偏强"}', NULL, '{"total_tokens":100}', ?)`,
    args: [RUN1, NOW],
  })
  await db.execute({
    sql: `INSERT INTO paper_agent_events (run_id, decision_id, kind, message, payload_json, created_at)
          VALUES (?, NULL, 'planned', '计划已落库', '{}', ?)`,
    args: [RUN1, NOW],
  })
})

afterAll(async () => {
  try {
    await db?.close?.()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('buildPaperAgentDashboard', () => {
  it('按 T+1/T+5 聚合方向与 alpha，未参与方向统计的结果不进分母', async () => {
    const { buildPaperAgentDashboard } = await import('../lib/paper/agent-stats')
    const dashboard = await buildPaperAgentDashboard({ experimentId })

    expect(dashboard.experiment?.id).toBe(experimentId)
    expect(dashboard.counts).toEqual({ runs: 2, failedRuns: 1, decisions: 2, executed: 1, evaluated: 2 })

    const t1 = dashboard.stats.find((stat) => stat.horizonDays === 1)!
    expect(t1).toMatchObject({
      outcomes: 2,
      directional: 2,
      directionHitRate: 100,
      alphaEvaluated: 2,
      alphaHitRate: 100,
      avgReturnBp: 0,
      avgAlphaBp: -50,
    })
    expect(t1.executed).toMatchObject({
      outcomes: 1,
      directionHitRate: 100,
      avgAlphaBp: 800,
    })
    expect(t1.byAction.map((bucket) => bucket.key)).toEqual(['avoid', 'buy'])
    expect(t1.byConviction.map((bucket) => bucket.key)).toEqual(['50-69', '85-100'])

    const t5 = dashboard.stats.find((stat) => stat.horizonDays === 5)!
    expect(t5).toMatchObject({ outcomes: 1, directionHitRate: 0, alphaHitRate: 0, avgAlphaBp: -300 })

    const t20 = dashboard.stats.find((stat) => stat.horizonDays === 20)!
    expect(t20.outcomes).toBe(0)
    expect(t20.directionHitRate).toBeNull()
  })

  it('运行记录带失败原因，决策按日期与序号回溯', async () => {
    const { buildPaperAgentDashboard } = await import('../lib/paper/agent-stats')
    const dashboard = await buildPaperAgentDashboard({ experimentId })

    expect(dashboard.runs.map((run) => run.id)).toEqual([RUN1, RUN2])
    expect(dashboard.runs[1]).toMatchObject({ status: 'failed', errorCode: 'LLM_NOT_CONFIGURED' })

    expect(dashboard.recentDecisions.map((decision) => decision.id))
      .toEqual([`adec-${RUN1}-1`, `adec-${RUN1}-2`])
    expect(dashboard.recentDecisions[0]).toMatchObject({
      actionLabel: '买入',
      status: 'executed',
      conviction: 90,
      evidence: ['证据一', '证据二'],
      counterEvidence: ['反证一'],
    })
    expect(dashboard.recentDecisions[0].outcomes.map((outcome) => outcome.horizonDays)).toEqual([1, 5])
  })
})

describe('getPaperAgentRunDetail', () => {
  it('返回完整审计：输入、尝试、决策与事件', async () => {
    const { getPaperAgentRunDetail } = await import('../lib/paper/agent-stats')
    const detail = await getPaperAgentRunDetail(RUN1)

    expect(detail).not.toBeNull()
    expect(detail!.run).toMatchObject({
      id: RUN1,
      status: 'planned',
      model: 'deepseek-chat',
      marketView: '震荡偏强',
      review: '上一期判断基本兑现',
      inputJson: '{"market":{"gateRiskOff":false}}',
    })
    expect(detail!.attempts).toHaveLength(1)
    expect(detail!.attempts[0]).toMatchObject({ attemptNo: 1, errorMessage: null })
    expect(detail!.decisions).toHaveLength(2)
    expect(detail!.events).toHaveLength(1)
    expect(detail!.events[0].message).toBe('计划已落库')
    expect(detail!.cards).toEqual([])
    expect(detail!.orders).toEqual([])
  })

  it('不存在的运行返回 null', async () => {
    const { getPaperAgentRunDetail } = await import('../lib/paper/agent-stats')
    expect(await getPaperAgentRunDetail('arun-missing')).toBeNull()
  })
})
