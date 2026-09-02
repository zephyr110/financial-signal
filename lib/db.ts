import { createClient } from '@libsql/client';
import crypto from 'crypto';
import path from 'path';

/**
 * Turso when TURSO_DATABASE_URL is set; otherwise local file SQLite for dev.
 * On Vercel, TURSO_DATABASE_URL is required (no ephemeral /tmp fallback).
 */
function resolveClientConfig() {
  // 测试必须隔离在本地文件库:测试含破坏性操作(改密/清会话/去重 DELETE),
  // 若开发机 shell 导出了 TURSO_DATABASE_URL(生产标配),不经此分支会直连共享库
  if (process.env.NODE_ENV === 'test') {
    const filePath = process.env.NEWS_DB_PATH || path.join(process.cwd(), 'news_archive.db');
    return { url: `file:${filePath}` };
  }
  const url = process.env.TURSO_DATABASE_URL;
  if (url) {
    return {
      url,
      authToken: process.env.TURSO_AUTH_TOKEN,
    };
  }
  if (process.env.VERCEL) {
    throw new Error(
      'TURSO_DATABASE_URL is required on Vercel. Create a Turso DB and set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.'
    );
  }
  const filePath = process.env.NEWS_DB_PATH || path.join(process.cwd(), 'news_archive.db');
  return { url: `file:${filePath}` };
}

/** 远程 Turso(URL 非 file:)vs 本地文件库——迁移起点/PRAGMA 行为据此分支。 */
function isTursoConfig(): boolean {
  return !resolveClientConfig().url.startsWith('file:');
}

let client;
let schemaReady;

export async function getDb() {
  if (!client) {
    client = createClient(resolveClientConfig());
  }
  let m = schemaReady;
  if (!m) {
    m = migrate(client);
    schemaReady = m;
  }
  try {
    await m;
  } catch (err) {
    // 迁移失败可重试:瞬时网络错误/并发 ALTER 竞态不应把实例永久毒化
    // (仅当仍是我们观察的同一个 promise 时才重置,避免清掉并发请求刚建的新迁移)
    if (schemaReady === m) schemaReady = undefined;
    throw err;
  }
  return client;
}

// ────────────────────────────────────────────────────────────
// 版本化 schema 迁移（替代 ad-hoc ALTER 猜列）。
// - 版本号记录在 schema_migrations 表（version 主键）：Turso 远程库禁止
//   `PRAGMA user_version = N` 写入（SQL_PARSE_ERROR），表记录跨 Turso/本地通用
// - 起点 = max(PRAGMA 读, 版本表)——本地老库（PRAGMA 仍存 1-3）直接跳到缺失版本；
//   Turso 库 PRAGMA 恒 0，从 v1 依序补跑（各 up 均幂等，老表 IF NOT EXISTS 跳过）
// - 每个迁移的 up() 必须幂等：老库缺列/已存在都能安全重跑（启动中断后从断点续跑）
// - 新库版本 0 → 依序执行全部迁移；老库只跑缺失版本
// ────────────────────────────────────────────────────────────

const MIGRATIONS: Array<{ version: number; name: string; up: (db) => Promise<void> }> = [
  { version: 1, name: '基线表结构(建表+索引)', up: baselineSchema },
  { version: 2, name: 'news_archive.docurl 列', up: migrationAddDocurl },
  { version: 3, name: 'event_threads.dedup_key + 历史去重', up: migrationThreadDedup },
  { version: 4, name: 'app_session.user_id(会话按用户关联+token 存哈希)', up: migrationSessionUserId },
  { version: 5, name: 'backtest_result.direction(方向命中率:多/空/中性/混合)', up: migrationBacktestDirection },
];

/** v5：backtest_result 补 direction 列（事件极性:long/short/neutral/mixed;NULL=迁移前遗留）。
 * 幂等 ALTER 仿 v2 docurl:列已存在则跳过。方向由 runBacktest 按当日信号 sentiment 聚合写入,
 * 命中率分母只计 long/short,中性/混合/遗留不计(见 lib/market.ts 方向化 SQL)。 */
async function migrationBacktestDirection(db) {
  const cols = await db.execute({ sql: 'PRAGMA table_info(backtest_result)', args: [] });
  if (!cols.rows.some((c) => c.name === 'direction')) {
    try {
      await db.execute({ sql: 'ALTER TABLE backtest_result ADD COLUMN direction TEXT', args: [] });
    } catch { /* 并发实例已先补列 */ }
  }
}

async function migrate(db) {
  // 版本记录表(迁移机制自身的表;PRAGMA 写在 Turso 被拒,统一用表记录)
  await db.execute({
    sql: "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    args: [],
  });
  // 起点取 PRAGMA 与版本表较大者:本地老库 PRAGMA 仍存 1-3(可直接跳到缺失版本),
  // Turso 库 PRAGMA 恒 0(读也是每冷启动实例一趟往返)→ 直接跳过读取,从表记录起步
  let pragmaVersion = 0;
  if (!isTursoConfig()) {
    try {
      const r = await db.execute({ sql: 'PRAGMA user_version', args: [] });
      pragmaVersion = Number(r.rows[0]?.user_version || 0);
    } catch (err) {
      // 本地文件读 PRAGMA 不应失败;真失败时不能静默——降级按 0 并留痕可排查
      console.warn('[db] PRAGMA user_version 读取失败,按 0 处理:', (err as Error).message);
    }
  }
  let tableVersion = 0;
  const vRows = await db.execute({
    sql: 'SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations',
    args: [],
  });
  tableVersion = Number(vRows.rows[0]?.v || 0);
  // 老库(旧 PRAGMA 机制)首次升级:把 1..PRAGMA 回填进版本表,此后单一记录源,
  // 避免"表只记 {4}、PRAGMA 3 永不推进"的双轨错位
  if (pragmaVersion > tableVersion) {
    for (let v = tableVersion + 1; v <= pragmaVersion; v++) {
      await db.execute({
        sql: 'INSERT OR REPLACE INTO schema_migrations (version) VALUES (?)',
        args: [v],
      });
    }
    tableVersion = pragmaVersion;
  }
  const latest = MIGRATIONS[MIGRATIONS.length - 1].version;
  if (tableVersion >= latest) return;
  for (const m of MIGRATIONS) {
    if (m.version <= tableVersion) continue;
    await m.up(db);
    await db.execute({
      sql: 'INSERT OR REPLACE INTO schema_migrations (version) VALUES (?)',
      args: [m.version],
    });
    console.log(`[db] schema migration v${m.version} (${m.name}) applied`);
  }
}

/** v1：基线表结构（全部 CREATE TABLE IF NOT EXISTS + 索引；建表语句含 docurl 列定义，
 *  老库已存在的表由 IF NOT EXISTS 跳过，缺列由 v2 补）。 */
