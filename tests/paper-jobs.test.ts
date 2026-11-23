import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'
import { calcFees } from '../lib/paper/market'

/**
 * 模拟盘作业链：真实 SQLite + 固定交易日 D1/D2。
 * 覆盖次日卡幂等、盘前降级与影子执行、截止冻结、开盘价结算、
 * 估值对账清缺价禁买、以及日/周复盘落库。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-jobs-test-'))
const D1 = '2026-06-01'
const D2 = '2026-06-02'
const PREV = '2026-05-29'
const SATURDAY = '2026-06-06'
const SYMBOL = '600000.SH'
const ST_SYMBOL = '600001.SH'
const BENCH = 'H00300'
const INITIAL = 50_000_000
const CARD_TRIGGER = 11_000
const CARD_STOP = 10_000
const now = `${D1}T00:00:00.000Z`

let db: any
let repo: typeof import('../lib/paper/repo')
let jobs: typeof import('../lib/paper/jobs')
let orders: typeof import('../lib/paper/orders')
let api: typeof import('../lib/paper/api')
let experimentId = ''
let userId = ''
let shadowId = ''

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
  return dow === 0 || dow === 6
}

async function seedCalendarAndBars() {
  const weekdays: string[] = []
  let cursor = D1
  while (weekdays.length < 90) {
    if (!isWeekend(cursor)) weekdays.unshift(cursor)
    cursor = addDays(cursor, -1)
  }
  for (const date of [...weekdays, D2]) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES (?, 1, 'test', ?)`,
      args: [date, now],
    })
  }
  for (const [index, date] of weekdays.entries()) {
    const close = 100 + index * 0.05
    await db.execute({
      sql: `INSERT INTO market_bars
        (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
         source_id, fetched_at, is_demo)
        VALUES (?, ?, ?, ?, ?, ?, 1000000, 500000000, 1, 'raw', 'test', ?, 0)`,
      args: [SYMBOL, date, date === D1 ? 98 : close - 0.1, close + 2, close - 2, close, now],
    })
    await db.execute({
      sql: `INSERT INTO market_bars
        (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
         source_id, fetched_at, is_demo)
        VALUES (?, ?, ?, ?, ?, ?, 1000000, 5000000000, 1, 'raw', 'test', ?, 0)`,
      args: [BENCH, date, 3500 + index, 3510 + index, 3490 + index, 3500 + index, now],
    })
  }
  await db.execute({
    sql: `INSERT INTO market_overview (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
          VALUES (?, '{"up":3000,"flat":200,"down":1800}', '{}', 'test', 0, ?)`,
    args: [D1, now],
  })
}

async function seedCard(id: string, symbolCode: string, tradeDate: string) {
  await db.execute({
    sql: `INSERT INTO paper_decision_cards
      (id, experiment_id, card_version, trade_date, symbol_code, snapshot_id, policy_version, status,
       stance, horizon, thesis, trigger_basis, trigger_op, trigger_price_cents,
       stop_price_cents, max_loss_cents, max_position_pct_bp,
       confidence_score, confidence_inputs_json, evidence_json, counter_evidence_json, invalidation,
       expires_at, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'snap-test', ?, 'active', 'candidate', 'swing', '测试论点',
        'open_auction', 'lte', ?, ?, 200000, 2000, 60, '{}', '[]', '[]', '跌破止损',
        ?, ?, ?)`,
    args: [
      id, experimentId, tradeDate, symbolCode, DEFAULT_PAPER_POLICY.version,
      CARD_TRIGGER, CARD_STOP, `${tradeDate}T09:15:00+08:00`, now, now,
    ],
  })
}

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = path.join(dir, 'jobs.db')
  vi.resetModules()
  const dbMod = await import('../lib/db')
  db = await dbMod.getDb()
  repo = await import('../lib/paper/repo')
  jobs = await import('../lib/paper/jobs')
  orders = await import('../lib/paper/orders')
  api = await import('../lib/paper/api')

  const created = await repo.createPaperExperiment({
    name: '作业链测试实验',
    protocolVersion: 'v1',
    benchmarkCode: BENCH,
    initialCashCents: INITIAL,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: `${PREV}T00:00:00.000Z`,
    now,
  })
  experimentId = created.experiment.id
  userId = created.accounts.find((a) => a.kind === 'user')!.id
  shadowId = created.accounts.find((a) => a.kind === 'shadow')!.id

  await seedCalendarAndBars()
  for (const [code, name] of [[SYMBOL, '浦发银行'], [ST_SYMBOL, 'ST测试']] as const) {
    await db.execute({
      sql: `INSERT INTO symbols (code, name, exchange, industry_l1, source_id, updated_at)
            VALUES (?, ?, 'SH', '银行', 'test', ?)`,
      args: [code, name, now],
    })
    await db.execute({
      sql: `INSERT INTO paper_universe (experiment_id, symbol_code, source, reason, added_at)
            VALUES (?, ?, 'system', '测试池', ?)`,
      args: [experimentId, code, now],
    })
  }
  for (const [code, isSt] of [[SYMBOL, 0], [ST_SYMBOL, 1]] as const) {
    await db.execute({
      sql: `INSERT INTO paper_market_status_daily
        (symbol_code, trade_date, is_suspended, is_st, status_source, fetched_at)
        VALUES (?, ?, 0, ?, 'test', ?)`,
      args: [code, D1, isSt, now],
    })
  }
  await db.execute({
    sql: `INSERT INTO paper_limit_price_daily
      (symbol_code, trade_date, limit_up_cents, limit_down_cents, source_id, fetched_at)
      VALUES (?, ?, 20000, 8000, 'test', ?)`,
    args: [SYMBOL, D1, now],
  })
  await db.execute({
    sql: `INSERT INTO paper_snapshots
      (id, experiment_id, as_of, trade_date, universe_json, dataset_version, source_manifest_json,
       quality_json, facts_json, content_hash, is_demo, created_at)
      VALUES ('snap-test', ?, ?, ?, ?, 'v1', '{}', '{}', '{}', 'sha', 0, ?)`,
    args: [experimentId, now, D1, JSON.stringify([SYMBOL]), now],
  })
  for (const accountId of [userId, shadowId]) {
    await repo.recordPaperNav({
      accountId,
      tradeDate: PREV,
      cashCents: INITIAL,
      marketValueCents: 0,
      totalEquityCents: INITIAL,
      now,
    })
  }
})

afterAll(async () => {
  await db.close?.()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('模拟盘作业链', () => {
  it('17:30 生成次日卡，重跑不重复落卡', async () => {
    const first = await jobs.runPaperCards({
      experimentId,
      barsDate: D1,
      cardTradeDate: D2,
      allowNetwork: false,
      now,
    })
    expect(first.skipped).toBe(false)
    expect(first.cardTradeDate).toBe(D2)
    expect(first.cards).toBeGreaterThan(0)

    const cardsBefore = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM paper_decision_cards WHERE trade_date = ?',
      args: [D2],
    })
    const snapshot = await db.execute({
      sql: 'SELECT trade_date FROM paper_snapshots WHERE trade_date = ?',
      args: [D2],
    })
    expect(snapshot.rows).toHaveLength(1)

    const second = await jobs.runPaperCards({
      experimentId,
      barsDate: D1,
      cardTradeDate: D2,
      allowNetwork: false,
      now,
    })
    expect(second.skipped).toBe(false)
    expect(second.cards).toBe(0)
    const cardsAfter = await db.execute({
      sql: 'SELECT COUNT(*) AS n FROM paper_decision_cards WHERE trade_date = ?',
      args: [D2],
    })
    expect(Number(cardsAfter.rows[0].n)).toBe(Number(cardsBefore.rows[0].n))
  })

  it('盘前作废 ST 卡，影子账户按同一规则自动下单且不推进用户卡', async () => {
    await seedCard('card-cand', SYMBOL, D1)
    await seedCard('card-st', ST_SYMBOL, D1)

    const result = await jobs.runPaperPreopen({
      experimentId,
      tradeDate: D1,
      now: `${D1}T00:30:00.000Z`,
    })
    expect(result.skipped).toBe(false)
    expect(result.detail.invalidated).toBe(1)

    const cards = await db.execute({
      sql: 'SELECT id, status FROM paper_decision_cards WHERE trade_date = ? ORDER BY id',
      args: [D1],
    })
    expect(cards.rows.find((r: any) => r.id === 'card-st')?.status).toBe('invalidated')
    expect(cards.rows.find((r: any) => r.id === 'card-cand')?.status).toBe('active')

    const shadowOrders = await db.execute({
      sql: `SELECT id, account_id, qty, status FROM paper_orders
            WHERE experiment_id = ? AND target_trade_date = ? AND actor = 'shadow'`,
      args: [experimentId, D1],
    })
    expect(shadowOrders.rows).toHaveLength(1)
    expect(shadowOrders.rows[0]).toMatchObject({ account_id: shadowId, status: 'confirmed' })
    expect(Number(shadowOrders.rows[0].qty)).toBeGreaterThan(0)
  })

  it('09:15 截止冻结已确认委托并作废未确认卡', async () => {
    await seedCard('card-user', SYMBOL, D1)
    const qty = 100
    const fees = calcFees('buy', qty, CARD_TRIGGER, CARD_TRIGGER, DEFAULT_PAPER_POLICY.fees)
    await orders.confirmPaperOrder({
      accountId: userId,
      actor: 'user',
      cardId: 'card-user',
      cardVersion: 1,
      symbolCode: SYMBOL,
      side: 'buy',
      orderType: 'open_price_condition',
      qty,
      conditionOp: 'lte',
      triggerPriceCents: CARD_TRIGGER,
      clientRequestId: 'user-request-1',
      idempotencyKey: 'user-idem-1',
      requestHash: api.paperRequestHash({ cardId: 'card-user', qty, tradeDate: D1 }),
      targetTradeDate: D1,
      reservations: [{ kind: 'cash', amountCents: qty * CARD_TRIGGER + fees.totalFeesCents }],
      confirmedAt: `${D1}T00:45:00.000Z`,
    })

    const result = await jobs.runPaperCutoff({
      experimentId,
      tradeDate: D1,
      now: `${D1}T01:15:00.000Z`,
    })
    expect(result.skipped).toBe(false)
    expect(result.detail.frozen).toBe(2)
    expect(result.detail.expired).toBe(1)

    const cards = await db.execute({
      sql: 'SELECT id, status FROM paper_decision_cards WHERE trade_date = ?',
      args: [D1],
    })
    expect(cards.rows.find((r: any) => r.id === 'card-cand')?.status).toBe('expired')
    expect(cards.rows.find((r: any) => r.id === 'card-user')?.status).toBe('confirmed')

    const userOrders = await db.execute({
      sql: `SELECT status FROM paper_orders
            WHERE experiment_id = ? AND target_trade_date = ? AND actor = 'user'`,
      args: [experimentId, D1],
    })
    expect(userOrders.rows.map((r: any) => r.status)).toEqual(['settlement_pending'])
  })

  it('16:20 按官方开盘价结算，用户与影子单都成交', async () => {
    const result = await jobs.runPaperSettle({
      experimentId,
      tradeDate: D1,
      now: `${D1}T08:20:00.000Z`,
    })
    expect(result.skipped).toBe(false)
    expect(result.detail.settled).toBe(2)

    const fills = await db.execute({
      sql: 'SELECT side, qty, price_cents, price_basis FROM paper_fills WHERE trade_date = ?',
      args: [D1],
    })
    expect(fills.rows).toHaveLength(2)
    for (const fill of fills.rows) {
      expect(fill.side).toBe('buy')
      expect(fill.price_basis).toBe('official_daily_open')
      // 开盘 9800 分 + 5bp 滑点，落在开盘价附近而不是收盘价。
      expect(Number(fill.price_cents)).toBeGreaterThanOrEqual(9800)
      expect(Number(fill.price_cents)).toBeLessThan(9900)
    }

    const userOrder = await db.execute({
      sql: `SELECT status FROM paper_orders
            WHERE experiment_id = ? AND target_trade_date = ? AND actor = 'user'`,
      args: [experimentId, D1],
    })
    expect(userOrder.rows[0].status).toBe('filled')
    const userCard = await db.execute({
      sql: 'SELECT status FROM paper_decision_cards WHERE id = ?',
      args: ['card-user'],
    })
    expect(userCard.rows[0].status).toBe('executed')
  })

  it('16:30 写净值并对账，对账通过后清除缺价禁买', async () => {
    await repo.setPaperMissingPriceState({ accountId: userId, since: D1, now })
    expect((await repo.getPaperRiskState(userId)).dataQuality).toBe('fail')

    const result = await jobs.runPaperNavAndReconcile({
      experimentId,
      tradeDate: D1,
      now: `${D1}T08:30:00.000Z`,
    })
    expect(result.skipped).toBe(false)
    const detail = result.detail as {
      reconciliations: Record<string, string>
      navs: Record<string, number>
    }
    expect(detail.reconciliations.user).toBe('pass')
    expect(detail.reconciliations.shadow).toBe('pass')
    expect(Number(detail.navs.user)).toBeGreaterThan(0)

    const state = await repo.getPaperRiskState(userId)
    expect(state.missingPriceSince).toBeNull()
    expect(state.dataQuality).toBe('pass')

    // D1 是周一：日收益必须对比上周五的净值，而不是不存在的周日。
    const navRow = await db.execute({
      sql: 'SELECT daily_return_bp FROM paper_nav WHERE account_id = ? AND trade_date = ?',
      args: [userId, D1],
    })
    expect(navRow.rows[0].daily_return_bp).not.toBeNull()
  })

  it('16:30 补写遗漏的上一交易日净值', async () => {
    const D3 = '2026-06-03'
    await db.execute({
      sql: `INSERT OR IGNORE INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES (?, 1, 'test', ?)`,
      args: [D3, now],
    })
    await db.execute({
      sql: `INSERT INTO market_overview (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
            VALUES (?, '{"up":2500,"flat":300,"down":2300}', '{}', 'test', 0, ?)`,
      args: [D2, now],
    })
    await db.execute({
      sql: `INSERT INTO market_overview (trade_date, breadth_json, turnover_json, source_id, is_demo, created_at)
            VALUES (?, '{"up":2600,"flat":300,"down":2200}', '{}', 'test', 0, ?)`,
      args: [D3, now],
    })

    const result = await jobs.runPaperNavAndReconcile({
      experimentId,
      tradeDate: D3,
      now: `${D3}T08:30:00.000Z`,
    })
    expect(result.skipped).toBe(false)
    expect((result.detail as { caughtUp?: string[] }).caughtUp).toContain(D2)
    const backfilled = await db.execute({
      sql: 'SELECT quality FROM paper_nav WHERE account_id = ? AND trade_date = ?',
      args: [userId, D2],
    })
    expect(backfilled.rows).toHaveLength(1)
  })

  it('17:00 日复盘记录执行率与偏离，重跑只更新同一条', async () => {
    const first = await jobs.runPaperDailyReview({
      experimentId,
      tradeDate: D1,
      now: `${D1}T09:00:00.000Z`,
    })
    expect(first.skipped).toBe(false)
    expect(first.reviewId).toBeTruthy()
    expect(first.executionRateBp).toBe(3333)

    const row = await db.execute({
      sql: 'SELECT kind, narrative, execution_rate_bp FROM paper_reviews WHERE id = ?',
      args: [first.reviewId],
    })
    expect(row.rows[0].kind).toBe('daily')
    expect(row.rows[0].narrative).toContain('成交明细')
    expect(Number(row.rows[0].execution_rate_bp)).toBe(3333)

    const second = await jobs.runPaperDailyReview({
      experimentId,
      tradeDate: D1,
      now: `${D1}T09:05:00.000Z`,
    })
    expect(second.reviewId).toBe(first.reviewId)
    const count = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM paper_reviews WHERE kind = 'daily' AND period_end = ?",
      args: [D1],
    })
    expect(Number(count.rows[0].n)).toBe(1)
  })

  it('周六 10:00 周复盘按周区间汇总，0% 执行日参与平均', async () => {
    await db.execute({
      sql: `INSERT INTO paper_reviews
            (id, experiment_id, kind, period_start, period_end, facts_json, narrative,
             actual_nav_cents, shadow_nav_cents, execution_rate_bp, deviations_json, created_at)
            VALUES (?, ?, 'daily', ?, ?, '{}', '零执行日', NULL, NULL, 0, '[]', ?)`,
      args: ['review-zero', experimentId, D2, D2, `${D2}T09:00:00.000Z`],
    })
    const result = await jobs.runPaperWeeklyReview({
      experimentId,
      tradeDate: SATURDAY,
      now: `${SATURDAY}T02:00:00.000Z`,
    })
    expect(result.skipped).toBe(false)
    expect(result.reviewId).toBeTruthy()
    expect(result.executionRateBp).toBe(1667)
    const row = await db.execute({
      sql: 'SELECT kind, narrative, facts_json FROM paper_reviews WHERE id = ?',
      args: [result.reviewId],
    })
    expect(row.rows[0].kind).toBe('weekly')
    expect(row.rows[0].narrative).toContain('本周复盘')
    const facts = JSON.parse(row.rows[0].facts_json)
    expect(facts.summary.user.fills).toBe(1)
  })

  it('17:15 到期评估按 5 个交易日出结果，基准从决策日收盘起算', async () => {
    const days = ['2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08']
    const benchCloses = [3600, 3610, 3620, 3630, 3640]
    const symbolCloses = [106, 108, 110, 111, 112.2]
    for (const [index, date] of days.entries()) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO trading_calendar (trade_date, is_open, source_id, updated_at)
              VALUES (?, 1, 'test', ?)`,
        args: [date, now],
      })
      await db.execute({
        sql: `INSERT INTO market_bars
          (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
           source_id, fetched_at, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, 1000000, 500000000, 1, 'raw', 'test', ?, 0)`,
        args: [
          SYMBOL, date, symbolCloses[index] - 1, symbolCloses[index] + 2,
          symbolCloses[index] - 2, symbolCloses[index], now,
        ],
      })
      await db.execute({
        sql: `INSERT INTO market_bars
          (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type,
           source_id, fetched_at, is_demo)
          VALUES (?, ?, ?, ?, ?, ?, 1000000, 5000000000, 1, 'raw', 'test', ?, 0)`,
        args: [BENCH, date, benchCloses[index] - 5, benchCloses[index] + 5,
          benchCloses[index] - 5, benchCloses[index], now],
      })
    }

    const result = await jobs.runPaperEvaluateOutcomes({
      experimentId,
      tradeDate: '2026-06-08',
      now,
    })
    expect(result.skipped).toBe(false)

    const row = await db.execute({
      sql: `SELECT return_bp, benchmark_return_bp, alpha_bp, hit
            FROM paper_decision_outcomes WHERE card_id = ? AND horizon_days = 5`,
      args: ['card-cand'],
    })
    expect(row.rows).toHaveLength(1)
    expect(Number(row.rows[0].return_bp)).toBe(200)
    // 决策日（2026-05-29）收盘 3588 → 评估日 3640 为 145bp；
    // 若误从 cardDate 收盘 3589 起算会得到 142bp，alpha 将凭空多 3bp。
    expect(Number(row.rows[0].benchmark_return_bp)).toBe(145)
    expect(Number(row.rows[0].alpha_bp)).toBe(55)
    expect(Number(row.rows[0].hit)).toBe(1)
  })
})
