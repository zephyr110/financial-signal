import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, afterAll, vi } from 'vitest'
import { createClient } from '@libsql/client'

/**
 * 版本化 schema 迁移测试（schema_migrations 表）：
 *  - 新库（无任何版本记录）→ 依序跑到最新版本，表结构齐全
 *  - 老库（旧结构，无 docurl / 无 dedup_key）→ 补齐列、历史去重、回填幂等键
 *  - 遗留老库（PRAGMA user_version=3 + 旧明文会话，无版本表）→ max() 合并 + 回填 + 只跑 v4
 *  - 迁移幂等：重复启动不报错、不重复副作用
 * 每个用例用独立 DB 文件 + vi.resetModules 重载 lib/db（模块级 client 单例）。
 * 隔离:删除 Turso 环境变量——迁移测试含去重 DELETE/INSERT,严禁连共享远程库。
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
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = file
  vi.resetModules()
  const mod = await import('../lib/db')
  return mod
}

/** 还原旧版 migrate 遗留的真实老库:PRAGMA user_version=3(旧机制写)、
 * v1+v2+v3 结构已应用、app_session 表存在但无 user_id 列且存旧明文 token、
 * 无 schema_migrations 表。升级时应:回填 {1,2,3} → 只跑 v4 → 表 {1,2,3,4}。 */
async function buildLegacyDb(file: string) {
  const db = createClient({ url: `file:${file}` })
  await db.executeMultiple(`
    CREATE TABLE news_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, source_id TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL, published_at TEXT NOT NULL,
      docurl TEXT
    );
    CREATE TABLE event_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, news_ids TEXT NOT NULL, narrative TEXT NOT NULL,
      stage TEXT NOT NULL, confidence TEXT NOT NULL,
      industries TEXT, watch_points TEXT,
      dedup_key TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE app_account (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL
    );
    CREATE TABLE app_session (
      token TEXT PRIMARY KEY,
      expires_at TEXT NOT NULL
    );
    INSERT INTO app_account (username, password_hash, salt) VALUES
      ('admin', 'x', 'x');
    INSERT INTO app_session (token, expires_at) VALUES
      ('oldplain', '2099-01-01T00:00:00.000Z');
  `)
  await db.execute({ sql: 'PRAGMA user_version = 3', args: [] })
  await db.close()
}

describe('schema migration (schema_migrations 表)', () => {
  it('新库:依序迁移到最新版本,核心表齐全', async () => {
    const newFile = path.join(dir, 'new.db')
    const { getDb } = await loadDb(newFile)
    const db = await getDb()

    const r = await db.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations', args: [] })
    expect(Number(r.rows[0].v)).toBe(4)

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
    // v4:app_session.user_id 列(新库由 v1 建表 + v4 ALTER 得到)
    const sessionCols = await db.execute({ sql: 'PRAGMA table_info(app_session)', args: [] })
    expect(sessionCols.rows.some((c) => c.name === 'user_id')).toBe(true)
  })

  it('老库升级:补 docurl/dedup_key 列、历史重复标题去重、回填幂等键、版本号推进', async () => {
    const oldFile = path.join(dir, 'old.db')
    await buildOldDb(oldFile)
    const { getDb } = await loadDb(oldFile)
    const db = await getDb()

    const r = await db.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations', args: [] })
    expect(Number(r.rows[0].v)).toBe(4)

    const newsCols = await db.execute({ sql: 'PRAGMA table_info(news_archive)', args: [] })
    expect(newsCols.rows.some((c) => c.name === 'docurl')).toBe(true)

    const threadCols = await db.execute({ sql: 'PRAGMA table_info(event_threads)', args: [] })
    expect(threadCols.rows.some((c) => c.name === 'dedup_key')).toBe(true)
    // v4:老库(无 app_session 表)迁移后同样带 user_id 列
    const sessionCols = await db.execute({ sql: 'PRAGMA table_info(app_session)', args: [] })
    expect(sessionCols.rows.some((c) => c.name === 'user_id')).toBe(true)

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

  it('遗留老库(PRAGMA=3 + 旧明文会话):回填版本表、只跑 v4、旧会话自然失效', async () => {
    const file = path.join(dir, 'legacy.db')
    await buildLegacyDb(file)
    const { getDb } = await loadDb(file)
    const db = await getDb()

    // 版本表:PRAGMA=3 回填 {1,2,3},再跑 v4 → {1,2,3,4}(单一记录源,无双轨错位)
    const versions = await db.execute({
      sql: 'SELECT version FROM schema_migrations ORDER BY version',
      args: [],
    })
    expect(versions.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4])

    // v2/v3 列保持(不重跑);v4 补 user_id 列
    const newsCols = await db.execute({ sql: 'PRAGMA table_info(news_archive)', args: [] })
    expect(newsCols.rows.some((c) => c.name === 'docurl')).toBe(true)
    const sessionCols = await db.execute({ sql: 'PRAGMA table_info(app_session)', args: [] })
    expect(sessionCols.rows.some((c) => c.name === 'user_id')).toBe(true)

    // 旧明文会话行保留但 user_id=NULL → getSessionUser 的 JOIN 匹配不到 → 自然失效
    const rows = await db.execute({ sql: 'SELECT token, user_id FROM app_session', args: [] })
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0].user_id).toBeNull()
    vi.resetModules()
    const auth = await import('../lib/auth')
    expect(await auth.getSessionUser('oldplain')).toBeNull()

    // 再次启动(新模块实例):版本已最新,零迁移,版本表不变
    vi.resetModules()
    const mod2 = await import('../lib/db')
    const db2 = await mod2.getDb()
    const versions2 = await db2.execute({
      sql: 'SELECT version FROM schema_migrations ORDER BY version',
      args: [],
    })
    expect(versions2.rows.map((r) => Number(r.version))).toEqual([1, 2, 3, 4])
  })

  it('迁移幂等:已是最新版本时再次加载不报错、不改动数据', async () => {
    const file = path.join(dir, 'idem.db')
    const { getDb } = await loadDb(file)
    const db = await getDb()
    await db.execute({
      sql: "INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, dedup_key) VALUES ('测试线程', '[]', 'n', 'early', 'high', '测试线程')",
      args: [],
    })

    // 重新加载(新模块实例 + 同一文件)→ 版本已最新,迁移跳过
    vi.resetModules()
    const mod2 = await import('../lib/db')
    const db2 = await mod2.getDb()
    const r = await db2.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations', args: [] })
    expect(Number(r.rows[0].v)).toBe(4)

    const rows = await db2.execute({ sql: 'SELECT COUNT(*) as n FROM event_threads', args: [] })
    expect(Number(rows.rows[0].n)).toBe(1)
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