async function baselineSchema(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS news_archive (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source        TEXT    NOT NULL,
      source_id     TEXT    NOT NULL,
      title         TEXT,
      content       TEXT    NOT NULL,
      published_at  TEXT    NOT NULL,
      fetched_at    TEXT    NOT NULL DEFAULT (datetime('now')),
      docurl        TEXT,             -- 原文链接（新浪 feed 提供）
      UNIQUE(source, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_news_published ON news_archive(published_at);
    CREATE INDEX IF NOT EXISTS idx_news_source    ON news_archive(source);

    CREATE TABLE IF NOT EXISTS analysis_result (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id       INTEGER NOT NULL UNIQUE REFERENCES news_archive(id),
      signal_score  INTEGER NOT NULL CHECK(signal_score BETWEEN 1 AND 5),
      category      TEXT    NOT NULL,
      impact_level  TEXT    NOT NULL CHECK(impact_level IN ('critical','significant','moderate','minor','noise')),
      industries    TEXT,
      companies     TEXT,
      sentiment     TEXT    NOT NULL CHECK(sentiment IN ('positive','negative','neutral','mixed')),
      summary       TEXT    NOT NULL,
      deep_analysis TEXT,
      tags          TEXT,
      related_ids   TEXT,
      event_thread_id TEXT,
      analyzed_at   TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_analysis_score    ON analysis_result(signal_score);
    CREATE INDEX IF NOT EXISTS idx_analysis_category ON analysis_result(category);
    CREATE INDEX IF NOT EXISTS idx_analysis_news     ON analysis_result(news_id);

    CREATE TABLE IF NOT EXISTS event_threads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      news_ids      TEXT    NOT NULL,  -- JSON: [analysis_id, ...]
      narrative     TEXT    NOT NULL,
      stage         TEXT    NOT NULL,  -- early|brewing|spreading|priced_in
      confidence    TEXT    NOT NULL,  -- high|medium
      industries    TEXT,              -- JSON: ["industry", ...]
      watch_points  TEXT,              -- JSON: ["point", ...]
      dedup_key     TEXT,              -- 幂等键：规范化 title（v3 迁移）
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_threads_created ON event_threads(created_at);

    CREATE TABLE IF NOT EXISTS market_data (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      code        TEXT    NOT NULL,
      name        TEXT    NOT NULL,
      type        TEXT    NOT NULL CHECK(type IN ('industry','index')),
      trade_date  TEXT    NOT NULL,
      close       REAL,
      change_pct  REAL,
      volume      REAL,
      UNIQUE(code, trade_date)
    );
    CREATE INDEX IF NOT EXISTS idx_market_date ON market_data(trade_date);

    CREATE TABLE IF NOT EXISTS backtest_result (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_date   TEXT NOT NULL,
      industry      TEXT NOT NULL,
      signal_score  INTEGER NOT NULL,
      signal_count  INTEGER NOT NULL,
      direction     TEXT,
      day_1_return  REAL,
      day_3_return  REAL,
      day_7_return  REAL,
      calculated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(signal_date, industry)
    );

    -- 领域事件日志（append-only，spec §10.2 原则2"模型可见即记录"）
    CREATE TABLE IF NOT EXISTS event_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT    NOT NULL,
      entity_id  INTEGER,
      payload    TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_event_type    ON event_log(event_type);
    -- 事件日志只按 id 倒序读取（getEventLog），created_at/entity_id 索引徒增写入开销（C11）
    DROP INDEX IF EXISTS idx_event_created;
    DROP INDEX IF EXISTS idx_event_entity;

    -- 数据管线任务状态机（P1.1）：每次 cron 调用的生命周期
    CREATE TABLE IF NOT EXISTS pipeline_run (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name        TEXT    NOT NULL,  -- fetch | analyze | deep-analyze | event-threads | fetch-market
      batch_id        TEXT    NOT NULL,  -- 调用方批次标识（QStash 消息 ID 或小时时间窗）
      retry_count     INTEGER NOT NULL DEFAULT 0,
      status          TEXT    NOT NULL,  -- running | success | failed
      items_processed INTEGER,
      error           TEXT,
      started_at      TEXT    NOT NULL,  -- ISO 格式（与 news_archive.published_at 一致）
      finished_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_job_time ON pipeline_run(job_name, started_at);

    -- 批处理游标（P1.3）：记录各 job 已处理到的最大 news_id，支持增量续跑
    CREATE TABLE IF NOT EXISTS pipeline_cursor (
      job_name     TEXT PRIMARY KEY,  -- analyze | deep-analyze
      last_news_id INTEGER NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL
    );

    -- 研究 Agent 会话（spec §10.3 阶段 B，Session Note 式持久记忆）
    CREATE TABLE IF NOT EXISTS agent_session (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      title      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agent_message (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES agent_session(id),
      role       TEXT    NOT NULL,   -- user | assistant | system(摘要)
      content    TEXT    NOT NULL,
      meta       TEXT,               -- JSON: {toolCall, toolResult}
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_msg_session ON agent_message(session_id, id);

    -- 会话分享（公开只读链接）：token 即访问凭据，无需鉴权
    CREATE TABLE IF NOT EXISTS agent_share (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      token      TEXT    NOT NULL UNIQUE,
      session_id INTEGER NOT NULL REFERENCES agent_session(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_share_session ON agent_share(session_id);

    -- 登录账号（单账号）与会话、运行设置（运行时覆盖环境变量）
    CREATE TABLE IF NOT EXISTS app_account (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      salt          TEXT    NOT NULL,
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS app_session (
      token      TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

/** v2：老库补 docurl 列（新库 v1 建表已含；列已存在时静默跳过）。
 * 并发冷启动时多实例同时补列,后到者会撞 duplicate column name——与 v3 一样
 * try/catch 兜住(SQLite 无 ADD COLUMN IF NOT EXISTS)。 */
async function migrationAddDocurl(db) {
  const cols = await db.execute({ sql: 'PRAGMA table_info(news_archive)', args: [] });
  if (!cols.rows.some((c) => c.name === 'docurl')) {
    try {
      await db.execute({ sql: 'ALTER TABLE news_archive ADD COLUMN docurl TEXT', args: [] });
    } catch { /* 并发实例已先补列 */ }
  }
}

/** v3：event_threads 补 dedup_key 幂等键（P1.2）+ 历史去重 + 回填 + 唯一索引。
 * 每步独立幂等：列已存在/表不存在/唯一索引已建时静默跳过，老库重跑安全——
 * 不设 early-return：列已存在时仍继续去重/回填（中断后从断点续跑，断点续跑契约）。
 * 注：libsql 字符串形式 execute 在本地 file: 库上会 native panic，统一用单对象形式。 */
async function migrationThreadDedup(db) {
  const cols = await db.execute({ sql: 'PRAGMA table_info(event_threads)', args: [] });
  if (!cols.rows.some((c) => c.name === 'dedup_key')) {
    try {
      await db.execute({ sql: 'ALTER TABLE event_threads ADD COLUMN dedup_key TEXT', args: [] });
    } catch { /* column already exists */ }
  }
  // 合并历史重复：同规范化标题只保留最新一行（首次迁移时执行一次）
  try {
    await db.execute({
      sql: `
        DELETE FROM event_threads
        WHERE id NOT IN (SELECT MAX(id) FROM event_threads GROUP BY lower(trim(title)))
      `,
      args: [],
    });
  } catch { /* dedup_key 列尚未存在 */ }
  // 回填幂等键（对历史行；新行由 saveEventThreads 写入）
  try {
    await db.execute({
      sql: 'UPDATE event_threads SET dedup_key = lower(trim(title)) WHERE dedup_key IS NULL',
      args: [],
    });
  } catch { /* dedup_key 列尚未存在 */ }
  try {
    await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_dedup ON event_threads(dedup_key)', args: [] });
  } catch { /* dedup_key 列尚未存在 */ }
}

/** v4：app_session 加 user_id（会话按用户关联,后续可单独吊销某账号会话）。
 * 已发布的迁移不可改(v1 建表保持原样),新库同样走 v1+v4 得到一致结构。
 * 旧行 user_id 为 NULL → JOIN 匹配不到 → 旧明文 token 会话自然失效(单账号,重登一次即可);
 * 死行由 getSessionUser 的过期清理按 user_id IS NULL 慢慢清除(见 auth.ts)。
 * SQLite 的 ADD COLUMN 不带 REFERENCES 子句(默认 NULL,合法)。
 * 并发冷启动时后到的 ALTER 会撞 duplicate column name——与 v3 一样 try/catch 兜住。 */
async function migrationSessionUserId(db) {
  const cols = await db.execute({ sql: 'PRAGMA table_info(app_session)', args: [] });
  if (!cols.rows.some((c) => c.name === 'user_id')) {
    try {
      await db.execute({ sql: 'ALTER TABLE app_session ADD COLUMN user_id INTEGER', args: [] });
    } catch { /* 并发实例已先补列 */ }
  }
}

function rowId(value) {
  if (value == null) return null;
  return typeof value === 'bigint' ? Number(value) : value;
}

// --- News CRUD ---

/** Insert a news item. Returns the row id, or null if already exists (duplicate). */
export async function insertNews({ source, source_id, title, content, published_at, docurl = null }) {
  const db = await getDb();
  const result = await db.execute({
    sql: `
      INSERT OR IGNORE INTO news_archive (source, source_id, title, content, published_at, docurl)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    args: [source, source_id, title ?? null, content, published_at, docurl],
  });
  if (result.rowsAffected === 0) return null;
  return rowId(result.lastInsertRowid);
}

/** Batch insert news items. Returns count of newly inserted rows. */
export async function insertNewsBatch(items) {
  if (!items || items.length === 0) return 0;
  const db = await getDb();
  let inserted = 0;
  // Build multi-value INSERT; SQLite supports up to ~500 params per statement
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    const values = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
    const args = batch.flatMap(item => [
      item.source, item.source_id, item.title ?? null, item.content, item.published_at, item.docurl ?? null,
    ]);
    try {
      const result = await db.execute({
        sql: `INSERT OR IGNORE INTO news_archive (source, source_id, title, content, published_at, docurl) VALUES ${values}`,
        args,
      });
      inserted += result.rowsAffected || 0;
    } catch (err) {
      console.error('[db] Batch insert error:', err.message);
    }
  }
  return inserted;
}

// --- 批处理游标（P1.3） ---

/** 读取游标：该 job 已处理到的最大 news_id（无记录返回 0）。 */
export async function getPipelineCursor(jobName) {
  const db = await getDb();
  const r = await db.execute({
    sql: 'SELECT last_news_id FROM pipeline_cursor WHERE job_name = ?',
    args: [jobName],
  });
  return Number(r.rows[0]?.last_news_id || 0);
}

/** 推进游标（单调递增；ON CONFLICT 幂等）。 */
export async function setPipelineCursor(jobName, lastNewsId) {
  const db = await getDb();
  await db.execute({
    sql: `INSERT INTO pipeline_cursor (job_name, last_news_id, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(job_name) DO UPDATE SET
            last_news_id = excluded.last_news_id,
            updated_at = excluded.updated_at`,
    args: [jobName, lastNewsId, new Date().toISOString()],
  });
}

/**
 * 游标自愈：游标之前的未处理条目（分析失败/跳过残留）超过阈值时
 * 重置游标回 0 重试（已分析条目幂等跳过，仅失败条目消耗 LLM）。
 */
export async function resetStuckCursor(jobName, cursor, threshold = 20) {
  if (cursor <= 0) return cursor;
  const db = await getDb();
  const r = await db.execute({
    sql: `SELECT COUNT(*) as n
          FROM news_archive n
          LEFT JOIN analysis_result a ON a.news_id = n.id
          WHERE a.id IS NULL AND n.id <= ?`,
    args: [cursor],
  });
  if (Number(r.rows[0]?.n || 0) > threshold) {
    console.warn(`[cursor] ${jobName}: ${r.rows[0].n} items stuck before cursor ${cursor}, resetting to 0`);
    await setPipelineCursor(jobName, 0);
    return 0;
  }
  return cursor;
}

/** Get analyzed news (signal ≥ 3) without deep analysis for Step 2 processing. */
export async function getNeedsDeepAnalysis(limit = 30, afterId = 0) {
  const db = await getDb();
  const result = await db.execute({
    sql: `
      SELECT n.*, a.signal_score, a.category, a.industries, a.companies, a.summary
      FROM news_archive n
      JOIN analysis_result a ON a.news_id = n.id
      WHERE a.signal_score >= 3 AND a.deep_analysis IS NULL AND n.id > ?
      ORDER BY n.id ASC
      LIMIT ?
    `,
    args: [afterId, limit],
  });
  return result.rows;
}

/** Get high-signal news (≥3) from the past N hours for event thread detection. */
export async function getHighSignalNews(hoursBack = 24, limit = 100) {
  const db = await getDb();
  const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT n.*, a.id as analysis_id, a.signal_score, a.category, a.industries, a.companies,
             a.sentiment, a.summary, a.deep_analysis, a.tags
      FROM news_archive n
      JOIN analysis_result a ON a.news_id = n.id
      WHERE a.signal_score >= 3 AND n.published_at >= ?
      ORDER BY n.published_at DESC
      LIMIT ?
    `,
    args: [since, limit],
  });
  return result.rows;
}

/** Batch update deep analysis results for Phase 2 Step 2. */
export async function updateDeepAnalysis(newsId, { industries, companies, tags, deepAnalysis }) {
  const db = await getDb();
  return db.execute({
    sql: `UPDATE analysis_result SET industries = ?, companies = ?, tags = ?, deep_analysis = ? WHERE news_id = ?`,
    args: [
      industries ? JSON.stringify(industries) : null,
      companies ? JSON.stringify(companies) : null,
      tags ? JSON.stringify(tags) : null,
      deepAnalysis || null,
      newsId,
    ],
  });
}

/** Get news items that haven't been analyzed yet, newest published_at first.
 * 按发布时间倒序：新新闻优先分析，避免历史积压（FIFO by id）饿死新数据
 * （抓取量远大于分析吞吐时，id 升序会让新新闻永远排在积压之后）。
 * 仅取最近 30 天（回测窗口上限），更旧的积压视为过期跳过。
 * LEFT JOIN 已保证幂等，游标参数保留仅为兼容调用方。 */
export async function getUnanalyzedNews(limit = 50, afterId = 0) {
  const db = await getDb();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT n.* FROM news_archive n
      LEFT JOIN analysis_result a ON a.news_id = n.id
      WHERE a.id IS NULL AND n.published_at >= ?
      ORDER BY n.published_at DESC
      LIMIT ?
    `,
    args: [since, limit],
  });
  return result.rows;
}

/**
 * Archived news for the home timeline.
 * @param {{ daysBack?: number, limit?: number }} opts
 */
export async function getArchivedNews({ daysBack = 7, limit = 500 } = {}) {
  const db = await getDb();
  const safeDays = Number.isFinite(daysBack) && daysBack > 0 ? daysBack : 7;
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 2000) : 500;
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT id, source, source_id, title, content, published_at, docurl
      FROM news_archive
      WHERE published_at >= ?
      ORDER BY published_at DESC
      LIMIT ?
    `,
    args: [since, safeLimit],
  });
  return result.rows;
}

/** Get list of distinct dates with news in the past N days. */
export async function getAvailableDates(daysBack = 7) {
  const db = await getDb();
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `SELECT DISTINCT DATE(published_at) as date FROM news_archive
          WHERE published_at >= ?
          ORDER BY date DESC`,
    args: [since],
  });
  return result.rows.map(r => r.date);
}

/** Get news for a specific date. */
export async function getNewsByDate(date: string, limit = 200) {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT id, source, source_id, title, content, published_at
          FROM news_archive
          WHERE DATE(published_at) = ?
          ORDER BY published_at DESC
          LIMIT ?`,
    args: [date, limit],
  });
  return result.rows;
}

// --- Analysis CRUD ---

/** Insert an analysis result. */
export async function insertAnalysis({
  news_id, signal_score, category, impact_level, industries, companies,
  sentiment, summary, deep_analysis, tags,
}) {
  const db = await getDb();
  return db.execute({
    sql: `
      INSERT INTO analysis_result (news_id, signal_score, category, impact_level, industries, companies, sentiment, summary, deep_analysis, tags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(news_id) DO UPDATE SET
        signal_score = excluded.signal_score,
        category = excluded.category,
        impact_level = excluded.impact_level,
        industries = excluded.industries,
        companies = excluded.companies,
        sentiment = excluded.sentiment,
        summary = excluded.summary,
        deep_analysis = excluded.deep_analysis,
        tags = excluded.tags,
        analyzed_at = datetime('now')
    `,
    args: [
      news_id,
      signal_score,
      category,
      impact_level,
      industries ? JSON.stringify(industries) : null,
      companies ? JSON.stringify(companies) : null,
      sentiment,
      summary,
      deep_analysis || null,
      tags ? JSON.stringify(tags) : null,
    ],
  });
}

/** Get analyzed news with their original content, joined. */
export async function getAnalyzedNews({ minScore = 1, limit = 50, hoursBack = 24, cursor = 0 } = {}) {
  const db = await getDb();
  const safeHours = Number.isFinite(hoursBack) && hoursBack > 0 ? hoursBack : 24;
  const safeMin = Number.isFinite(minScore) ? Math.min(5, Math.max(1, minScore)) : 1;
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT n.*, a.id as analysis_id, a.signal_score, a.category, a.impact_level, a.industries, a.companies,
             a.sentiment, a.summary, a.deep_analysis, a.tags, a.analyzed_at
      FROM news_archive n
      JOIN analysis_result a ON a.news_id = n.id
      WHERE a.signal_score >= ?
        AND n.published_at >= ?
        AND a.id < ?
      ORDER BY a.id DESC
      LIMIT ?
    `,
    args: [safeMin, since, cursor || 9999999, limit],
  });
  return result.rows;
}

/** Get overview stats for the analysis panel. */
export async function getAnalysisStats(hoursBack = 24) {
  const db = await getDb();
  const safeHours = Number.isFinite(hoursBack) && hoursBack > 0 ? hoursBack : 24;
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT
        COUNT(*) as total_signals,
        COALESCE(MAX(signal_score), 0) as max_score,
        COALESCE(SUM(CASE WHEN signal_score = 5 THEN 1 ELSE 0 END), 0) as critical_count,
        COALESCE(SUM(CASE WHEN signal_score = 4 THEN 1 ELSE 0 END), 0) as significant_count
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ?
    `,
    args: [since],
  });
  return result.rows[0] || {
    total_signals: 0,
    max_score: 0,
    critical_count: 0,
    significant_count: 0,
  };
}

/** Aggregate DB counts for the admin/stats endpoint. */
export async function getDbCounts() {
  const db = await getDb();
  const [totalNews, analyzedNews, bySource, byScore] = await Promise.all([
    db.execute({ sql: 'SELECT COUNT(*) as c FROM news_archive', args: [] }),
    db.execute({ sql: 'SELECT COUNT(*) as c FROM analysis_result', args: [] }),
    db.execute({ sql: 'SELECT source, COUNT(*) as c FROM news_archive GROUP BY source', args: [] }),
    db.execute({ sql: 'SELECT signal_score, COUNT(*) as c FROM analysis_result GROUP BY signal_score ORDER BY signal_score DESC', args: [] }),
  ]);
  return {
    total_news: totalNews.rows[0]?.c ?? 0,
    analyzed_news: analyzedNews.rows[0]?.c ?? 0,
    by_source: bySource.rows,
    by_score: byScore.rows,
  };
}

/** Get industry-level aggregated signal strength for the heatmap. */
export async function getIndustryHeatmap(hoursBack = 24) {
  const db = await getDb();
  const safeHours = Number.isFinite(hoursBack) && hoursBack > 0 ? hoursBack : 24;
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT a.industries, a.signal_score, a.sentiment
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ?
        AND a.signal_score >= 3
        AND a.industries IS NOT NULL
    `,
    args: [since],
  });

  const industryMap = new Map();
  for (const row of result.rows) {
    let industries = [];
    try { industries = JSON.parse(row.industries); } catch { continue; }
    for (const ind of industries) {
      if (!industryMap.has(ind)) {
        industryMap.set(ind, { count: 0, scoreSum: 0, positive: 0, negative: 0 });
      }
      const entry = industryMap.get(ind);
      entry.count++;
      entry.scoreSum += row.signal_score;
      if (row.sentiment === 'positive') entry.positive++;
      if (row.sentiment === 'negative') entry.negative++;
    }
  }

  return Array.from(industryMap.entries())
    .map(([name, data]) => ({
      industry: name,
      signalCount: data.count,
      avgScore: Math.round((data.scoreSum / data.count) * 10) / 10,
      sentiment: data.positive > data.negative ? 'positive' : data.negative > data.positive ? 'negative' : 'neutral',
    }))
    .sort((a, b) => b.signalCount - a.signalCount);
}

/** Get hourly trend data for top industries (signal_score >= 3). */
export async function getIndustryTrend(hoursBack = 24) {
  const db = await getDb();
  const safeHours = Number.isFinite(hoursBack) && hoursBack > 0 ? hoursBack : 24;
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT a.industries, a.signal_score, n.published_at
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ?
        AND a.signal_score >= 3
        AND a.industries IS NOT NULL
      ORDER BY n.published_at ASC
    `,
    args: [since],
  });

  // Choose bucket size and label format based on time range
  let bucketHours, labelFn;
  if (safeHours <= 48) {
    bucketHours = 2;
    labelFn = (dt) => dt.toISOString().slice(11, 16); // "10:00"
  } else if (safeHours <= 168) {
    bucketHours = 6;
    labelFn = (dt) => {
      const d = dt.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
      return `${d} ${dt.toISOString().slice(11, 16)}`; // "07/25 12:00"
    };
  } else if (safeHours <= 720) {
    bucketHours = 24;
    labelFn = (dt) => dt.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); // "07/25"
  } else {
    bucketHours = 72;
    labelFn = (dt) => dt.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }); // "07/25"
  }

  // Group by bucket and industry
  const buckets = new Map();
  for (const row of result.rows) {
    let industries = [];
    try { industries = JSON.parse(row.industries); } catch { continue; }
    const dt = new Date(row.published_at);
    dt.setMinutes(0, 0, 0);
    dt.setHours(Math.floor(dt.getHours() / bucketHours) * bucketHours);
    if (bucketHours >= 24) dt.setHours(0);
    const key = dt.toISOString();

    for (const ind of industries) {
      if (!buckets.has(key)) buckets.set(key, new Map());
      const indMap = buckets.get(key);
      indMap.set(ind, (indMap.get(ind) || 0) + 1);
    }
  }

  // Convert to { time, [industry]: count } format
  const data = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([iso, indMap]) => ({
      time: labelFn(new Date(iso)),
      ...Object.fromEntries(indMap),
    }));

  return data;
}

// --- Event Threads CRUD ---

/** Save detected event threads, replacing any existing ones. */
export async function saveEventThreads(threads) {
  if (!Array.isArray(threads)) return;
  const db = await getDb();
  // Clean threads older than 7 days, keep recent history.
  // julianday 比较兼容存量 SQLite 格式（'YYYY-MM-DD HH:MM:SS'）与新写 ISO 格式（P1.6 写侧统一）
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await db.execute({
    sql: 'DELETE FROM event_threads WHERE julianday(created_at) < julianday(?)',
    args: [cutoff],
  });

  const now = new Date().toISOString();
  for (const t of threads) {
    // 幂等键 = 规范化标题：同标题线程不重复创建，而是更新内容（stage 演进语义）
    await db.execute({
      sql: `INSERT INTO event_threads (title, news_ids, narrative, stage, confidence, industries, watch_points, dedup_key, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedup_key) DO UPDATE SET
              title = excluded.title,
              news_ids = excluded.news_ids,
              narrative = excluded.narrative,
              stage = excluded.stage,
              confidence = excluded.confidence,
              industries = excluded.industries,
              watch_points = excluded.watch_points`,
      args: [
        t.title || '未命名事件',
        JSON.stringify(t.news_ids || []),
        t.narrative || '',
        t.stage || 'early',
        t.confidence || 'medium',
        JSON.stringify(t.related_industries || []),
        JSON.stringify(t.key_watch_points || []),
        normalizeThreadTitle(t.title),
        now,
      ],
    });
  }
}

/**
 * 线程标题规范化：trim + 压缩内部空白 + 小写，作为幂等键。
 * SQL 迁移的回填用 lower(trim(title)) 近似，此处应用层更严格（内部空白也压缩）。
 */
export function normalizeThreadTitle(title: string | null | undefined): string {
  return String(title || '未命名事件').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Get recent event threads. limit 用于 ISR 预渲染裁剪（P1.5 构建期 DB 解耦）。 */
export async function getEventThreads(hoursBack = 24, limit = 500) {
  const db = await getDb();
  const safeHours = Number.isFinite(hoursBack) ? Math.min(hoursBack, 24 * 30) : 24;
  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 500;
  const since = isoToSqlite(new Date(Date.now() - safeHours * 60 * 60 * 1000));
  const result = await db.execute({
    sql: 'SELECT * FROM event_threads WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?',
    args: [since, safeLimit],
  });
  return result.rows.map(r => ({
    ...r,
    news_ids: tryParseJson(r.news_ids),
    industries: tryParseJson(r.industries),
    watch_points: tryParseJson(r.watch_points),
  }));
}

/** Get a single event thread by id, with its linked signals (news_ids → analysis rows). */
export async function getEventThreadById(id: number) {
  const db = await getDb();
  const threadResult = await db.execute({
    sql: 'SELECT * FROM event_threads WHERE id = ?',
    args: [id],
  });
  if (threadResult.rows.length === 0) return null;

  const thread = threadResult.rows[0] as Record<string, unknown>;
  const newsIds = tryParseJson(thread.news_ids as string);

  let signals = [];
  if (newsIds.length > 0) {
    const placeholders = newsIds.map(() => '?').join(', ');
    const sigResult = await db.execute({
      sql: `
        SELECT a.id, a.signal_score, a.category, a.summary, n.published_at,
               substr(n.content, 1, 200) as content, n.docurl, n.source
        FROM analysis_result a
        JOIN news_archive n ON n.id = a.news_id
        WHERE a.id IN (${placeholders})
        ORDER BY n.published_at ASC
      `,
      args: newsIds,
    });
    signals = sigResult.rows.map((r: Record<string, unknown>) => ({
      id: rowId(r.id),
      signal_score: r.signal_score,
      category: r.category,
      summary: r.summary,
      published_at: r.published_at,
      content: (r.content as string || ''), // SQL 已 substr 截断
      docurl: (r.docurl as string) || null, // P2.4 起因段原文链接
      source: (r.source as string) || null,
    }));
  }

  return {
    id: rowId(thread.id),
    title: thread.title,
    narrative: thread.narrative,
    stage: thread.stage,
    confidence: thread.confidence,
    industries: tryParseJson(thread.industries as string),
    watch_points: tryParseJson(thread.watch_points as string),
    created_at: thread.created_at,
    signals,
  };
}

// ── Agent Session CRUD（研究 Agent 持久化） ──

/** 会话是否存在（前端缓存了已删除会话时，发消息前校验防外键错误）。 */
export async function agentSessionExists(sessionId: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.execute({ sql: 'SELECT id FROM agent_session WHERE id = ?', args: [sessionId] });
  return r.rows.length > 0;
}

/** 创建研究会话，返回 session id。 */
export async function createAgentSession(title = '新会话') {
  const db = await getDb();
  const result = await db.execute({
    sql: 'INSERT INTO agent_session (title) VALUES (?)',
    args: [title],
  });
  return rowId(result.lastInsertRowid);
}

/** 列出研究会话（倒序）。 */
export async function listAgentSessions(limit = 20) {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT id, title, created_at, updated_at FROM agent_session ORDER BY updated_at DESC LIMIT ?',
    args: [limit],
  });
  return result.rows;
}

/** 删除会话及其全部消息（历史对话删除）；分享链接一并失效。 */
export async function deleteAgentSession(sessionId: number) {
  const db = await getDb();
  await db.execute({
    sql: 'DELETE FROM agent_message WHERE session_id = ?',
    args: [sessionId],
  });
  await db.execute({
    sql: 'DELETE FROM agent_share WHERE session_id = ?',
    args: [sessionId],
  });
  await db.execute({
    sql: 'DELETE FROM agent_session WHERE id = ?',
    args: [sessionId],
  });
}

/** 更新会话标题与更新时间。 */
export async function touchAgentSession(sessionId: number, title?: string) {
  const db = await getDb();
  await db.execute({
    sql: 'UPDATE agent_session SET updated_at = datetime(\'now\'), title = COALESCE(?, title) WHERE id = ?',
    args: [title ?? null, sessionId],
  });
}

/** 追加一条会话消息；返回新消息 id。meta 为 {toolCall?, toolResult?} 可 JSON 数据。 */
export async function appendAgentMessage(sessionId: number, role: string, content: string, meta?: unknown): Promise<number> {
  const db = await getDb();
  const r = await db.execute({
    sql: 'INSERT INTO agent_message (session_id, role, content, meta) VALUES (?, ?, ?, ?)',
    args: [sessionId, role, content, meta != null ? JSON.stringify(meta) : null],
  });
  return Number(r.lastInsertRowid);
}

/**
 * 上下文压缩的原子落库：在一个事务里追加摘要消息并删除被压缩的旧消息。
 * 避免"摘要已落库但旧消息未删"（下次加载仍超预算、重复付费压缩）或
 * "旧消息已删但摘要未落库"（历史永久丢失）的中间态。
 * 仅删除该会话 id <= upToMessageId 的旧消息；摘要与保留的最近消息 id 更大，不受影响。
 */
export async function compactAgentMessages(
  sessionId: number,
  upToMessageId: number,
  summaryContent: string,
): Promise<number> {
  const db = await getDb();
  const tx = await db.transaction('write');
  try {
    const ins = await tx.execute({
      sql: 'INSERT INTO agent_message (session_id, role, content) VALUES (?, ?, ?)',
      args: [sessionId, 'user', summaryContent],
    });
    const summaryId = Number(ins.lastInsertRowid);
    await tx.execute({
      sql: 'DELETE FROM agent_message WHERE session_id = ? AND id <= ?',
      args: [sessionId, upToMessageId],
    });
    await tx.commit();
    return summaryId;
  } catch (err) {
    try { await tx.rollback(); } catch { /* 已失效的事务 */ }
    throw err;
  }
}

/**
 * 编辑会话消息（编辑重发语义）：替换内容并删除其后全部消息。
 * 消息不存在或不属于该会话时返回 false。
 */
export async function editAgentMessage(sessionId: number, messageId: number, newContent: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.execute({
    sql: 'SELECT id FROM agent_message WHERE id = ? AND session_id = ?',
    args: [messageId, sessionId],
  });
  if (row.rows.length === 0) return false;
  await db.execute({
    sql: 'UPDATE agent_message SET content = ? WHERE id = ?',
    args: [newContent, messageId],
  });
  await db.execute({
    sql: 'DELETE FROM agent_message WHERE session_id = ? AND id > ?',
    args: [sessionId, messageId],
  });
  return true;
}

/** 读取会话全部消息（正序）。 */
export async function getAgentMessages(sessionId: number) {
  const db = await getDb();
  const result = await db.execute({
    sql: 'SELECT id, role, content, meta, created_at FROM agent_message WHERE session_id = ? ORDER BY id ASC',
    args: [sessionId],
  });
  return result.rows.map((r: Record<string, unknown>) => ({
    id: rowId(r.id),
    role: r.role,
    content: r.content,
    meta: parseJsonOrNull(r.meta as string),
    created_at: r.created_at,
  }));
}

/**
 * 创建会话分享（幂等：同一会话复用已有 token）。
 * token 为公开链接凭据（128 位随机串），任何持有者可只读访问该会话。
 * B5 同款加固:固定 randomBytes 熵源,无 Date.now+Math.random 弱熵 fallback。
 */
export async function createAgentShare(sessionId: number): Promise<string> {
  const db = await getDb();
  const existing = await db.execute({
    sql: 'SELECT token FROM agent_share WHERE session_id = ? ORDER BY id DESC LIMIT 1',
    args: [sessionId],
  });
  if (existing.rows[0]?.token) return String(existing.rows[0].token);
  const token = crypto.randomBytes(16).toString('hex');
  await db.execute({
    sql: 'INSERT INTO agent_share (token, session_id) VALUES (?, ?)',
    args: [token, sessionId],
  });
  return token;
}

/** 读取分享会话（只读：标题 + 全部消息）；链接无效或会话不存在返回 null。 */
export async function getSharedSession(token: string) {
  const db = await getDb();
  const share = await db.execute({
    sql: 'SELECT s.id, s.title FROM agent_share a JOIN agent_session s ON s.id = a.session_id WHERE a.token = ?',
    args: [token],
  });
  const row = share.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const messages = await getAgentMessages(rowId(row.id));
  return { title: row.title || '未命名会话', messages };
}

/**
 * Date → SQLite datetime 格式（'YYYY-MM-DD HH:MM:SS'）。
 * 与 datetime('now') 默认值对齐，避免 'T' 与 ' ' 格式混用导致
 * 字符串比较错位（'2026-08-19 02:00' < '2026-08-19T02:00Z' 恒成立，C9）。
 */
function isoToSqlite(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** 解析可空 JSON 字段（对象或 null）。 */
function parseJsonOrNull(str: string | null) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

function tryParseJson(str) {
  if (!str || typeof str !== 'string') return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// ── F2: Signal Detail ──

/**
 * Get a single signal's full detail, joining news_archive and event_threads.
 * Returns null if the signal ID does not exist.
 */
export async function getSignalById(id: number) {
  const db = await getDb();
  const result = await db.execute({
    sql: `
      SELECT a.*, n.source, n.content as news_content, n.published_at,
             et.title as thread_title, et.stage as thread_stage, et.confidence as thread_confidence,
             et.id as thread_id
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      LEFT JOIN event_threads et ON et.id = (
        SELECT e2.id FROM event_threads e2
        WHERE EXISTS (
          SELECT 1 FROM json_each(e2.news_ids) AS j WHERE j.value = a.id
        )
        ORDER BY e2.created_at DESC
        LIMIT 1
      )
      WHERE a.id = ?
    `,
    args: [id],
  });
  if (result.rows.length === 0) return null;

  const row: Record<string, unknown> = result.rows[0] as Record<string, unknown>;
  return {
    id: rowId(row.id),
    news_id: rowId(row.news_id),
    signal_score: row.signal_score,
    category: row.category,
    impact_level: row.impact_level,
    sentiment: row.sentiment,
    summary: row.summary,
    deep_analysis: row.deep_analysis || null,
    industries: tryParseJson(row.industries as string),
    companies: tryParseJson(row.companies as string),
    tags: tryParseJson(row.tags as string),
    analyzed_at: row.analyzed_at,
    // from news_archive
    source: row.source,
    content: row.news_content,
    published_at: row.published_at,
    // from event_threads (conditionally present)
    event_thread: (row.thread_id != null)
      ? {
          id: rowId(row.thread_id),
          title: row.thread_title,
          stage: row.thread_stage,
          confidence: row.thread_confidence,
        }
      : null,
  };
}

/**
 * Get signals related to the given signal — same industries or companies,
 * excluding the signal itself. Returns the most recent matches.
 */
export async function getRelatedSignals(
  id: number,
  industries: string[],
  companies: string[],
  limit = 5,
) {
  const db = await getDb();

  // Build LIKE clauses from industries and companies
  const conditions: string[] = [];
  const args: (string | number)[] = [];

  for (const ind of industries) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(a.industries) WHERE json_each.value = ?)');
    args.push(ind);
  }
  for (const comp of companies) {
    conditions.push('EXISTS (SELECT 1 FROM json_each(a.companies) WHERE json_each.value = ?)');
    args.push(comp);
  }

  if (conditions.length === 0) return [];

  args.push(id, limit);

  const result = await db.execute({
    sql: `
      SELECT a.id, a.signal_score, a.category, a.industries, a.summary, n.published_at
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE (${conditions.join(" OR ")})
        AND a.id != ?
        AND a.signal_score >= 3
      ORDER BY n.published_at DESC
      LIMIT ?
    `,
    args,
  });

  return result.rows.map((row: Record<string, unknown>) => ({
    id: rowId(row.id),
    signal_score: row.signal_score,
    category: row.category,
    industries: tryParseJson(row.industries as string),
    summary: row.summary,
    published_at: row.published_at,
  }));
}

// ── F3: Search ──

/**
 * Search signals by keyword across content, summary, deep_analysis, industries, companies.
 * Supports optional score and time-range filtering with cursor-based pagination.
 */
export async function searchSignals({
  query,
  minScore = 1,
  hoursBack = 720,
  cursor,
  limit = 20,
}: {
  query: string;
  minScore?: number;
  hoursBack?: number;
  cursor?: number | null;
  limit?: number;
}) {
  const db = await getDb();
  const safeQuery = String(query).trim();
  if (safeQuery.length < 2) return { items: [], nextCursor: null, total: 0 };

  const safeHours = Number.isFinite(hoursBack) ? Math.min(hoursBack, 2160) : 720;
  const safeMin = Number.isFinite(minScore) ? Math.min(5, Math.max(1, minScore)) : 1;
  const safeLimit = Math.min(limit || 20, 50);
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const offset = cursor || 0;

  // Escape LIKE special characters for literal matching
  const escaped = safeQuery
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
  const likePattern = `%${escaped}%`;

  const countResult = await db.execute({
    sql: `
      SELECT COUNT(*) as total
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ?
        AND a.signal_score >= ?
        AND (
          n.content LIKE ? ESCAPE '\\'
          OR a.summary LIKE ? ESCAPE '\\'
          OR a.deep_analysis LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM json_each(a.industries) WHERE json_each.value LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM json_each(a.companies) WHERE json_each.value LIKE ? ESCAPE '\\')
        )
    `,
    args: [since, safeMin, likePattern, likePattern, likePattern, likePattern, likePattern],
  });

  const total = (countResult.rows[0] as Record<string, unknown>)?.total as number || 0;

  const result = await db.execute({
    sql: `
      SELECT a.id, a.signal_score, a.category, a.impact_level, a.industries, a.companies,
             a.sentiment, a.summary, n.content as news_content, n.source, n.published_at
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ?
        AND a.signal_score >= ?
        AND (
          n.content LIKE ? ESCAPE '\\'
          OR a.summary LIKE ? ESCAPE '\\'
          OR a.deep_analysis LIKE ? ESCAPE '\\'
          OR EXISTS (SELECT 1 FROM json_each(a.industries) WHERE json_each.value LIKE ? ESCAPE '\\')
          OR EXISTS (SELECT 1 FROM json_each(a.companies) WHERE json_each.value LIKE ? ESCAPE '\\')
        )
      ORDER BY a.signal_score DESC, n.published_at DESC
      LIMIT ? OFFSET ?
    `,
    args: [since, safeMin, likePattern, likePattern, likePattern, likePattern, likePattern, safeLimit + 1, offset],
  });

  const rows = result.rows.slice(0, safeLimit);
  const hasMore = result.rows.length > safeLimit;

  const items = rows.map((row: Record<string, unknown>) => ({
    id: rowId(row.id),
    signal_score: row.signal_score,
    category: row.category,
    impact_level: row.impact_level,
    industries: tryParseJson(row.industries as string),
    companies: tryParseJson(row.companies as string),
    sentiment: row.sentiment,
    summary: row.summary,
    source: row.source,
    published_at: row.published_at,
  }));

  return {
    items,
    nextCursor: hasMore ? offset + safeLimit : null,
    total,
  };
}

// ── F4: Stats with Trend Comparison ──

/**
 * Get analysis stats for two time windows, enabling period-over-period comparison.
 * `currentHoursBack` is the main window; `previousHoursBack` is the comparison window
 * ending where the current window begins.
 */
export async function getAnalysisStatsWithComparison(
  currentHoursBack = 24,
  previousHoursBack = 24,
) {
  const db = await getDb();
  const safeCur = Number.isFinite(currentHoursBack) ? Math.min(currentHoursBack, 720) : 24;
  const safePrev = Number.isFinite(previousHoursBack) ? Math.min(previousHoursBack, 720) : 24;
  const now = Date.now();
  const currentSince = new Date(now - safeCur * 60 * 60 * 1000).toISOString();
  const previousSince = new Date(now - (safeCur + safePrev) * 60 * 60 * 1000).toISOString();
  const previousUntil = currentSince;

  const queryStats = (since: string, until?: string) => {
    const conditions = until
      ? `n.published_at >= ? AND n.published_at < ?`
      : `n.published_at >= ?`;
    const args: string[] = until ? [since, until] : [since];
    return db.execute({
      sql: `
        SELECT
          COUNT(*) as total_signals,
          COALESCE(MAX(a.signal_score), 0) as max_score,
          COALESCE(SUM(CASE WHEN a.signal_score = 5 THEN 1 ELSE 0 END), 0) as critical_count,
          COALESCE(SUM(CASE WHEN a.signal_score = 4 THEN 1 ELSE 0 END), 0) as significant_count
        FROM analysis_result a
        JOIN news_archive n ON n.id = a.news_id
        WHERE ${conditions}
      `,
      args,
    });
  };

  const [currentResult, previousResult] = await Promise.all([
    queryStats(currentSince),
    queryStats(previousSince, previousUntil),
  ]);

  const defaultStats = { total_signals: 0, max_score: 0, critical_count: 0, significant_count: 0 };

  return {
    current: (currentResult.rows[0] as Record<string, unknown>) || defaultStats,
    previous: (previousResult.rows[0] as Record<string, unknown>) || defaultStats,
  };
}

// ── F6: Company Dimension ──

/**
 * Get company-level signal aggregation for the heatmap (top 10 companies by mention count).
 * Only includes signals with score >= 3.
 */
export async function getCompanyHeatmap(hoursBack = 24) {
  const db = await getDb();
  const safeHours = Number.isFinite(hoursBack) && hoursBack > 0 ? hoursBack : 24;
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT a.companies, a.signal_score
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ?
        AND a.signal_score >= 3
        AND a.companies IS NOT NULL
    `,
    args: [since],
  });

  const companyMap = new Map<string, { count: number; scoreSum: number }>();
  for (const row of result.rows) {
    const companies = tryParseJson(row.companies as string);
    for (const comp of companies) {
      if (!companyMap.has(comp)) {
        companyMap.set(comp, { count: 0, scoreSum: 0 });
      }
      const entry = companyMap.get(comp)!;
      entry.count++;
      entry.scoreSum += (row.signal_score as number);
    }
  }

  return Array.from(companyMap.entries())
    .map(([name, data]) => ({
      company: name,
      signalCount: data.count,
      avgScore: Math.round((data.scoreSum / data.count) * 10) / 10,
    }))
    .sort((a, b) => b.signalCount - a.signalCount)
    .slice(0, 10);
}

// ── F7: Backtest by Industry ──

/**
 * Get backtest summary grouped by industry (instead of signal_score).
 * 下限过滤统一 ≥3(与 market.getBacktestSummary 一致);展示分层(10/30)由 UI 层全权管控,
 * 低样本行业在 UI 显示「数据积累中」占位而非被 SQL 静默吃掉。
 */
export async function getBacktestByIndustry(daysBack = 30) {
  const db = await getDb();
  const safeDays = Number.isFinite(daysBack) ? Math.max(1, daysBack) : 30;
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const result = await db.execute({
    sql: `
      SELECT industry,
             COUNT(*) as samples,
             COALESCE(ROUND(AVG(day_1_return), 2), 0) as avg_d1,
             COALESCE(ROUND(AVG(day_3_return), 2), 0) as avg_d3,
             COALESCE(ROUND(AVG(day_7_return), 2), 0) as avg_d7,
             SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END) as directional_count,
             -- 方向命中率:看多事件次日涨/看空事件次日跌为胜;
             -- 分母 = 仅带方向(long/short)事件;中性/混合/遗留 NULL 不计(口径见 UI tooltip)
             ROUND(SUM(CASE WHEN (direction = 'long' AND day_1_return > 0) OR (direction = 'short' AND day_1_return < 0) THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN direction IN ('long', 'short') THEN 1 ELSE 0 END), 0), 1) as win_rate
      FROM backtest_result
      WHERE day_1_return IS NOT NULL
        AND industry IS NOT NULL
        AND signal_date >= ?
      GROUP BY industry
      HAVING COUNT(*) >= 3
      ORDER BY samples DESC
    `,
    args: [since],
  });

  return result.rows.map((row: Record<string, unknown>) => ({
    industry: row.industry,
    samples: row.samples,
    avg_d1: row.avg_d1,
    avg_d3: row.avg_d3,
    avg_d7: row.avg_d7,
    win_rate: row.win_rate,
  }));
}

/**
 * Get high-score signals for ISR pre-rendering (F2: getStaticPaths).
 * Returns signal IDs with score >= minScore from the past daysBack days.
 */
export async function getHighScoreSignals({
  daysBack = 7,
  minScore = 4,
  limit = 200,
}: {
  daysBack?: number;
  minScore?: number;
  limit?: number;
} = {}) {
  const db = await getDb();
  const safeDays = Number.isFinite(daysBack) ? Math.min(daysBack, 90) : 7;
  const safeMin = Number.isFinite(minScore) ? Math.min(5, Math.max(1, minScore)) : 4;
  const safeLimit = Number.isFinite(limit) ? Math.min(limit, 500) : 200;
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `
      SELECT a.id
      FROM analysis_result a
      JOIN news_archive n ON n.id = a.news_id
      WHERE n.published_at >= ?
        AND a.signal_score >= ?
      ORDER BY a.signal_score DESC, n.published_at DESC
      LIMIT ?
    `,
    args: [since, safeMin, safeLimit],
  });
  return result.rows.map((r: Record<string, unknown>) => ({ id: rowId(r.id) }));
}

