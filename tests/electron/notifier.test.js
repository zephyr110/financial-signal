import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@libsql/client'
import { notifyNewHighSignals } from '../../electron/notifier'

// 桩替代 Electron 主进程 Notification(默认参数注入)
const fakeNotification = { shown: [], supported: true }
class FakeNotification {
  constructor(opts) { this.opts = opts }
  on(event, cb) { if (event === 'click') this.clickCb = cb }
  show() { fakeNotification.shown.push(this) }
  static isSupported() { return fakeNotification.supported }
}

let dir, db, dbPath, configFile

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notifier-test-'))
  dbPath = path.join(dir, 'test.db')
  configFile = path.join(dir, 'config.json')
  fakeNotification.shown = []
  fakeNotification.supported = true
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

function notify(opts = {}) {
  return notifyNewHighSignals({ dbPath, configFile, NotificationImpl: FakeNotification, ...opts })
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configFile, 'utf8'))
}

describe('notifyNewHighSignals', () => {
  it('shows a notification per new high signal and advances the cursor to the newest', async () => {
    await insertNews('old', 5, '2026-08-23 09:00:00')
    await insertNews('new', 5, '2026-08-23 11:00:00')
    const count = await notify()
    expect(count).toBe(2)
    expect(fakeNotification.shown).toHaveLength(2)
    expect(fakeNotification.shown[0].opts.title).toMatch(/信号 5 分/)
    expect(readConfig().notifyLastRunAt).toBe('2026-08-23 11:00:00')
  })

  it('does not re-notify signals already covered by the cursor', async () => {
    await insertNews('first-batch', 5, '2026-08-23 10:00:00')
    await notify()
    expect(fakeNotification.shown).toHaveLength(1)

    fakeNotification.shown = []
    const again = await notify()
    expect(again).toBe(0)
    expect(fakeNotification.shown).toHaveLength(0)
    expect(readConfig().notifyLastRunAt).toBe('2026-08-23 10:00:00')
  })

  it('only notifies signals analyzed after the persisted cursor', async () => {
    await insertNews('first-batch', 5, '2026-08-23 10:00:00')
    await notify()

    fakeNotification.shown = []
    await insertNews('second-batch', 5, '2026-08-23 12:00:00')
    const count = await notify()
    expect(count).toBe(1)
    expect(fakeNotification.shown).toHaveLength(1)
    expect(fakeNotification.shown[0].opts.body).toBe('second-batch')
    expect(readConfig().notifyLastRunAt).toBe('2026-08-23 12:00:00')
  })

  it('caps notifications at 5 per run', async () => {
    for (let i = 0; i < 7; i++) await insertNews(`batch-${i}`, 5, `2026-08-23 10:0${i}:00`)
    const count = await notify()
    expect(count).toBe(7) // 返回全部条数,展示只推前 5
    expect(fakeNotification.shown).toHaveLength(5)
  })

  it('clicking a notification calls onActivate', async () => {
    await insertNews('clickable', 5, '2026-08-23 10:00:00')
    const onActivate = vi.fn()
    await notify({ onActivate })
    expect(fakeNotification.shown).toHaveLength(1)
    fakeNotification.shown[0].clickCb()
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  it('still advances the cursor when notifications are unsupported', async () => {
    fakeNotification.supported = false
    await insertNews('silent', 5, '2026-08-23 10:00:00')
    const count = await notify()
    expect(count).toBe(1)
    expect(fakeNotification.shown).toHaveLength(0)
    expect(readConfig().notifyLastRunAt).toBe('2026-08-23 10:00:00')
  })
})
