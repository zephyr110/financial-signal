import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, vi } from 'vitest'
import { createClient } from '@libsql/client'

/**
 * 版本化 schema 迁移测试（PRAGMA user_version）：
 *  - 新库（user_version=0）→ 依序跑到最新版本，表结构齐全
 *  - 老库（旧结构，无 docurl / 无 dedup_key）→ 补齐列、历史去重、回填幂等键
 *  - 迁移幂等：重复启动不报错、不重复副作用
 * 每个用例用独立 DB 文件 + vi.resetModules 重载 lib/db（模块级 client 单例）。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-migration-test-'))

/** 手工造一个旧结构库：无 docurl 列、event_threads 无 dedup_key，含重复标题行。 */
async function buildOldDb(file: string) {
  const db = createClient({ url: `file:${file}` })
  await db.executeMultiple(`
    CREATE TABLE news_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, source_id TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL, published_at TEXT NOT NULL
    );
    CREATE TABLE event_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, news_ids TEXT NOT NULL, narrative TEXT NOT NULL,
      stage TEXT NOT NULL, confidence TEXT NOT NULL,
      industries TEXT, watch_points TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO news_archive (source, source_id, title, content, published_at)
      VALUES ('sina', 's1', 't', 'c1', '2026-08-23T00:00:00Z');
    INSERT INTO event_threads (title, news_ids, narrative, stage, confidence) VALUES
      (' 央行降准 ', '[]', 'n1', 'early', 'high'),
      ('央行降准', '[]', 'n2', 'brewing', 'high');
  `)
  await db.close()
}

async function loadDb(file: string) {
  process.env.NEWS_DB_PATH = file
  vi.resetModules()
  const mod = await import('../lib/db')
  return mod
}

describe('schema migration (PRAGMA user_version)', () => {
  it('新库:依序迁移到最新版本,核心表齐全', async () => {
    const newFile = path.join(dir, 'new.db')
    const { getDb } = await loadDb(newFile)
    const db = await getDb()

    const r = await db.execute({ sql: 'PRAGMA user_version', args: [] })
    expect(Number(r.rows[0].user_version)).toBe(3)

    const tables = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type='table'",
      args: [],
    })
    const names = tables.rows.map((t) => t.name)
    for (const t of ['news_archive', 'analysis_result', 'event_threads', 'market_data', 'backtest_result', 'event_log', 'pipeline_run', 'pipeline_cursor', 'agent_session', 'agent_message', 'agent_share', 'app_account', 'app_session', 'app_settings']) {
      expect(names).toContain(t)
    }

    // 新库建表即含 docurl 与 dedup_key,且唯一索引已建
    const newsCols = await db.execute({ sql: 'PRAGMA table_info(news_archive)', args: [] })
    expect(newsCols.rows.some((c) => c.name === 'docurl')).toBe(true)
    const threadCols = await db.execute({ sql: 'PRAGMA table_info(event_threads)', args: [] })
    expect(threadCols.rows.some((c) => c.name === 'dedup_key')).toBe(true)
  })

  it('老库升级:补 docurl/dedup_key 列、历史重复标题去重、回填幂等键、版本号推进', async () => {
    const oldFile = path.join(dir, 'old.db')
    await buildOldDb(oldFile)
    const { getDb } = await loadDb(oldFile)
    const db = await getDb()

    const r = await db.execute({ sql: 'PRAGMA user_version', args: [] })
    expect(Number(r.rows[0].user_version)).toBe(3)

    const newsCols = await db.execute({ sql: 'PRAGMA table_info(news_archive)', args: [] })
    expect(newsCols.rows.some((c) => c.name === 'docurl')).toBe(true)

    const threadCols = await db.execute({ sql: 'PRAGMA table_info(event_threads)', args: [] })
    expect(threadCols.rows.some((c) => c.name === 'dedup_key')).toBe(true)

    // 同标题(规范化后)只保留一行
    const threads = await db.execute({ sql: 'SELECT title, dedup_key FROM event_threads ORDER BY id', args: [] })
    expect(threads.rows).toHaveLength(1)
    expect(threads.rows[0].dedup_key).toBe('央行降准')

    // 唯一索引存在且可防重复插入
    await expect(
      db.execute({
        sql: "INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key) VALUES ('央行降准', '[]', 'n3', 'early', 'high', '央行降准')",
        args: [],
      }),
    ).rejects.toThrow(/UNIQUE/i)
  })

  it('迁移幂等:已是最新版本时再次加载不报错、不改动数据', async () => {
    const file = path.join(dir, 'idem.db')
    const { getDb } = await loadDb(file)
    const db = await getDb()
    await db.execute({
      sql: "INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key) VALUES ('测试线程', '[]', 'n', 'early', 'high', '测试线程')",
      args: [],
    })

    // 重新加载(新模块实例 + 同一文件)→ user_version 已最新,迁移跳过
    vi.resetModules()
    const mod2 = await import('../lib/db')
    const db2 = await mod2.getDb()
    const r = await db2.execute({ sql: 'PRAGMA user_version', args: [] })
    expect(Number(r.rows[0].user_version)).toBe(3)

    const rows = await db2.execute({ sql: 'SELECT COUNT(*) as n FROM event_threads', args: [] })
    expect(Number(rows.rows[0].n)).toBe(1)
  })
})