// ── Event Log (append-only, spec §10.2 原则2"模型可见即记录") ──

/** 领域事件类型。 */
export const EVENT_TYPES = {
  NEWS_INGESTED: 'news.ingested',
  SIGNAL_SCORED: 'signal.scored',
  ENTITY_MAPPED: 'entity.mapped',
  THREAD_LINKED: 'thread.linked',
  AGENT_QUERY: 'agent.query',
} as const;

/**
 * 追加一条领域事件（只增不改，历史不可变）。
 * payload 为可 JSON 序列化的附加数据。
 */
export async function logEvent(
  eventType: string,
  opts: { entityId?: number | null; payload?: unknown } = {},
) {
  try {
    const db = await getDb();
    await db.execute({
      sql: 'INSERT INTO event_log (event_type, entity_id, payload) VALUES (?, ?, ?)',
      args: [
        eventType,
        opts.entityId ?? null,
        opts.payload != null ? JSON.stringify(opts.payload) : null,
      ],
    });
  } catch (err) {
    // 事件日志不允许阻断主流程
    console.error(`[event-log] Failed to log ${eventType}:`, err.message);
  }
}

/**
 * 查询事件日志（按时间倒序）。
 * @param eventType 可选，按类型过滤
 * @param limit 条数上限
 */
export async function getEventLog(eventType?: string, limit = 100) {
  const db = await getDb();
  const safeLimit = Number.isFinite(limit) ? Math.min(limit, 1000) : 100;
  const result = eventType
    ? await db.execute({
        sql: 'SELECT * FROM event_log WHERE event_type = ? ORDER BY id DESC LIMIT ?',
        args: [eventType, safeLimit],
      })
    : await db.execute({
        sql: 'SELECT * FROM event_log ORDER BY id DESC LIMIT ?',
        args: [safeLimit],
      });
  return result.rows.map((r: Record<string, unknown>) => ({
    id: rowId(r.id),
    event_type: r.event_type,
    entity_id: rowId(r.entity_id),
    payload: parseJsonOrNull(r.payload as string), // 对象 payload 不被丢成 []
    created_at: r.created_at,
  }));
}

