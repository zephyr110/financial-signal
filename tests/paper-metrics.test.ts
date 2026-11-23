import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

/**
 * 指标口径：净值收益、全收益基准识别、等权再平衡成本、执行率与 cohort。
 * 样本不足时命中率/alpha 必须为 null，只保留计数。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-metrics-test-'))
const START = '2026-05-01T00:00:00.000Z'
const END = '2026-06-12'
const BENCH = 'H00300'
const SYMBOL_A = '600000.SH'
const SYMBOL_B = '600001.SH'
const INITIAL = 10_000_000
const DAYS = [
  '2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05',
  '2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12',
]
const NOW = `${END}T00:00:00.000Z`

let db: any
let repo: typeof import('../lib/paper/repo')
let metrics: typeof import('../lib/paper/metrics')
let gates: typeof import('../lib/paper/gates')
let experimentId = ''
let userId = ''
let shadowId = ''

async function seedCard(input: {
  id: string
  tradeDate: string
  stance?: string
  symbol?: string
  evidence?: unknown[]
}) {
  await db.execute({
    sql: `INSERT INTO paper_decision_cards
      (id, experiment_id, card_version, trade_date, symbol_code, snapshot_id, policy_version, status,
       stance, horizon, thesis, trigger_basis, trigger_op, trigger_price_cents,
       stop_price_cents, max_loss_cents, max_position_pct_bp,
       confidence_score, confidence_inputs_json, evidence_json, counter_evidence_json, invalidation,
       expires_at, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'snap-metrics', ?, 'active', ?, 'swing', '测试论点',
        'open_auction', 'lte', 11000, 10000, 200000, 1000, 60, '{}', ?, ?, '跌破止损',
        ?, ?, ?)`,
    args: [
      input.id, experimentId, input.tradeDate, input.symbol ?? SYMBOL_A,
      DEFAULT_PAPER_POLICY.version, input.stance ?? 'candidate',
      JSON.stringify(input.evidence ?? [
        { kind: 'policy', text: '政策证据' },
        { kind: 'industry', text: '行业证据' },
        { kind: 'price', text: '价格证据' },
      ]),
      JSON.stringify([{ kind: 'counter', text: '反证' }]),
      `${input.tradeDate}T09:15:00+08:00`, NOW, NOW,
    ],
  })
}

async function seedOrder(input: {
  id: string
  accountId: string
  cardId: string
  actor: 'user' | 'shadow'
  status: string
  rejectCode?: string
}) {
  await db.execute({
    sql: `INSERT INTO paper_orders
      (id, experiment_id, account_id, card_id, card_version, actor, symbol_code, side,
       order_type, qty, condition_op, trigger_price_cents, status, client_request_id,
       idempotency_key, request_hash, target_trade_date, reject_code,
       confirmed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, 'buy', 'open_price_condition', 100, 'lte', 11000, ?,
              ?, ?, 'hash', ?, ?, ?, ?, ?)`,
    args: [
      input.id, experimentId, input.accountId, input.cardId, input.actor, SYMBOL_A,
      input.status, `req-${input.id}`, `idem-${input.id}`, '2026-06-01',
      input.rejectCode ?? null, NOW, NOW, NOW,
    ],
  })
}

async function seedFill(input: { id: string; orderId: string; accountId: string; fees: number }) {
  await db.execute({
    sql: `INSERT INTO paper_fills
      (id, order_id, experiment_id, account_id, symbol_code, side, qty, price_cents,
       gross_cents, commission_cents, stamp_tax_cents, transfer_fee_cents, slippage_cents,
       total_fees_cents, trade_date, trade_time, settled_at, price_basis, price_source_id,
       bar_fetched_at, bar_hash, snapshot_id, is_demo, created_at)
      VALUES (?, ?, ?, ?, ?, 'buy', 100, 10000, 1000000, ?, 0, ?, ?, ?, '2026-06-01',
              '2026-06-01T09:30:00+08:00', ?, 'official_daily_open', 'tushare',
              ?, 'barhash', 'snap-metrics', 0, ?)`,
    args: [
      input.id, input.orderId, experimentId, input.accountId, SYMBOL_A,
      input.fees, input.fees, input.fees, input.fees, NOW, NOW, NOW,
    ],
  })
}

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = path.join(dir, 'metrics.db')
  vi.resetModules()
  const dbMod = await import('../lib/db')
  db = await dbMod.getDb()
  repo = await import('../lib/paper/repo')
  metrics = await import('../lib/paper/metrics')
  gates = await import('../lib/paper/gates')

  const created = await repo.createPaperExperiment({
    name: '指标测试',
    protocolVersion: 'v1',
    benchmarkCode: BENCH,
    initialCashCents: INITIAL,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: START,
    now: NOW,
  })
  experimentId = created.experiment.id
  userId = created.accounts.find((a) => a.kind === 'user')!.id
  shadowId = created.accounts.find((a) => a.kind === 'shadow')!.id

  await db.execute({
    sql: `INSERT INTO paper_snapshots
      (id, experiment_id, as_of, trade_date, universe_json, dataset_version, source_manifest_json,
       quality_json, facts_json, content_hash, is_demo, created_at)
      VALUES ('snap-metrics', ?, ?, '2026-06-01', ?, 'v1', '{}', '{}', '{}', 'sha', 0, ?)`,
    args: [experimentId, NOW, JSON.stringify([SYMBOL_A]), NOW],
  })
  for (const date of DAYS) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES (?, 1, 'test', ?)`,
      args: [date, NOW],
    })
  }
  for (const [index, date] of DAYS.entries()) {
    await db.execute({
      sql: `INSERT INTO market_bars
        (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
         source_id, fetched_at, is_demo)
        VALUES (?, ?, 3500, 3600, 3400, ?, 1000, 1000000, 1, 'raw', 'test', ?, 0)`,
      args: [BENCH, date, 3500 + index * 3.5, NOW],
    })
    await repo.recordPaperNav({
      accountId: userId,
      tradeDate: date,
      cashCents: INITIAL + index * 12_000,
      marketValueCents: 0,
      totalEquityCents: INITIAL + index * 12_000,
      dailyReturnBp: index === 0 ? null : 12,
      benchmark: { code: BENCH },
      now: NOW,
    })
    await repo.recordPaperNav({
      accountId: shadowId,
      tradeDate: date,
      cashCents: INITIAL + index * 10_000,
      marketValueCents: 0,
      totalEquityCents: INITIAL + index * 10_000,
      dailyReturnBp: index === 0 ? null : 10,
      now: NOW,
    })
  }

  for (const [symbol, may, june] of [
    [SYMBOL_A, 10, 12],
    [SYMBOL_B, 20, 18],
  ] as const) {
    await db.execute({
      sql: `INSERT INTO paper_universe (experiment_id, symbol_code, source, reason, added_at)
            VALUES (?, ?, 'system', '测试池', ?)`,
      args: [experimentId, symbol, NOW],
    })
    for (const [date, close] of [['2026-05-04', may], ['2026-05-29', may + 1], ['2026-06-01', june], ['2026-06-12', june + 1]] as const) {
      await db.execute({
        sql: `INSERT INTO market_bars
          (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
           source_id, fetched_at, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, 1000, 1000000, 1, 'raw', 'test', ?, 0)`,
        args: [symbol, date, close, close, close, close, NOW],
      })
    }
  }

  await seedCard({ id: 'card-filled', tradeDate: '2026-06-01' })
  await seedCard({ id: 'card-rejected', tradeDate: '2026-06-02' })
  await seedCard({ id: 'card-observe', tradeDate: '2026-06-03', stance: 'observe' })
  await seedOrder({ id: 'order-user', accountId: userId, cardId: 'card-filled', actor: 'user', status: 'filled' })
  await seedOrder({ id: 'order-shadow', accountId: shadowId, cardId: 'card-filled', actor: 'shadow', status: 'filled' })
  await seedOrder({
    id: 'order-rejected', accountId: userId, cardId: 'card-rejected', actor: 'user',
    status: 'rejected', rejectCode: 'RISK_POSITION_CAP',
  })
  await seedFill({ id: 'fill-user', orderId: 'order-user', accountId: userId, fees: 30_000 })
  await seedFill({ id: 'fill-shadow', orderId: 'order-shadow', accountId: shadowId, fees: 30_000 })

  for (const [cardId, hit, alpha] of [
    ['card-filled', 1, 50],
    ['card-rejected', 0, -20],
  ] as const) {
    await db.execute({
      sql: `INSERT INTO paper_decision_outcomes
        (id, card_id, evaluate_date, horizon_days, return_bp, benchmark_return_bp, alpha_bp,
         max_adverse_bp, hit, reason_class, invalidation_hit, data_quality, evaluated_at)
        VALUES (?, ?, '2026-06-08', 5, 100, 50, ?, 20, ?, 'test', 0, 'pass', ?)`,
      args: [`outcome-${cardId}`, cardId, alpha, hit, NOW],
    })
  }
})

afterAll(async () => {
  await db.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('实验指标', () => {
  it('按日净值算收益/回撤/费用，全收益基准单独识别', async () => {
    const report = await metrics.computePaperMetrics({ experimentId, now: NOW })
    expect(report.accounts.user.startEquityCents).toBe(INITIAL)
    expect(report.accounts.user.endEquityCents).toBe(INITIAL + 9 * 12_000)
    expect(report.accounts.user.returnBp).toBe(108)
    expect(report.accounts.user.maxDrawdownBp).toBe(0)
    expect(report.accounts.user.totalFeesCents).toBe(30_000)
    expect(report.accounts.user.feesDragBp).not.toBeNull()
    expect(report.accounts.user.annualizedReturnBp).toBeNull()
    expect(report.benchmark.code).toBe(BENCH)
    expect(report.benchmark.basis).toBe('total_return_index')
    expect(report.benchmark.returnBp).toBe(90)
    expect(report.excessBp.user).toBe(18)
    expect(report.notes.join('')).not.toContain('价格指数')
  })

  it('样本不足时结果只给计数，不给命中率与 alpha', async () => {
    const report = await metrics.computePaperMetrics({ experimentId, now: NOW })
    expect(report.sample.validDays).toBe(10)
    expect(report.sample.sufficientForDescriptive).toBe(false)
    expect(report.sample.lastCardMature60).toBe(false)
    const all = report.outcomes.find((o) => o.cohort === 'all')!
    expect(all.cards).toBe(3)
    expect(all.matured).toBe(2)
    expect(all.hitRateBp).toBeNull()
    expect(all.averageAlphaBp).toBeNull()
    expect(all.horizons.find((h) => h.horizonDays === 5)?.matured).toBe(2)
  })

  it('触发卡按非 trigger_not_met 口径，执行率与偏离可追溯', async () => {
    const report = await metrics.computePaperMetrics({ experimentId, now: NOW })
    expect(report.execution.triggeredCards).toBe(2)
    expect(report.execution.filledCards).toBe(1)
    expect(report.execution.executionRateBp).toBe(5_000)
    expect(report.execution.deviations).toEqual([{ reason: 'risk_blocked', count: 1 }])
  })

  it('等权自选按月末恢复等权并扣换手成本', async () => {
    const report = await metrics.computePaperMetrics({ experimentId, now: NOW })
    expect(report.equalWeightUniverse.symbols).toBe(2)
    expect(report.equalWeightUniverse.method).toBe('monthly_equal_weight')
    expect(report.equalWeightUniverse.months).toBe(2)
    expect(report.equalWeightUniverse.returnBp).not.toBeNull()
    expect(report.equalWeightUniverse.turnoverCostBp).not.toBeNull()
    expect(report.equalWeightUniverse.note).toContain('未复权')
  })
})

describe('阶段门事实装配', () => {
  it('L1 报告能读到缺口并按样本不足判失败', async () => {
    const report = await gates.computePaperGateReport({ experimentId, gate: 'L1_TO_L2', now: NOW })
    expect(report.decision).toBe('fail')
    expect(report.sample.ready).toBe(false)
    expect(report.failedCriteria.join('')).toContain('样本门槛未达')
    expect(report.vetoes.find((v) => v.key === 'lookahead')?.status).toBe('not_run')
  })

  it('人工验收必须写证据，写入后不再阻塞对应维度', async () => {
    await expect(gates.attestPaperGate({
      experimentId,
      gate: 'L1_TO_L2',
      dimension: 'compliance',
      passed: true,
      evidence: '  ',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    for (const dimension of ['behavior', 'ux', 'compliance', 'crash_replay'] as const) {
      await gates.attestPaperGate({
        experimentId,
        gate: 'L1_TO_L2',
        dimension,
        passed: true,
        evidence: `验收记录 ${dimension}`,
        now: NOW,
      })
    }
    const report = await gates.computePaperGateReport({ experimentId, gate: 'L1_TO_L2', now: NOW })
    expect(report.blockedBy.join('')).not.toContain('行为')
    expect(report.blockedBy.join('')).not.toContain('用户体验')
    expect(report.blockedBy.join('')).not.toContain('合规')
    expect(report.dimensions.find((d) => d.key === 'behavior')?.status).toBe('pass')
    const audit = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM paper_audit_log WHERE action = 'gate.attestation'",
      args: [],
    })
    expect(Number(audit.rows[0].n)).toBe(4)
  })
})
