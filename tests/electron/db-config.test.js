import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { dbConfigFile, dbConfigPathFor, readDbConfig, isRemoteDbConfig } from '../../electron/db-config'

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

  it('dev 跟随 DB_CONFIG_PATH，打包版固定用数据目录', () => {
    expect(dbConfigPathFor({ dev: true, env: { DB_CONFIG_PATH: '/tmp/x.json' }, dbPath: '/data/news.db' }))
      .toBe('/tmp/x.json')
    expect(dbConfigPathFor({ dev: false, env: { DB_CONFIG_PATH: '/tmp/x.json' }, dbPath: '/data/news.db' }))
      .toBe('/data/db-config.json')
  })

  it('远端判定与环境变量同优先级：DB_BACKEND > Vercel > 设置文件', () => {
    expect(isRemoteDbConfig({ DB_BACKEND: 'turso' }, { backend: 'local' })).toBe(true)
    expect(isRemoteDbConfig({ DB_BACKEND: 'local' }, { backend: 'turso' })).toBe(false)
    expect(isRemoteDbConfig({ VERCEL: '1' }, { backend: 'local' })).toBe(true)
    expect(isRemoteDbConfig({}, { backend: 'turso' })).toBe(true)
    expect(isRemoteDbConfig({}, { backend: 'local' })).toBe(false)
    expect(isRemoteDbConfig({}, null)).toBe(false)
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

  it('本地配置不带空字符串字段（与服务端 readDbConfig 一致）', () => {
    const file = path.join(tempDir(), 'db-config.json')
    fs.writeFileSync(file, JSON.stringify({ backend: 'local', tursoUrl: '', tursoToken: '' }))
    expect(readDbConfig(file)).toEqual({ backend: 'local' })
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