/**
 * 事件日志保留策略:清理超过 retentionDays 的埋点行。
 * append-only 表若无保留策略会无限膨胀;调用方(写路径 /api/events)
 * 每小时至多触发一次,不阻塞主流程。
 */
export async function pruneEventLog(retentionDays = 90) {
  const safeDays = Number.isFinite(retentionDays) ? Math.max(retentionDays, 30) : 90;
  try {
    const db = await getDb();
    await db.execute({
      sql: 'DELETE FROM event_log WHERE julianday(created_at) < julianday(\'now\', ?)',
      args: [`-${safeDays} days`],
    });
  } catch (err) {
    // 清理失败不允许影响埋点写入
    console.error('[event-log] prune failed:', err.message);
  }
}

/**
 * P2.1 埋点按日聚合：每天每类事件计数 + 独立 session 数。
 * 供 /api/cron/stats 与 P2.5 验证报告使用（json_extract 依赖 SQLite JSON1，libsql 内置）。
 */
export async function getEventAnalytics(days = 7) {
  const db = await getDb();
  const safeDays = Number.isFinite(days) ? Math.min(Math.max(days, 1), 90) : 7;
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.execute({
    sql: `SELECT date(created_at) as day, event_type,
                 COUNT(*) as count,
                 COUNT(DISTINCT json_extract(payload, '$.session')) as sessions
          FROM event_log
          WHERE created_at >= ?
          GROUP BY day, event_type
          ORDER BY day DESC, event_type`,
    args: [since],
  });
  return result.rows.map((r: Record<string, unknown>) => ({
    day: r.day,
    event_type: r.event_type,
    count: Number(r.count || 0),
    sessions: Number(r.sessions || 0),
  }));
}

