import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@libsql/client'
import { validateDbFile, importDbFile } from '../../electron/import-db'

let dir, goodPath, badPath

/** 造一个结构齐全的合法源库。 */
async function createGoodDb(p) {
  const db = createClient({ url: `file:${p}` })
  await db.executeMultiple(`
    CREATE TABLE news_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL, source_id TEXT NOT NULL,
      title TEXT, content TEXT NOT NULL, published_at TEXT NOT NULL
    );
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  await db.close()
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'))
  goodPath = path.join(dir, 'good.db')
  await createGoodDb(goodPath)
  badPath = path.join(dir, 'bad.db')
  fs.writeFileSync(badPath, 'this is not a sqlite database at all')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('validateDbFile', () => {
  it('accepts a db with required tables', async () => {
    const r = await validateDbFile(goodPath)
    expect(r.ok).toBe(true)
  })

  it('rejects a non-sqlite file', async () => {
    const r = await validateDbFile(badPath)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('rejects a missing file', async () => {
    const r = await validateDbFile(path.join(dir, 'nope.db'))
    expect(r.ok).toBe(false)
  })

  it('rejects a valid sqlite db missing a required table', async () => {
    const partialPath = path.join(dir, 'partial.db')
    const partial = createClient({ url: `file:${partialPath}` })
    await partial.executeMultiple('CREATE TABLE only_one (id INTEGER PRIMARY KEY);')
    await partial.close()
    const r = await validateDbFile(partialPath)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('news_archive')
  })

  it('rejects a db with required tables but missing required columns (旧结构库)', async () => {
    const oldPath = path.join(dir, 'old-structure.db')
    const old = createClient({ url: `file:${oldPath}` })
    // news_archive 缺 source/source_id/content/published_at —— 老库常见形态
    await old.executeMultiple(`
      CREATE TABLE news_archive (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    `)
    await old.close()
    const r = await validateDbFile(oldPath)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('news_archive')
    expect(r.error).toContain('source')
  })

  it('checkpoints WAL before copy: -wal 中的已提交数据不丢失', async () => {
    const walSrc = path.join(dir, 'wal-src.db')
    const db = createClient({ url: `file:${walSrc}` })
    await db.executeMultiple(`
      CREATE TABLE news_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT, content TEXT NOT NULL, published_at TEXT NOT NULL
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
    `)
    await db.execute('PRAGMA journal_mode=WAL')
    // 写入后不关闭连接 → 数据留在 -wal 中,主文件不含该行
    await db.execute({
      sql: 'INSERT INTO news_archive (source, source_id, title, content, published_at) VALUES (?, ?, ?, ?, ?)',
      args: ['sina', 's1', 't', 'c', '2026-08-23T00:00:00Z'],
    })
    await db.close()

    const dest = path.join(dir, 'wal-copied.db')
    const r = await importDbFile(walSrc, dest)
    expect(r.ok).toBe(true)
    // 复制出的库必须能查到 WAL 中那条已提交数据
    const check = createClient({ url: `file:${dest}` })
    const res = await check.execute({ sql: 'SELECT COUNT(*) as n FROM news_archive', args: [] })
    await check.close()
    expect(Number(res.rows[0].n)).toBe(1)
  })
})

describe('importDbFile', () => {
  it('copies file to destination only when valid', async () => {
    const dest = path.join(dir, 'copied.db')
    const r = await importDbFile(goodPath, dest)
    expect(r.ok).toBe(true)
    expect(fs.existsSync(dest)).toBe(true)
  })

  it('does not copy an invalid file', async () => {
    const dest = path.join(dir, 'copied2.db')
    const r = await importDbFile(badPath, dest)
    expect(r.ok).toBe(false)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('rename 遇 EPERM(目标文件被占用)→ 回退 copyFile 仍成功', async () => {
    const dest = path.join(dir, 'eperm.db')
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      const err = new Error('EPERM: operation not permitted')
      err.code = 'EPERM'
      throw err
    })
    try {
      const r = await importDbFile(goodPath, dest)
      expect(r.ok).toBe(true)
      expect(fs.existsSync(dest)).toBe(true)
    } finally {
      renameSpy.mockRestore()
    }
  })
})
