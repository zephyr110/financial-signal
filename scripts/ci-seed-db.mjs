#!/usr/bin/env node
/**
 * 构建期 seed 库:本地/CI 无数据文件时生成含关键表的空库,
 * 使 prebuild 的 verify-data.mjs 通过(桌面端构建不依赖远端 Turso)。
 * 用法:NEWS_DB_PATH=./seed/news_archive.db node scripts/ci-seed-db.mjs
 * 7 张表(news_archive / analysis_result / event_threads / market_data /
 * backtest_result / pipeline_run / pipeline_cursor)的列定义与 lib/db.ts
 * initSchema 逐列一致(含 CHECK 约束):运行时 CREATE TABLE IF NOT EXISTS
 * 不会修复已存在的错误表结构,seed 建错会让管线在空库上直接抛 no such column。
 * 本脚本未建的表(event_log / agent_session / agent_message / agent_share /
 * app_account / app_session / app_settings)由运行时 initSchema 补齐。
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
    category TEXT NOT NULL, impact_level TEXT NOT NULL CHECK(impact_level IN ('critical','significant','moderate','minor','noise')),
    industries TEXT, companies TEXT, sentiment TEXT NOT NULL CHECK(sentiment IN ('positive','negative','neutral','mixed')),
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
    code TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('industry','index')),
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
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name        TEXT    NOT NULL,  -- fetch | analyze | deep-analyze | event-threads | fetch-market
    batch_id        TEXT    NOT NULL,  -- 调用方批次标识(QStash 消息 ID 或小时时间窗)
    retry_count     INTEGER NOT NULL DEFAULT 0,
    status          TEXT    NOT NULL,  -- running | success | failed
    items_processed INTEGER,
    error           TEXT,
    started_at      TEXT    NOT NULL,  -- ISO 格式(与 news_archive.published_at 一致),同 lib/db.ts 无默认值
    finished_at     TEXT
  );
  CREATE TABLE IF NOT EXISTS pipeline_cursor (
    job_name     TEXT PRIMARY KEY,  -- analyze | deep-analyze
    last_news_id INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL
  );
`);
console.log(`[ci-seed-db] ✓ 空库已建: ${filePath}`);
client.close();
