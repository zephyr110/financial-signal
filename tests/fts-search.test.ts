import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * P13：FTS5 文档/会话检索、触发器同步与短查询回退。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fts-search-test-'))
let dbModule: typeof import('../lib/db')
let search: typeof import('../lib/search/fts')

const now = new Date().toISOString()

describe('fts5 search', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    process.env.NEWS_DB_PATH = path.join(dir, 'fts.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    search = await import('../lib/search/fts')
    await dbModule.getDb()
  })

  it('文档全文索引随插入、更新、删除同步', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO source_documents
              (id, source_id, doc_type, title, published_at, full_text, metadata_json, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['doc-a', 'exchange', 'announcement', '半导体设备招标加速', now, '国产替代订单增长', '{"industry":"半导体"}', now],
    })
    await db.execute({
      sql: `INSERT INTO source_documents
              (id, source_id, doc_type, title, published_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['doc-b', 'exchange', 'news', '白酒消费回暖', now, now],
    })

    const found = await search.searchSourceDocuments(db, '半导体设备', { days: 14, limit: 8 })
    expect(found.map((row) => row.id)).toContain('doc-a')

    await db.execute({ sql: "UPDATE source_documents SET title = '白酒扩产计划' WHERE id = 'doc-a'", args: [] })
    const stale = await search.searchSourceDocuments(db, '半导体设备', { days: 14, limit: 8 })
    expect(stale.map((row) => row.id)).not.toContain('doc-a')

    await db.execute({ sql: "DELETE FROM source_documents WHERE id = 'doc-b'", args: [] })
    const deleted = await search.searchSourceDocuments(db, '白酒消费', { days: 14, limit: 8 })
    expect(deleted).toHaveLength(0)
  })

  it('不足 3 个字符的中文查询回退 LIKE', async () => {
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO source_documents
              (id, source_id, doc_type, title, published_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ['doc-c', 'exchange', 'news', '稀土价格反弹', now, now],
    })
    expect(search.ftsMatchQuery('稀土')).toBeNull()
    expect(search.ftsMatchQuery('稀土价格')).not.toBeNull()
    const found = await search.searchSourceDocuments(db, '稀土', { days: 14, limit: 8 })
    expect(found.map((row) => row.id)).toContain('doc-c')
  })

  it('会话消息可全文检索，短查询仍能命中正文', async () => {
    const db = await dbModule.getDb()
    const first = await dbModule.createAgentSession('存储研究')
    await dbModule.appendAgentMessage(first, 'user', '存储周期见底反弹，等待价格确认')
    const second = await dbModule.createAgentSession('短查询')
    await dbModule.appendAgentMessage(second, 'user', '稀土永磁报价上调')

    const long = await dbModule.listAgentSessionsPage({ query: '存储周期' })
    expect(long.sessions.map((row: Record<string, unknown>) => Number(row.id))).toContain(first)

    const short = await dbModule.listAgentSessionsPage({ query: '稀土' })
    expect(short.sessions.map((row: Record<string, unknown>) => Number(row.id))).toContain(second)
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
