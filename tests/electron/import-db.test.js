import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createClient } from '@libsql/client'
import { validateDbFile, importDbFile } from '../../electron/import-db'

let dir, goodPath, badPath

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-test-'))
  goodPath = path.join(dir, 'good.db')
  const db = createClient({ url: `file:${goodPath}` })
  await db.executeMultiple(`
    CREATE TABLE news_archive (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
  `)
  await db.close()
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
})
