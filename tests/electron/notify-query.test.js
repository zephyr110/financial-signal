import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@libsql/client'
import { queryNewHighSignals } from '../../electron/notify-query'

let dir, db, dbPath

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'))
  dbPath = path.join(dir, 'test.db')
  db = createClient({ url: `file:${dbPath}` })
  await db.executeMultiple(`
    CREATE TABLE news_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT, content TEXT NOT NULL,
      published_at TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE analysis_result (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id INTEGER NOT NULL UNIQUE REFERENCES news_archive(id),
      signal_score INTEGER NOT NULL,
      category TEXT NOT NULL, impact_level TEXT NOT NULL,
      industries TEXT, companies TEXT, sentiment TEXT NOT NULL,
      summary TEXT NOT NULL, analyzed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)
})

afterEach(async () => {
  await db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

async function insertNews(title, score, analyzedAt) {
  const n = await db.execute({
    sql: 'INSERT INTO news_archive (source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?)',
    args: ['sina', `s${Math.random()}`, title, 'content', '2026-08-23T09:00:00Z'],
  })
  const newsId = Number(n.lastInsertRowid)
  await db.execute({
    sql: `INSERT INTO analysis_result (news_id, signal_score, category, impact_level, sentiment, summary, analyzed_at)
          VALUES (?, ?, 'policy', 'significant', 'positive', ?, ?)`,
    args: [newsId, score, `summary-${title}`, analyzedAt],
  })
  return newsId
}

describe('queryNewHighSignals', () => {
  it('returns scored news with signal >= 4 after since', async () => {
    await insertNews('high-a', 5, '2026-08-23T10:00:00Z')
    await insertNews('low-b', 2, '2026-08-23T10:00:00Z')
    const rows = await queryNewHighSignals(db, '2026-08-23T09:00:00Z')
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('high-a')
    expect(rows[0].signalScore).toBe(5)
  })

  it('excludes rows analyzed at or before since', async () => {
    await insertNews('old-a', 5, '2026-08-23T08:00:00Z')
    const rows = await queryNewHighSignals(db, '2026-08-23T09:00:00Z')
    expect(rows).toHaveLength(0)
  })

  it('caps at limit', async () => {
    for (let i = 0; i < 5; i++) await insertNews(`batch-${i}`, 5, `2026-08-23T10:0${i}:00Z`)
    const rows = await queryNewHighSignals(db, '2026-08-23T09:00:00Z', 3)
    expect(rows).toHaveLength(3)
  })
})