/**
 * P2.5 价值指标聚合：事件类型汇总 + 独立访问 + 周回访。
 * - uniqueSessions：观察窗口内去重 session 数（30 天 TTL，近似独立用户）
 * - events：每类事件 count + 去重 session 数
 * - weeklyReturn：recentSessions（最近 7 天去重 session）中有多少也在
 *   前一个 7 天窗口出现过（跨周回访，即周回访率的分子/分母）
 */
export async function getEventMetrics(days = 7) {
  const db = await getDb();
  const safeDays = Number.isFinite(days) ? Math.min(Math.max(days, 1), 90) : 7;
  const now = Date.now();
  const since = new Date(now - safeDays * 24 * 60 * 60 * 1000).toISOString();

  const [typeRows, sessionRows, weeklyRows] = await Promise.all([
    db.execute({
      sql: `SELECT event_type, COUNT(*) as count,
                   COUNT(DISTINCT json_extract(payload, '$.session')) as sessions
            FROM event_log
            WHERE created_at >= ?
            GROUP BY event_type`,
      args: [since],
    }),
    db.execute({
      sql: `SELECT COUNT(DISTINCT json_extract(payload, '$.session')) as total
            FROM event_log
            WHERE created_at >= ?`,
      args: [since],
    }),
    // 周回访：最近 7 天去重 session ∩ 前 7 天窗口去重 session
    db.execute({
      sql: `SELECT COUNT(*) as recent_sessions,
                   SUM(CASE WHEN older.session IS NOT NULL THEN 1 ELSE 0 END) as returning_sessions
            FROM (
              SELECT DISTINCT json_extract(payload, '$.session') as session
              FROM event_log
              WHERE created_at >= ? AND created_at < ?
            ) recent
            LEFT JOIN (
              SELECT DISTINCT json_extract(payload, '$.session') as session
              FROM event_log
              WHERE created_at >= ? AND created_at < ?
            ) older ON recent.session = older.session`,
      args: [
        new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(now).toISOString(),
        new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString(),
        new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      ],
    }),
  ]);

  const weeklyRow = weeklyRows.rows[0] as Record<string, unknown> | undefined;
  return {
    uniqueSessions: Number(sessionRows.rows[0]?.total || 0),
    events: typeRows.rows.map((r: Record<string, unknown>) => ({
      event_type: r.event_type as string,
      count: Number(r.count || 0),
      sessions: Number(r.sessions || 0),
    })),
    weeklyReturn: {
      recentSessions: Number(weeklyRow?.recent_sessions || 0),
      returning: Number(weeklyRow?.returning_sessions || 0),
    },
  };
}
