#!/usr/bin/env node
/**
 * 构建期 seed 库:本地/CI 无数据文件时生成含关键表的空库,
 * 使 prebuild 的 verify-data.mjs 通过(桌面端构建不依赖远端 Turso)。
 * 用法:NEWS_DB_PATH=./seed/news_archive.db node scripts/ci-seed-db.mjs
 * 注意:仅建 verify-data 要求的关键表;运行时 lib/db.ts initSchema 会建全量表。
 */
import { createClient } from '@libsql/client';
import fs from 'fs';
import path from 'path';

const filePath = process.env.NEWS_DB_PATH || 'seed/news_archive.db';
fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });

const client = createClient({ url: `file:${path.resolve(filePath)}` });
await client.executeMultiple(`
  CREATE TABLE IF NOT EXISTS news_archive (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT, content TEXT NOT NULL,
    published_at TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    docurl TEXT, UNIQUE(source, source_id)
  );
  CREATE TABLE IF NOT EXISTS analysis_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    news_id INTEGER NOT NULL UNIQUE REFERENCES news_archive(id),
    signal_score INTEGER NOT NULL CHECK(signal_score BETWEEN 1 AND 5),
    category TEXT NOT NULL, impact_level TEXT NOT NULL,
    industries TEXT, companies TEXT, sentiment TEXT NOT NULL,
    summary TEXT NOT NULL, deep_analysis TEXT, tags TEXT, related_ids TEXT,
    event_thread_id TEXT, analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS event_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, news_ids TEXT NOT NULL, narrative TEXT NOT NULL,
    stage TEXT NOT NULL, confidence TEXT NOT NULL, industries TEXT, watch_points TEXT,
    dedup_key TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS market_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL,
    trade_date TEXT NOT NULL, close REAL, change_pct REAL, volume REAL,
    UNIQUE(code, trade_date)
  );
  CREATE TABLE IF NOT EXISTS backtest_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_date TEXT NOT NULL, industry TEXT NOT NULL, signal_score INTEGER NOT NULL,
    signal_count INTEGER NOT NULL, day_1_return REAL, day_3_return REAL, day_7_return REAL,
    calculated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(signal_date, industry)
  );
  CREATE TABLE IF NOT EXISTS pipeline_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL, batch_id TEXT NOT NULL, retry_count INTEGER DEFAULT 0,
    status TEXT NOT NULL, started_at TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT, detail TEXT
  );
  CREATE TABLE IF NOT EXISTS pipeline_cursor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
console.log(`[ci-seed-db] ✓ 空库已建: ${filePath}`);
client.close();
