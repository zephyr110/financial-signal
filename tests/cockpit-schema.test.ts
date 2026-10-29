import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, afterAll, vi } from 'vitest'

/**
 * 驾驶舱表结构：旧库只补表、新库一次建齐；任务幂等键和来源文档外部 ID
 * 必须由数据库拒绝重复，不能只靠应用层判断。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-schema-test-'))

async function loadDb(file: string) {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = file
  vi.resetModules()
  return import('../lib/db')
}

const now = '2026-10-22T08:00:00.000Z'

describe('cockpit schema', () => {
  it('建齐驾驶舱表，并强制任务幂等键唯一', async () => {
    const { getDb } = await loadDb(path.join(dir, 'schema.db'))
    const db = await getDb()

    const tables = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table'",
      args: [],
    })
    const names = tables.rows.map((r) => String(r.name))
    for (const t of [
      'symbols', 'trading_calendar', 'source_registry', 'source_documents',
      'market_bars', 'market_overview', 'fact_snapshots', 'validation_runs',
      'reports', 'theses', 'thesis_evidence', 'portfolio_accounts',
      'positions', 'journal_entries', 'watchlist_items', 'tasks',
      'task_events', 'notifications', 'llm_usage',
    ]) {
      expect(names).toContain(t)
    }

    await db.execute({
      sql: `INSERT INTO tasks
        (id, type, params_json, status, idempotency_key, created_at)
        VALUES (?, ?, ?, 'queued', ?, ?)`,
      args: ['t1', 'daily_brief', '{}', 'same-key', now],
    })
    await expect(db.execute({
      sql: `INSERT INTO tasks
        (id, type, params_json, status, idempotency_key, created_at)
        VALUES (?, ?, ?, 'queued', ?, ?)`,
      args: ['t2', 'daily_brief', '{}', 'same-key', now],
    })).rejects.toThrow(/UNIQUE/i)

    await db.execute({
      sql: `INSERT INTO source_documents
        (id, source_id, doc_type, external_id, title, published_at, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['d1', 'exchange', 'announcement', 'ext-1', '示例公告', now, now],
    })
    await expect(db.execute({
      sql: `INSERT INTO source_documents
        (id, source_id, doc_type, external_id, title, published_at, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['d2', 'exchange', 'announcement', 'ext-1', '重复公告', now, now],
    })).rejects.toThrow(/UNIQUE/i)
  })

  it('重复加载不重建、不丢数据', async () => {
    const file = path.join(dir, 'idem.db')
    const { getDb } = await loadDb(file)
    const db = await getDb()
    await db.execute({
      sql: `INSERT INTO watchlist_items (code, note, created_at) VALUES (?, ?, ?)`,
      args: ['600519.SH', 'demo', now],
    })

    vi.resetModules()
    const mod = await import('../lib/db')
    const db2 = await mod.getDb()
    const version = await db2.execute({
      sql: 'SELECT MAX(version) AS v FROM schema_migrations',
      args: [],
    })
    expect(Number(version.rows[0].v)).toBe(9)
    const rows = await db2.execute({ sql: 'SELECT COUNT(*) AS n FROM watchlist_items', args: [] })
    expect(Number(rows.rows[0].n)).toBe(1)
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
