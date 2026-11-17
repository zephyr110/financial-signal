import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { dbConfigFile, readDbConfig } from '../../electron/db-config'

const dirs = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-db-config-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('electron/db-config', () => {
  it('配置与 news_archive.db 同目录', () => {
    expect(dbConfigFile('/data/news_archive.db')).toBe('/data/db-config.json')
  })

  it('读取 Turso 配置', () => {
    const file = path.join(tempDir(), 'db-config.json')
    fs.writeFileSync(file, JSON.stringify({
      backend: 'turso', tursoUrl: ' libsql://db.turso.io ', tursoToken: 'tok',
    }))
    expect(readDbConfig(file)).toEqual({
      backend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'tok',
    })
  })

  it('缺失/损坏/无 URL 时返回 null', () => {
    const dir = tempDir()
    expect(readDbConfig(path.join(dir, 'missing.json'))).toBeNull()
    fs.writeFileSync(path.join(dir, 'broken.json'), '{')
    expect(readDbConfig(path.join(dir, 'broken.json'))).toBeNull()
    fs.writeFileSync(path.join(dir, 'no-url.json'), JSON.stringify({ backend: 'turso' }))
    expect(readDbConfig(path.join(dir, 'no-url.json'))).toBeNull()
  })
})
