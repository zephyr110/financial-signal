import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, afterAll, vi } from 'vitest'

/**
 * 纸面模拟盘表结构：账本只追加、幂等键与状态约束由数据库兜底，
 * 应用层判断失误时不能让脏数据落库。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-schema-test-'))
const now = '2026-11-23T08:00:00.000Z'

async function loadDb(file: string) {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = file
  vi.resetModules()
  return import('../lib/db')
}

const PAPER_TABLES = [
  'paper_policy_versions', 'paper_experiments', 'paper_accounts', 'paper_snapshots',
  'paper_symbol_meta', 'paper_symbol_industry_history', 'paper_limit_price_daily',
  'paper_market_status_daily', 'paper_universe', 'paper_corporate_actions',
  'paper_decision_cards', 'paper_card_events', 'paper_orders', 'paper_order_events',
  'paper_fills', 'paper_reservations', 'paper_tax_lots', 'paper_lot_closes',
  'paper_cash_entries', 'paper_positions', 'paper_nav', 'paper_risk_events',
  'paper_risk_state', 'paper_reconciliations', 'paper_reviews',
  'paper_dividend_entitlements', 'paper_audit_log', 'paper_decision_outcomes',
]

/** 实验/账户最小合法数据集，后续约束测试共用。 */
async function seedAccount(db) {
  await db.execute({
    sql: 'INSERT INTO paper_policy_versions (version, policy_json, policy_hash, is_active, created_at) VALUES (?, ?, ?, 1, ?)',
    args: ['p1', '{}', 'hash-p1', now],
  })
  await db.execute({
    sql: `INSERT INTO paper_experiments
      (id, name, protocol_version, policy_version, benchmark_code, initial_cash_cents, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    args: ['e1', 'demo', 'v1', 'p1', 'H00300', 20_000_000, now, now],
  })
  await db.execute({
    sql: `INSERT INTO paper_accounts
      (id, experiment_id, kind, name, initial_cash_cents, cash_cents, status, created_at)
      VALUES (?, ?, 'user', ?, ?, ?, 'active', ?)`,
    args: ['a1', 'e1', 'user', 20_000_000, 20_000_000, now],
  })
}

describe('paper schema', () => {
  it('建齐纸面盘表并启用 WAL', async () => {
    const { getDb } = await loadDb(path.join(dir, 'schema.db'))
    const db = await getDb()

    const tables = await db.execute({ sql: "SELECT name FROM sqlite_master WHERE type='table'", args: [] })
    const names = tables.rows.map((r) => String(r.name))
    for (const t of PAPER_TABLES) expect(names).toContain(t)

    const journal = await db.execute({ sql: 'PRAGMA journal_mode', args: [] })
    expect(String(journal.rows[0].journal_mode)).toBe('wal')
  })

  it('同一实验每种账户只允许一个，幂等键按账户唯一', async () => {
    const { getDb } = await loadDb(path.join(dir, 'constraints.db'))
    const db = await getDb()
    await seedAccount(db)

    await expect(db.execute({
      sql: `INSERT INTO paper_accounts
        (id, experiment_id, kind, name, initial_cash_cents, cash_cents, status, created_at)
        VALUES (?, 'e1', 'user', ?, 100, 100, 'active', ?)`,
      args: ['a2', 'duplicate', now],
    })).rejects.toThrow(/UNIQUE/i)

    await db.execute({
      sql: `INSERT INTO paper_orders
        (id, experiment_id, account_id, symbol_code, side, order_type, qty, status,
         client_request_id, idempotency_key, request_hash, target_trade_date, created_at, updated_at)
        VALUES ('o1', 'e1', 'a1', '600519.SH', 'sell', 'open_market', 100, 'confirmed',
         'req-1', 'idem-1', 'h1', '2026-11-24', ?, ?)`,
      args: [now, now],
    })
    await expect(db.execute({
      sql: `INSERT INTO paper_orders
        (id, experiment_id, account_id, symbol_code, side, order_type, qty, status,
         client_request_id, idempotency_key, request_hash, target_trade_date, created_at, updated_at)
        VALUES ('o2', 'e1', 'a1', '600519.SH', 'sell', 'open_market', 100, 'confirmed',
         'req-2', 'idem-1', 'h1', '2026-11-24', ?, ?)`,
      args: [now, now],
    })).rejects.toThrow(/UNIQUE/i)
  })

  it('现金为负与可用+冻结≠总数被 CHECK 拒绝', async () => {
    const { getDb } = await loadDb(path.join(dir, 'checks.db'))
    const db = await getDb()
    await seedAccount(db)

    await expect(db.execute({
      sql: `INSERT INTO paper_accounts
        (id, experiment_id, kind, name, initial_cash_cents, cash_cents, status, created_at)
        VALUES ('a-neg', 'e1', 'shadow', 'neg', 100, -1, 'active', ?)`,
      args: [now],
    })).rejects.toThrow(/CHECK/i)

    await expect(db.execute({
      sql: `INSERT INTO paper_positions
        (account_id, symbol_code, total_qty, available_qty, frozen_qty, avg_cost_cents, updated_at)
        VALUES ('a1', '600519.SH', 100, 60, 30, 1000, ?)`,
      args: [now],
    })).rejects.toThrow(/CHECK/i)
  })

  it('账本事件表禁止 UPDATE/DELETE', async () => {
    const { getDb } = await loadDb(path.join(dir, 'append-only.db'))
    const db = await getDb()
    await seedAccount(db)

    await db.execute({
      sql: `INSERT INTO paper_cash_entries
        (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, trade_date, created_at)
        VALUES ('c1', 'a1', 'initial', 100, 100, 'account', 'a1', '2026-11-24', ?)`,
      args: [now],
    })
    await expect(db.execute({
      sql: "UPDATE paper_cash_entries SET amount_cents = 200 WHERE id = 'c1'",
      args: [],
    })).rejects.toThrow(/append-only/)
    await expect(db.execute({
      sql: "DELETE FROM paper_cash_entries WHERE id = 'c1'",
      args: [],
    })).rejects.toThrow(/append-only/)

    await db.execute({
      sql: `INSERT INTO paper_orders
        (id, experiment_id, account_id, symbol_code, side, order_type, qty, status,
         client_request_id, idempotency_key, request_hash, target_trade_date, created_at, updated_at)
        VALUES ('o1', 'e1', 'a1', '600519.SH', 'sell', 'open_market', 100, 'filled',
         'req-1', 'idem-1', 'h1', '2026-11-24', ?, ?)`,
      args: [now, now],
    })
    await db.execute({
      sql: `INSERT INTO paper_fills
        (id, order_id, experiment_id, account_id, symbol_code, side, qty, price_cents,
         gross_cents, trade_date, trade_time, settled_at, price_basis, price_source_id, created_at)
        VALUES ('f1', 'o1', 'e1', 'a1', '600519.SH', 'sell', 100, 1000,
         100000, '2026-11-24', '09:25', ?, 'official_daily_open', 'src', ?)`,
      args: [now, now],
    })
    await expect(db.execute({
      sql: "UPDATE paper_fills SET price_cents = 1 WHERE id = 'f1'",
      args: [],
    })).rejects.toThrow(/append-only/)
    await expect(db.execute({
      sql: "DELETE FROM paper_fills WHERE id = 'f1'",
      args: [],
    })).rejects.toThrow(/append-only/)

    // 净值同样只追加：改历史净值会让收益/回撤与阶段门追溯失效。
    await db.execute({
      sql: `INSERT INTO paper_nav (account_id, trade_date, cash_cents, total_equity_cents, created_at)
            VALUES ('a1', '2026-11-24', 100, 100, ?)`,
      args: [now],
    })
    await expect(db.execute({
      sql: "UPDATE paper_nav SET total_equity_cents = 200 WHERE account_id = 'a1'",
      args: [],
    })).rejects.toThrow(/append-only/)
    await expect(db.execute({
      sql: "DELETE FROM paper_nav WHERE account_id = 'a1'",
      args: [],
    })).rejects.toThrow(/append-only/)
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
