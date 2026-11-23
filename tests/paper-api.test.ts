import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { isChinaMarketOpen } from '../lib/china-calendar'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

/**
 * paper API 最小闭环：真实 SQLite + 直接调用 handler。
 * 覆盖决策卡/持仓/委托读取、Origin 校验、幂等 201/200、冲突 409、撤销 409。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-api-test-'))
const SHANGHAI_TODAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
// 目标日必须晚于当前时刻（截止检查），又不能落在周末/节假日，否则周末跑测试必红。
let D1 = ''
let D2 = ''
const SYMBOL = '600000.SH'
const INITIAL = 50_000_000
const now = new Date().toISOString()

let db: any
let handlers: {
  decisions: (req: any, res: any) => Promise<void>
  orders: (req: any, res: any) => Promise<void>
  positions: (req: any, res: any) => Promise<void>
  riskEvents: (req: any, res: any) => Promise<void>
  execute: (req: any, res: any) => Promise<void>
  cancel: (req: any, res: any) => Promise<void>
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function loadModules(file: string) {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = file
  vi.resetModules()
  const dbMod = await import('../lib/db')
  const repo = await import('../lib/paper/repo')
  const decisions = (await import('../pages/api/paper/decisions')).default
  const orders = (await import('../pages/api/paper/orders')).default
  const positions = (await import('../pages/api/paper/positions')).default
  const riskEvents = (await import('../pages/api/paper/risk-events')).default
  const execute = (await import('../pages/api/paper/execute')).default
  const cancel = (await import('../pages/api/paper/cancel')).default
  return {
    db: await dbMod.getDb(),
    repo,
    handlers: { decisions, orders, positions, riskEvents, execute, cancel },
  }
}

function makeReq(input: {
  method?: string
  query?: Record<string, string>
  body?: unknown
  origin?: string | null
} = {}): any {
  const headers: Record<string, string> = { host: 'localhost:3000' }
  if (input.origin !== null) headers.origin = input.origin ?? 'http://localhost:3000'
  return { method: input.method ?? 'GET', query: input.query ?? {}, body: input.body, headers }
}

function makeRes(): { res: any; out: { status: number; body: any; headers: Record<string, string> } } {
  const out = { status: 0, body: null as any, headers: {} as Record<string, string> }
  const res: any = {
    setHeader(key: string, value: string) { out.headers[key] = value; return res },
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { res, out }
}

async function call(handler: (req: any, res: any) => Promise<void>, req: any) {
  const { res, out } = makeRes()
  await handler(req, res)
  return out
}

async function seedHistory(endExclusive: string) {
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

async function seedCard(id: string, tradeDate: string) {
  await db.execute({
    sql: `INSERT INTO paper_decision_cards
      (id, experiment_id, card_version, trade_date, symbol_code, snapshot_id, policy_version, status,
       stance, horizon, thesis, trigger_basis, trigger_op, trigger_price_cents,
       stop_price_cents, max_loss_cents, max_position_pct_bp,
       confidence_score, confidence_inputs_json, evidence_json, counter_evidence_json, invalidation,
       expires_at, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, 'snap-1', ?, 'active', 'candidate', 'swing', '测试论点',
        'open_auction', 'lte', 10000, 9500, 200000, 2000, 60, '{}', '[]', '[]', '跌破止损',
        ?, ?, ?)`,
    args: [id, experimentId, tradeDate, SYMBOL, DEFAULT_PAPER_POLICY.version, `${tradeDate}T09:15:00+08:00`, now, now],
  })
}

let experimentId = ''

async function nextOpenDate(after: string): Promise<string> {
  let cursor = addDays(after, 1)
  for (let i = 0; i < 30; i += 1) {
    if (await isChinaMarketOpen(cursor, { allowNetwork: false })) return cursor
    cursor = addDays(cursor, 1)
  }
  return addDays(after, 1)
}

beforeAll(async () => {
  const loaded = await loadModules(path.join(dir, 'api.db'))
  db = loaded.db
  handlers = loaded.handlers
  const { repo } = loaded
  D1 = await nextOpenDate(SHANGHAI_TODAY)
  D2 = await nextOpenDate(D1)

  const created = await repo.createPaperExperiment({
    name: 'API 测试实验',
    protocolVersion: 'v1',
    benchmarkCode: 'H00300',
    initialCashCents: INITIAL,
    policy: DEFAULT_PAPER_POLICY,
    startedAt: now,
    now,
  })
  experimentId = created.experiment.id
  const userId = created.accounts.find((a: any) => a.kind === 'user').id

  await db.execute({
    sql: `INSERT INTO paper_symbol_meta
      (symbol_code, valid_from, valid_to, name, exchange, board, industry_code, industry_name,
       is_st, lot_size, limit_pct_bp, no_price_limit, listed_at, delisted_at, source_id, meta_hash)
      VALUES (?, '2020-01-01', NULL, '浦发银行', 'SH', 'main_sh', '801780', '银行',
        0, 100, 1000, 0, '1999-11-10', NULL, 'test', 'mh-api')`,
    args: [SYMBOL],
  })
  await db.execute({
    sql: `INSERT INTO paper_snapshots
      (id, experiment_id, as_of, trade_date, universe_json, dataset_version, source_manifest_json,
       quality_json, facts_json, content_hash, is_demo, created_at)
      VALUES ('snap-1', ?, ?, ?, '[]', 'v1', '{}', '{}', '{}', 'sha', 0, ?)`,
    args: [experimentId, now, D1, now],
  })
  await db.execute({
    sql: `INSERT INTO paper_market_status_daily
      (symbol_code, trade_date, is_suspended, is_st, status_source, fetched_at)
      VALUES (?, ?, 0, 0, 'test', ?)`,
    args: [SYMBOL, D1, now],
  })
  await seedHistory(D1)
  await repo.recordPaperNav({
    accountId: userId,
    tradeDate: D1,
    cashCents: INITIAL,
    marketValueCents: 0,
    totalEquityCents: INITIAL,
    now,
  })
  await seedCard('card-1', D1)
  // 每日只允许开 1 个新仓，撤销用例换到下一交易日。
  await seedCard('card-cancel', D2)
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('读取接口', () => {
  it('GET decisions 返回当日卡片与标的名称', async () => {
    const out = await call(handlers.decisions, makeReq({ query: { tradeDate: D1 } }))
    expect(out.status).toBe(200)
    const data = out.body.data
    expect(data.tradeDate).toBe(D1)
    expect(data.cards.map((c: any) => c.id)).toEqual(['card-1'])
    expect(data.cards[0].symbolName).toBe('浦发银行')
    expect(data.cards[0].triggerPriceCents).toBe(10000)
    expect(data.experiment.status).toBe('active')
  })

  it('GET positions 返回账户、持仓与风控状态', async () => {
    const out = await call(handlers.positions, makeReq())
    expect(out.status).toBe(200)
    expect(out.body.data.account.name).toBe('主账户')
    expect(out.body.data.positions).toEqual([])
    expect(out.body.data.risk.killSwitch).toBe(false)
    expect(out.body.data.navCents).toBe(INITIAL)
  })

  it('GET risk-events 返回当前风控状态', async () => {
    const out = await call(handlers.riskEvents, makeReq())
    expect(out.status).toBe(200)
    expect(Array.isArray(out.body.data.events)).toBe(true)
    expect(out.body.data.riskState.dataQuality).toBe('pass')
  })
})

describe('POST execute', () => {
  it('跨站 Origin 一律 403，且不落单', async () => {
    const out = await call(handlers.execute, makeReq({
      method: 'POST',
      origin: 'https://evil.example',
      body: { side: 'buy', cardId: 'card-1', qty: 100, clientRequestId: 'req-evil' },
    }))
    expect(out.status).toBe(403)
    expect(out.body.error.code).toBe('ORIGIN_MISMATCH')
  })

  it('缺少 clientRequestId 时 400', async () => {
    const out = await call(handlers.execute, makeReq({
      method: 'POST',
      body: { side: 'buy', cardId: 'card-1', qty: 100 },
    }))
    expect(out.status).toBe(400)
    expect(out.body.error.code).toBe('INVALID_INPUT')
  })

  it('确认买入返回 201，触发价与板别来自服务端卡片', async () => {
    const out = await call(handlers.execute, makeReq({
      method: 'POST',
      body: { side: 'buy', cardId: 'card-1', qty: 100, clientRequestId: 'req-1', idempotencyKey: 'idem-1' },
    }))
    expect(out.status).toBe(201)
    expect(out.body.data.replayed).toBe(false)
    expect(out.body.data.order).toMatchObject({
      cardId: 'card-1',
      side: 'buy',
      qty: 100,
      orderType: 'open_price_condition',
      conditionOp: 'lte',
      triggerPriceCents: 10000,
      status: 'confirmed',
      targetTradeDate: D1,
    })
  })

  it('同一请求重放返回 200 + 原单', async () => {
    const out = await call(handlers.execute, makeReq({
      method: 'POST',
      body: { side: 'buy', cardId: 'card-1', qty: 100, clientRequestId: 'req-1', idempotencyKey: 'idem-1' },
    }))
    expect(out.status).toBe(200)
    expect(out.body.data.replayed).toBe(true)
    expect(out.body.data.order.cardId).toBe('card-1')
  })

  it('同幂等键不同内容返回 409', async () => {
    const out = await call(handlers.execute, makeReq({
      method: 'POST',
      body: { side: 'buy', cardId: 'card-1', qty: 200, clientRequestId: 'req-1b', idempotencyKey: 'idem-1' },
    }))
    expect(out.status).toBe(409)
    expect(out.body.error.code).toBe('IDEMPOTENCY_CONFLICT')
  })

  it('GET orders 返回委托与卡片论点', async () => {
    const out = await call(handlers.orders, makeReq({ query: { tradeDate: D1 } }))
    expect(out.status).toBe(200)
    expect(out.body.data.orders).toHaveLength(1)
    expect(out.body.data.orders[0].symbolName).toBe('浦发银行')
    expect(out.body.data.orders[0].cardThesis).toBe('测试论点')
  })
})

describe('POST cancel', () => {
  it('撤销成功返回 200，再撤返回 409', async () => {
    const created = await call(handlers.execute, makeReq({
      method: 'POST',
      body: { side: 'buy', cardId: 'card-cancel', qty: 100, clientRequestId: 'req-cancel', idempotencyKey: 'idem-cancel' },
    }))
    expect(created.status).toBe(201)
    const orderId = created.body.data.order.id

    const first = await call(handlers.cancel, makeReq({ method: 'POST', body: { orderId } }))
    expect(first.status).toBe(200)
    expect(first.body.data.canceled).toBe(true)

    const second = await call(handlers.cancel, makeReq({ method: 'POST', body: { orderId } }))
    expect(second.status).toBe(409)
    expect(second.body.error.code).toBe('ALREADY_FINAL')
  })

  it('撤销不存在或他人的委托返回 404', async () => {
    const out = await call(handlers.cancel, makeReq({ method: 'POST', body: { orderId: 'ord-missing' } }))
    expect(out.status).toBe(404)
  })
})
