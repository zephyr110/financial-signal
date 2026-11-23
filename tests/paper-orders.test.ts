import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

/**
 * 纸面盘仓储 + 委托状态机集成测试：真实 SQLite、真实事务。
 * 覆盖实验创建、幂等确认、09:15 冻结、16:20 买入/卖出结算、取消、
 * 对账停机与审计哈希链。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-orders-test-'))
const D1 = '2026-11-24'
const D2 = '2026-11-25'
const SYMBOL = '600000.SH'
const INITIAL = 50_000_000
const now = '2026-11-23T08:00:00.000Z'

let ctx: {
  db: any
  repo: typeof import('../lib/paper/repo')
  orders: typeof import('../lib/paper/orders')
}
let experimentId = ''
let userId = ''
let shadowId = ''

async function loadPaper(file: string) {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = file
  vi.resetModules()
  const dbMod = await import('../lib/db')
  const repo = await import('../lib/paper/repo')
  const orders = await import('../lib/paper/orders')
  return { db: await dbMod.getDb(), repo, orders }
}

/** 交易日历与历史日线：风控的上市天数、20 日成交额、T-1 收盘都依赖它们。 */
async function seedHistory(db: any, endExclusive: string) {
  const dates: string[] = []
  const cursor = new Date(`${endExclusive}T00:00:00Z`)
  cursor.setUTCDate(cursor.getUTCDate() - 1)
  while (dates.length < 90) {
    const dow = cursor.getUTCDay()
    if (dow !== 0 && dow !== 6) dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }
  dates.reverse()
  for (const date of dates) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO trading_calendar (trade_date, is_open, source_id, updated_at)
            VALUES (?, 1, 'test', ?)`,
      args: [date, now],
    })
  }
  for (const date of dates.slice(-25)) {
    await db.execute({
      sql: `INSERT INTO market_bars
        (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type, source_id, fetched_at, is_demo)
        VALUES (?, ?, 100, 100, 100, 100, 1000000, 500000000, 1, 'raw', 'test', ?, 0)`,
      args: [SYMBOL, date, now],
    })
  }
}

async function seedDay(db: any, tradeDate: string, openYuan: number, closeYuan: number) {
  await db.execute({
    sql: `INSERT INTO trading_calendar (trade_date, is_open, source_id, updated_at)
          VALUES (?, 1, 'test', ?)`,
    args: [tradeDate, now],
  })
  await db.execute({
    sql: `INSERT INTO market_bars
      (code, trade_date, open, high, low, close, volume, amount, adj_factor, adjust_type, source_id, fetched_at, is_demo)
      VALUES (?, ?, ?, ?, ?, ?, 1000000, 500000000, 1, 'raw', 'test', ?, 0)`,
    args: [SYMBOL, tradeDate, openYuan, openYuan, openYuan, closeYuan, now],
  })
  await db.execute({
    sql: `INSERT INTO paper_limit_price_daily
      (symbol_code, trade_date, limit_up_cents, limit_down_cents, source_id, fetched_at)
      VALUES (?, ?, ?, ?, 'test', ?)`,
    args: [SYMBOL, tradeDate, Math.round(openYuan * 100) + 1000, Math.round(openYuan * 100) - 1000, now],
  })
  await db.execute({
    sql: `INSERT INTO paper_market_status_daily
      (symbol_code, trade_date, is_suspended, is_st, status_source, fetched_at)
      VALUES (?, ?, 0, 0, 'test', ?)`,
    args: [SYMBOL, tradeDate, now],
  })
}

async function seedCard(db: any, id: string, tradeDate: string, status = 'active') {
  await db.execute({
    sql: `INSERT INTO paper_decision_cards
      (id, experiment_id, card_version, trade_date, symbol_code, snapshot_id, policy_version, status,
       stance, horizon, thesis, trigger_basis, stop_price_cents, max_loss_cents, max_position_pct_bp,
       confidence_score, confidence_inputs_json, evidence_json, counter_evidence_json, invalidation,
       expires_at, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'snap-1', ?, ?, 'candidate', 'swing', '测试论点', 'open_auction',
       9500, 200000, 2000, 60, '{}', '[]', '[]', '跌破止损', ?, ?, ?)`,
    args: [id, experimentId, tradeDate, SYMBOL, DEFAULT_PAPER_POLICY.version, status,
      `${tradeDate}T16:30:00.000Z`, now, now],
  })
}

function buyInput(cardId: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: userId,
    cardId,
    cardVersion: 1,
    symbolCode: SYMBOL,
    side: 'buy' as const,
    orderType: 'open_market' as const,
    qty: 100,
    clientRequestId: `req-${cardId}`,
    idempotencyKey: `idem-${cardId}`,
    requestHash: `hash-${cardId}`,
    targetTradeDate: D1,
    reservations: [{ kind: 'cash' as const, amountCents: 1_010_000 }],
    confirmedAt: `${D1}T08:40:00+08:00`,
    ...overrides,
  }
}

beforeAll(async () => {
  ctx = await loadPaper(path.join(dir, 'orders.db'))
  const { db, repo } = ctx

  const created = await repo.createPaperExperiment({
    name: 'P0 测试实验',
    protocolVersion: 'v1',
    benchmarkCode: 'H00300',
    initialCashCents: INITIAL,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: now,
    now,
  })
  experimentId = created.experiment.id
  userId = created.accounts.find((a) => a.kind === 'user')!.id
  shadowId = created.accounts.find((a) => a.kind === 'shadow')!.id

  await db.execute({
    sql: `INSERT INTO paper_symbol_meta
      (symbol_code, valid_from, valid_to, name, exchange, board, industry_code, industry_name,
       is_st, lot_size, limit_pct_bp, no_price_limit, listed_at, delisted_at, source_id, meta_hash)
      VALUES (?, '2020-01-01', NULL, '浦发银行', 'SH', 'main_sh', '801780', '银行',
        0, 100, 1000, 0, '1999-11-10', NULL, 'test', 'mh-1')`,
    args: [SYMBOL],
  })
  await db.execute({
    sql: `INSERT INTO paper_snapshots
      (id, experiment_id, as_of, trade_date, universe_json, dataset_version, source_manifest_json,
       quality_json, facts_json, content_hash, is_demo, created_at)
      VALUES ('snap-1', ?, ?, ?, '[]', 'v1', '{}', '{}', '{}', 'sha', 0, ?)`,
    args: [experimentId, now, D1, now],
  })
  await seedHistory(db, D1)
  await seedDay(db, D1, 100, 100)
  await seedDay(db, D2, 101, 101)

  // 16:10 收盘后先落当日净值，16:20 结算才有单笔风险上限的基数
  for (const accountId of [userId, shadowId]) {
    await repo.recordPaperNav({
      accountId,
      tradeDate: D1,
      cashCents: INITIAL,
      marketValueCents: 0,
      totalEquityCents: INITIAL,
      now,
    })
  }
  await seedCard(db, 'card-1', D1)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('实验与账户', () => {
  it('创建实验同时生成主账户/影子账户、期初流水与风控状态', async () => {
    const { db, repo } = ctx
    const experiment = await repo.getPaperExperiment(experimentId)
    expect(experiment?.status).toBe('active')
    expect(experiment?.policyVersion).toBe(DEFAULT_PAPER_POLICY.version)

    const accounts = await repo.listPaperAccounts(experimentId)
    expect(accounts.map((a) => a.kind).sort()).toEqual(['shadow', 'user'])
    expect(accounts.every((a) => a.cashCents === INITIAL)).toBe(true)

    const entries = await db.execute({
      sql: 'SELECT kind, amount_cents, balance_after_cents FROM paper_cash_entries WHERE account_id = ?',
      args: [userId],
    })
    expect(entries.rows).toHaveLength(1)
    expect(entries.rows[0]).toMatchObject({ kind: 'initial', amount_cents: INITIAL, balance_after_cents: INITIAL })

    const risk = await repo.getPaperRiskState(userId)
    expect(risk.killSwitch).toBe(false)

    const { policy, hash } = await repo.getPaperExperimentPolicy(experimentId)
    expect(policy.version).toBe(DEFAULT_PAPER_POLICY.version)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('委托确认、冻结与买入结算', () => {
  let orderId = ''

  it('确认买入：占冻结现金、卡片转已确认，幂等重放不重复下单', async () => {
    const { db, orders, repo } = ctx
    const first = await orders.confirmPaperOrder(buyInput('card-1'))
    expect(first.replayed).toBe(false)
    orderId = first.order.id
    expect(first.order.status).toBe('confirmed')

    const replay = await orders.confirmPaperOrder(buyInput('card-1'))
    expect(replay.replayed).toBe(true)
    expect(replay.order.id).toBe(orderId)

    await expect(orders.confirmPaperOrder(buyInput('card-1', { requestHash: 'different' })))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const card = await orders.getPaperCard('card-1')
    expect(card?.status).toBe('confirmed')

    const account = await repo.getPaperAccount(userId)
    expect(account?.cashCents).toBe(INITIAL - 1_010_000)

    const reservations = await db.execute({
      sql: 'SELECT kind, amount_cents, status FROM paper_reservations WHERE order_id = ?',
      args: [orderId],
    })
    expect(reservations.rows).toHaveLength(1)
    expect(reservations.rows[0]).toMatchObject({ kind: 'cash', amount_cents: 1_010_000, status: 'held' })
  })

  it('09:15 冻结后按官方开盘价成交，现金/批次/持仓/卡片同步落地', async () => {
    const { db, orders, repo } = ctx
    const frozen = await orders.freezePaperOrders({ experimentId, tradeDate: D1, at: `${D1}T09:15:00+08:00` })
    expect(frozen).toBe(1)
    expect((await orders.getPaperOrder(orderId))?.status).toBe('settlement_pending')

    const result = await orders.settlePaperOrder({
      orderId,
      settledAt: `${D1}T16:20:05+08:00`,
    })
    expect(result.applied).toBe(true)
    expect(result.decision).toMatchObject({
      outcome: 'fill',
      nextOrderStatus: 'filled',
      nextCardStatus: 'executed',
    })

    const order = await orders.getPaperOrder(orderId)
    expect(order?.status).toBe('filled')
    expect((await orders.getPaperCard('card-1'))?.status).toBe('executed')

    const fill = await db.execute({
      sql: 'SELECT * FROM paper_fills WHERE order_id = ?',
      args: [orderId],
    })
    expect(fill.rows[0]).toMatchObject({
      price_cents: 10_005,
      gross_cents: 1_000_500,
      commission_cents: 500,
      transfer_fee_cents: 11,
      total_fees_cents: 511,
      trade_time: '09:25',
      price_basis: 'official_daily_open',
    })

    const entries = await db.execute({
      sql: 'SELECT kind, amount_cents, balance_after_cents FROM paper_cash_entries WHERE order_id = ? ORDER BY id',
      args: [orderId],
    })
    expect(entries.rows).toMatchObject([
      { kind: 'buy', amount_cents: -1_000_500, balance_after_cents: INITIAL - 1_000_500 },
      { kind: 'fee', amount_cents: -511, balance_after_cents: INITIAL - 1_001_011 },
    ])

    const lots = await db.execute({ sql: 'SELECT * FROM paper_tax_lots WHERE account_id = ?', args: [userId] })
    expect(lots.rows).toHaveLength(1)
    expect(lots.rows[0]).toMatchObject({ symbol_code: SYMBOL, open_date: D1, qty: 100, cost_total_cents: 1_000_500 })

    const positions = await repo.loadMaterializedPositions(userId)
    expect(positions).toEqual([{ symbolCode: SYMBOL, totalQty: 100, availableQty: 0, frozenQty: 100 }])

    const account = await repo.getPaperAccount(userId)
    expect(account?.cashCents).toBe(INITIAL - 1_001_011)

    const reservation = await db.execute({
      sql: 'SELECT status FROM paper_reservations WHERE order_id = ?',
      args: [orderId],
    })
    expect(reservation.rows[0].status).toBe('consumed')
  })

  it('重复结算不会重复成交', async () => {
    const { orders } = ctx
    const again = await orders.settlePaperOrder({ orderId, settledAt: `${D1}T16:25:00+08:00` })
    expect(again.applied).toBe(false)
    expect(again.reason).toBe('NOT_PENDING')
  })
})

describe('次日卖出与对账', () => {
  let sellOrderId = ''

  it('T+1 可卖后按开盘价卖出，FIFO 平仓并记印花税', async () => {
    const { db, orders, repo } = ctx
    const confirmed = await orders.confirmPaperOrder({
      accountId: userId,
      cardId: null,
      symbolCode: SYMBOL,
      side: 'sell',
      orderType: 'open_market',
      qty: 100,
      clientRequestId: 'req-sell-1',
      idempotencyKey: 'idem-sell-1',
      requestHash: 'hash-sell-1',
      targetTradeDate: D2,
      reservations: [{ kind: 'shares', qty: 100 }],
      confirmedAt: `${D2}T08:40:00+08:00`,
    })
    sellOrderId = confirmed.order.id

    const positions = await repo.loadMaterializedPositions(userId)
    expect(positions).toEqual([{ symbolCode: SYMBOL, totalQty: 100, availableQty: 0, frozenQty: 100 }])

    await orders.freezePaperOrders({ experimentId, tradeDate: D2, at: `${D2}T09:15:00+08:00` })
    const result = await orders.settlePaperOrder({ orderId: sellOrderId, settledAt: `${D2}T16:20:05+08:00` })
    expect(result.applied).toBe(true)
    expect(result.decision).toMatchObject({ outcome: 'fill', nextOrderStatus: 'filled', nextCardStatus: null })
    expect(result.decision?.fill).toMatchObject({ priceCents: 10_094, grossCents: 1_009_400, stampTaxCents: 505 })

    const closes = await db.execute({
      sql: 'SELECT * FROM paper_lot_closes WHERE sell_fill_id = ?',
      args: [`fill-${sellOrderId}`],
    })
    expect(closes.rows).toHaveLength(1)
    expect(closes.rows[0]).toMatchObject({
      qty: 100,
      cost_cents: 1_000_500,
      proceeds_cents: 1_009_400,
      realized_pnl_cents: 8_900,
      holding_days: 1,
    })

    expect(await repo.loadMaterializedPositions(userId)).toEqual([])
    const account = await repo.getPaperAccount(userId)
    expect(account?.cashCents).toBe(50_007_373)
  })

  it('16:30 对账四条恒等式通过，重建结果一致', async () => {
    const { repo } = ctx
    const result = await repo.reconcilePaperAccount({ accountId: userId, tradeDate: D2, now })
    expect(result.reconciliation.status).toBe('pass')
    expect(result.reconciliation.realizedCents).toBe(8_900)
    expect(result.reconciliation.feesCents).toBe(1_022)
    expect(result.reconciliation.taxesCents).toBe(505)
    expect(result.mismatchCents).toBe(0)

    const rebuilt = await repo.rebuildPaperAccount({ accountId: userId, tradeDate: D2 })
    expect(rebuilt.cashCents).toBe(50_007_373)
    expect(rebuilt.positions).toEqual([])
  })
})

describe('取消与数据质量', () => {
  it('取消委托释放冻结并让卡片回到可确认', async () => {
    const { db, orders, repo } = ctx
    await seedCard(db, 'card-2', D2)
    const confirmed = await orders.confirmPaperOrder(buyInput('card-2', {
      targetTradeDate: D2,
      confirmedAt: `${D2}T08:41:00+08:00`,
    }))
    const cashBefore = (await repo.getPaperAccount(userId))?.cashCents
    expect(cashBefore).toBe(50_007_373 - 1_010_000)

    expect(await orders.cancelPaperOrder({ orderId: confirmed.order.id, now: `${D2}T09:00:00+08:00` })).toBe(true)
    expect((await orders.getPaperOrder(confirmed.order.id))?.status).toBe('canceled')
    expect((await orders.getPaperCard('card-2'))?.status).toBe('active')
    expect((await repo.getPaperAccount(userId))?.cashCents).toBe(50_007_373)

    const reservation = await db.execute({
      sql: 'SELECT status FROM paper_reservations WHERE order_id = ?',
      args: [confirmed.order.id],
    })
    expect(reservation.rows[0].status).toBe('released')
    // 已取消的委托不能再取消
    expect(await orders.cancelPaperOrder({ orderId: confirmed.order.id })).toBe(false)
  })

  it('数据质量 fail 时整笔作废，不产生成交', async () => {
    const { db, orders } = ctx
    await seedCard(db, 'card-3', D2)
    const confirmed = await orders.confirmPaperOrder(buyInput('card-3', {
      targetTradeDate: D2,
      clientRequestId: 'req-dq',
      idempotencyKey: 'idem-dq',
      requestHash: 'hash-dq',
    }))
    const result = await orders.settlePaperOrder({
      orderId: confirmed.order.id,
      settledAt: `${D2}T16:20:05+08:00`,
      dataQuality: 'fail',
    })
    expect(result.decision).toMatchObject({ outcome: 'expire', nextOrderStatus: 'expired', nextCardStatus: 'expired' })
    expect((await orders.getPaperOrder(confirmed.order.id))?.status).toBe('expired')
    expect((await orders.getPaperCard('card-3'))?.status).toBe('expired')
  })
})

describe('账本不一致停机', () => {
  it('对账失败触发 kill switch，并拒绝影子账户买入', async () => {
    const { db, orders, repo } = ctx
    await seedCard(db, 'card-4', D1)
    const confirmed = await orders.confirmPaperOrder(buyInput('card-4', {
      accountId: shadowId,
      clientRequestId: 'req-shadow',
      idempotencyKey: 'idem-shadow',
      requestHash: 'hash-shadow',
    }))

    await db.execute({
      sql: 'UPDATE paper_accounts SET cash_cents = cash_cents + 1 WHERE id = ?',
      args: [shadowId],
    })
    const reconciled = await repo.reconcilePaperAccount({ accountId: shadowId, tradeDate: D2, now })
    expect(reconciled.status).toBe('fail')
    expect(reconciled.mismatchCents).toBeGreaterThan(0)

    const risk = await repo.getPaperRiskState(shadowId)
    expect(risk.killSwitch).toBe(true)
    expect(risk.killReason).toBe('LEDGER_MISMATCH')

    const result = await orders.settlePaperOrder({
      orderId: confirmed.order.id,
      settledAt: `${D1}T16:20:05+08:00`,
    })
    expect(result.decision).toMatchObject({
      outcome: 'reject',
      nextOrderStatus: 'rejected',
      nextCardStatus: 'expired',
      reasonCode: 'LEDGER_MISMATCH',
    })
    expect((await orders.getPaperOrder(confirmed.order.id))?.status).toBe('rejected')
  })
})

describe('审计哈希链', () => {
  it('每条审计记录都包含前一条哈希', async () => {
    const { db } = ctx
    const r = await db.execute({
      sql: 'SELECT id, prev_hash, hash FROM paper_audit_log ORDER BY id',
      args: [],
    })
    expect(r.rows.length).toBeGreaterThanOrEqual(5)
    let prev: string | null = null
    for (const row of r.rows) {
      const rowPrev = row.prev_hash == null ? null : String(row.prev_hash)
      expect(rowPrev === null ? null : rowPrev).toBe(prev)
      prev = String(row.hash)
    }
  })
})
