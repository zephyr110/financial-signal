import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

/**
 * 行情供给与结算兜底：两张日频表此前没有生产写入方，
 * 这里验证从日线推导限价/停牌、外部来源不被覆盖，以及净值回退。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-market-data-test-'))
const D1 = '2026-06-01'
const D2 = '2026-06-02'
const PREV = '2026-05-29'
const SATURDAY = '2026-05-30'
const SYMBOL = '600000.SH'
const EXTERNAL_SYMBOL = '600001.SH'
const SUSPENDED_SYMBOL = '600004.SH'
const INITIAL = 10_000_000
const NOW = `${D1}T00:00:00.000Z`

let db: any
let repo: typeof import('../lib/paper/repo')
let jobs: typeof import('../lib/paper/jobs')
let metrics: typeof import('../lib/paper/metrics')
let marketData: typeof import('../lib/paper/market-data')
let experimentId = ''
let userId = ''

async function insertBar(code: string, tradeDate: string, open: number, close: number) {
  await db.execute({
    sql: `INSERT INTO market_bars
      (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
       source_id, fetched_at, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, 1000000, 500000000, 1, 'raw', 'test', ?, 0)`,
    args: [code, tradeDate, open, close + 2, close - 2, close, NOW],
  })
}

async function insertMeta(code: string) {
  await db.execute({
    sql: `INSERT INTO paper_symbol_meta
      (symbol_code, valid_from, valid_to, name, exchange, board, industry_code, industry_name,
       is_st, lot_size, limit_pct_bp, no_price_limit, listed_at, delisted_at, source_id, meta_hash)
      VALUES (?, ?, NULL, ?, 'SH', 'main_sh', '银行', '银行', 0, 100, 1000, 0,
        '2020-01-02', NULL, 'test', ?)`,
    args: [code, PREV, `测试${code}`, `hash-${code}`],
  })
}

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = path.join(dir, 'market-data.db')
  vi.resetModules()
  const dbMod = await import('../lib/db')
  db = await dbMod.getDb()
  repo = await import('../lib/paper/repo')
  jobs = await import('../lib/paper/jobs')
  metrics = await import('../lib/paper/metrics')
  marketData = await import('../lib/paper/market-data')

  const created = await repo.createPaperExperiment({
    name: '行情供给测试',
    protocolVersion: 'v1',
    benchmarkCode: 'H00300',
    initialCashCents: INITIAL,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: `${PREV}T00:00:00.000Z`,
    now: NOW,
  })
  experimentId = created.experiment.id
  userId = created.accounts.find((a) => a.kind === 'user')!.id

  for (const tradeDate of [D1, D2]) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES (?, 1, 'test', ?)`,
      args: [tradeDate, NOW],
    })
    await db.execute({
      sql: `INSERT INTO market_overview (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
            VALUES (?, '{"up":3000,"flat":200,"down":1800}', '{}', 'test', 0, ?)`,
      args: [tradeDate, NOW],
    })
  }

  // SYMBOL 已移出自选池，只剩一张在途委托；EXTERNAL 有外部来源行；SUSPENDED 当日无日线。
  const universe: Array<[string, string | null]> = [
    [EXTERNAL_SYMBOL, null],
    [SUSPENDED_SYMBOL, null],
    [SYMBOL, PREV],
  ]
  for (const [code, removedAt] of universe) {
    await db.execute({
      sql: `INSERT INTO paper_universe (experiment_id, symbol_code, source, reason, added_at, removed_at)
            VALUES (?, ?, 'system', '测试池', ?, ?)`,
      args: [experimentId, code, NOW, removedAt],
    })
    await insertMeta(code)
  }
  await insertBar(SYMBOL, PREV, 9.9, 10)
  await insertBar(SUSPENDED_SYMBOL, PREV, 19.8, 20)

  await db.execute({
    sql: `INSERT INTO paper_market_status_daily
      (symbol_code, trade_date, is_suspended, is_st, status_source, fetched_at)
      VALUES (?, ?, 0, 0, 'tushare', ?)`,
    args: [EXTERNAL_SYMBOL, D1, NOW],
  })
  await db.execute({
    sql: `INSERT INTO paper_limit_price_daily
      (symbol_code, trade_date, limit_up_cents, limit_down_cents, source_id, fetched_at)
      VALUES (?, ?, 3000, 1000, 'tushare', ?)`,
    args: [EXTERNAL_SYMBOL, D1, NOW],
  })

  await db.execute({
    sql: `INSERT INTO paper_snapshots
      (id, experiment_id, as_of, trade_date, universe_json, dataset_version, source_manifest_json,
       quality_json, facts_json, content_hash, is_demo, created_at)
      VALUES ('snap-md', ?, ?, ?, ?, 'v1', '{}', '{}', '{}', 'sha', 0, ?)`,
    args: [experimentId, NOW, D1, JSON.stringify([SYMBOL]), NOW],
  })
  await db.execute({
    sql: `INSERT INTO paper_decision_cards
      (id, experiment_id, card_version, trade_date, symbol_code, snapshot_id, policy_version, status,
       stance, horizon, thesis, trigger_basis, trigger_op, trigger_price_cents,
       stop_price_cents, max_loss_cents, max_position_pct_bp,
       confidence_score, confidence_inputs_json, evidence_json, counter_evidence_json, invalidation,
       expires_at, created_at, updated_at)
      VALUES ('card-md', ?, 1, ?, ?, 'snap-md', ?, 'confirmed', 'candidate', 'swing', '测试论点',
        'open_auction', 'lte', 1100, 900, 200000, 2000, 60, '{}', '[]', '[]', '跌破止损',
        ?, ?, ?)`,
    args: [experimentId, D1, SYMBOL, DEFAULT_PAPER_POLICY.version, `${D1}T09:15:00+08:00`, NOW, NOW],
  })
  await db.execute({
    sql: `INSERT INTO paper_orders
      (id, experiment_id, account_id, card_id, card_version, actor, symbol_code, side, order_type,
       qty, condition_op, trigger_price_cents, status, client_request_id, idempotency_key,
       request_hash, target_trade_date, confirmed_at, cutoff_at, created_at, updated_at)
      VALUES ('order-md', ?, ?, 'card-md', 1, 'user', ?, 'buy', 'open_market',
        100, NULL, NULL, 'settlement_pending', 'req-md', 'idem-md', 'hash', ?, ?, ?, ?, ?)`,
    args: [experimentId, userId, SYMBOL, D1, NOW, NOW, NOW, NOW],
  })
  await db.execute({
    sql: `INSERT INTO paper_reservations
      (id, account_id, order_id, kind, symbol_code, amount_cents, qty, status, created_at)
      VALUES ('res-md', ?, 'order-md', 'cash', NULL, 150000, 0, 'held', ?)`,
    args: [userId, NOW],
  })
})

afterAll(async () => {
  await db.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('模拟盘行情供给', () => {
  it('盘前从 T-1 收盘推导限价，不因当日无日线判停牌，也不覆盖外部来源', async () => {
    const result = await marketData.ensurePaperMarketData({
      experimentId,
      tradeDate: D1,
      mode: 'preopen',
      now: NOW,
    })
    // 移出自选但仍有在途委托的 SYMBOL 也要有限价。
    expect(result).toMatchObject({ symbols: 3, limits: 2 })

    const derived = await db.execute({
      sql: `SELECT is_suspended, status_source FROM paper_market_status_daily
            WHERE symbol_code = ? AND trade_date = ?`,
      args: [SYMBOL, D1],
    })
    expect(derived.rows[0]).toMatchObject({ is_suspended: 0, status_source: 'derived_bar' })

    const limit = await db.execute({
      sql: `SELECT limit_up_cents, limit_down_cents, source_id FROM paper_limit_price_daily
            WHERE symbol_code = ? AND trade_date = ?`,
      args: [SYMBOL, D1],
    })
    expect(limit.rows[0]).toMatchObject({
      limit_up_cents: 1100,
      limit_down_cents: 900,
      source_id: 'derived_bar',
    })

    const externalStatus = await db.execute({
      sql: 'SELECT is_suspended, status_source FROM paper_market_status_daily WHERE symbol_code = ? AND trade_date = ?',
      args: [EXTERNAL_SYMBOL, D1],
    })
    expect(externalStatus.rows[0]).toMatchObject({ is_suspended: 0, status_source: 'tushare' })
    const externalLimit = await db.execute({
      sql: 'SELECT limit_up_cents, limit_down_cents, source_id FROM paper_limit_price_daily WHERE symbol_code = ? AND trade_date = ?',
      args: [EXTERNAL_SYMBOL, D1],
    })
    expect(externalLimit.rows[0]).toMatchObject({
      limit_up_cents: 3000,
      limit_down_cents: 1000,
      source_id: 'tushare',
    })
  })

  it('周复盘错过后在周一补跑，按最近一个周六落库', async () => {
    const result = await jobs.runPaperWeeklyReview({ experimentId, tradeDate: D1, now: NOW })
    expect(result.skipped).toBe(false)

    const review = await db.execute({
      sql: `SELECT period_start, period_end FROM paper_reviews
            WHERE experiment_id = ? AND kind = 'weekly'`,
      args: [experimentId],
    })
    expect(review.rows[0]).toMatchObject({ period_start: '2026-05-25', period_end: SATURDAY })
  })

  it('实验开始前的一周不写空周复盘', async () => {
    const result = await jobs.runPaperWeeklyReview({ experimentId, tradeDate: '2026-05-27', now: NOW })
    expect(result).toMatchObject({ skipped: true, reason: 'PERIOD_BEFORE_START' })

    const review = await db.execute({
      sql: `SELECT COUNT(*) AS n FROM paper_reviews
            WHERE experiment_id = ? AND kind = 'weekly' AND period_end = '2026-05-23'`,
      args: [experimentId],
    })
    expect(Number(review.rows[0].n)).toBe(0)
  })

  it('09:15 前不截止，16:20 前不结算', async () => {
    const earlyCutoff = await jobs.runPaperCutoff({
      experimentId,
      tradeDate: D1,
      now: `${D1}T00:30:00.000Z`,
    })
    expect(earlyCutoff).toMatchObject({ skipped: true, reason: 'BEFORE_CUTOFF' })

    const earlySettle = await jobs.runPaperSettle({
      experimentId,
      tradeDate: D1,
      now: `${D1}T07:00:00.000Z`,
    })
    expect(earlySettle).toMatchObject({ skipped: true, reason: 'BEFORE_SETTLE' })
  })

  it('无预置停牌/限价时结算自动补齐并成交', async () => {
    await insertBar(SYMBOL, D1, 10.2, 10.5)

    const result = await jobs.runPaperSettle({
      experimentId,
      tradeDate: D1,
      now: `${D1}T08:20:00.000Z`,
    })
    expect(result.skipped).toBe(false)
    expect(result.detail.settled).toBe(1)

    const fill = await db.execute({
      sql: 'SELECT qty, price_cents, price_basis FROM paper_fills WHERE order_id = ?',
      args: ['order-md'],
    })
    expect(fill.rows[0]).toMatchObject({ qty: 100, price_cents: 1021, price_basis: 'official_daily_open' })

    const order = await db.execute({ sql: 'SELECT status FROM paper_orders WHERE id = ?', args: ['order-md'] })
    expect(order.rows[0].status).toBe('filled')
    const card = await db.execute({ sql: 'SELECT status FROM paper_decision_cards WHERE id = ?', args: ['card-md'] })
    expect(card.rows[0].status).toBe('executed')

    // 当日无日线的标的在结算时点才可判停牌；外部来源行仍保持原值。
    const suspended = await db.execute({
      sql: 'SELECT is_suspended, status_source FROM paper_market_status_daily WHERE symbol_code = ? AND trade_date = ?',
      args: [SUSPENDED_SYMBOL, D1],
    })
    expect(suspended.rows[0]).toMatchObject({ is_suspended: 1, status_source: 'derived_bar' })
    const external = await db.execute({
      sql: 'SELECT is_suspended, status_source FROM paper_market_status_daily WHERE symbol_code = ? AND trade_date = ?',
      args: [EXTERNAL_SYMBOL, D1],
    })
    expect(external.rows[0]).toMatchObject({ is_suspended: 0, status_source: 'tushare' })
  })

  it('缺当日收盘时净值回退最近收盘并标记 stale，不再把市值抹成 0', async () => {
    const exact = await jobs.computePaperNav(userId, D1)
    expect(exact.staleSymbols).toEqual([])
    expect(exact.marketValueCents).toBe(105_000)

    const stale = await jobs.computePaperNav(userId, D2)
    expect(stale.missingSymbols).toEqual([])
    expect(stale.staleSymbols).toEqual([SYMBOL])
    expect(stale.marketValueCents).toBe(105_000)
  })

  it('非当日价格的净值标 warn、不计有效日，但仍作为次日收益基线', async () => {
    const result = await jobs.runPaperNavAndReconcile({
      experimentId,
      tradeDate: D2,
      now: `${D2}T08:30:00.000Z`,
    })
    expect(result.skipped).toBe(false)

    const nav = await db.execute({
      sql: 'SELECT total_equity_cents, market_value_cents, quality FROM paper_nav WHERE account_id = ? AND trade_date = ?',
      args: [userId, D2],
    })
    expect(nav.rows[0]).toMatchObject({ market_value_cents: 105_000, quality: 'warn' })
    expect(await repo.getPaperNavCents(userId, D2)).toBe(Number(nav.rows[0].total_equity_cents))

    const experiment = await db.execute({
      sql: 'SELECT valid_days FROM paper_experiments WHERE id = ?',
      args: [experimentId],
    })
    // D1 是合格日；D2 只有回退价，不能计入有效交易日。
    expect(Number(experiment.rows[0].valid_days)).toBe(1)

    const passNav = await db.execute({
      sql: "SELECT total_equity_cents FROM paper_nav WHERE account_id = ? AND trade_date = ?",
      args: [userId, D1],
    })
    const report = await metrics.computePaperMetrics({ experimentId, now: `${D2}T08:30:00.000Z` })
    expect(report.sample.validDays).toBe(1)
    expect(report.accounts.user.endEquityCents).toBe(Number(passNav.rows[0].total_equity_cents))
  })
})
