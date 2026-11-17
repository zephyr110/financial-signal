import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  dbConfigPath,
  describeDbStorage,
  isDbBackendLocked,
  readDbConfig,
  writeDbConfig,
} from '../lib/db-config'

const dirs: string[] = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-config-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('dbConfigPath', () => {
  it('显式 DB_CONFIG_PATH 优先', () => {
    expect(dbConfigPath({ DB_CONFIG_PATH: '/tmp/custom.json', NEWS_DB_PATH: '/data/news.db' }))
      .toBe('/tmp/custom.json')
  })

  it('默认与 news_archive.db 同目录', () => {
    expect(dbConfigPath({ NEWS_DB_PATH: '/data/news.db' })).toBe('/data/db-config.json')
  })
})

describe('read/writeDbConfig', () => {
  it('往返读取 Turso 配置，文件权限收紧到 600', () => {
    const file = path.join(tempDir(), 'db-config.json')
    writeDbConfig({ backend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'tok' }, file)
    expect(readDbConfig(file)).toEqual({
      backend: 'turso',
      tursoUrl: 'libsql://db.turso.io',
      tursoToken: 'tok',
    })
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    }
  })

  it('缺失/损坏/无 URL 的 Turso 配置 → null（回退默认本地库）', () => {
    const dir = tempDir()
    const missing = path.join(dir, 'missing.json')
    expect(readDbConfig(missing)).toBeNull()

    const broken = path.join(dir, 'broken.json')
    fs.writeFileSync(broken, '{not json')
    expect(readDbConfig(broken)).toBeNull()

    const noUrl = path.join(dir, 'no-url.json')
    fs.writeFileSync(noUrl, JSON.stringify({ backend: 'turso' }))
    expect(readDbConfig(noUrl)).toBeNull()

    const badBackend = path.join(dir, 'bad.json')
    fs.writeFileSync(badBackend, JSON.stringify({ backend: 'remote' }))
    expect(readDbConfig(badBackend)).toBeNull()
  })
})

describe('describeDbStorage', () => {
  const base = { NODE_ENV: 'production', NEWS_DB_PATH: '/tmp/news.db' }

  it('默认本地库，不需要重启', () => {
    expect(describeDbStorage(base, null, null)).toMatchObject({
      backend: 'local',
      source: 'default',
      locked: false,
      activeBackend: 'local',
      restartRequired: false,
    })
  })

  it('设置选了 Turso 但当前仍连本地 → 提示重启', () => {
    const status = describeDbStorage(base, {
      backend: 'turso',
      tursoUrl: 'libsql://db.turso.io',
    }, { url: 'file:/tmp/news.db' })
    expect(status.backend).toBe('turso')
    expect(status.source).toBe('settings')
    expect(status.restartRequired).toBe(true)
  })

  it('Turso 地址或 token 变更 → 同样提示重启', () => {
    const stored = { backend: 'turso' as const, tursoUrl: 'libsql://new.turso.io', tursoToken: 'new' }
    expect(describeDbStorage(base, stored, { url: 'libsql://old.turso.io', authToken: 'old' }).restartRequired)
      .toBe(true)
    expect(describeDbStorage(base, stored, { url: 'libsql://new.turso.io' }).restartRequired)
      .toBe(true)
    expect(describeDbStorage(base, stored, { url: 'libsql://new.turso.io', authToken: 'new' }).restartRequired)
      .toBe(false)
  })

  it('环境变量锁定后端时设置页不可切换', () => {
    const env = { ...base, DB_BACKEND: 'turso', TURSO_DATABASE_URL: 'libsql://env.turso.io' }
    expect(isDbBackendLocked(env)).toBe(true)
    expect(describeDbStorage(env, null, null)).toMatchObject({
      backend: 'turso',
      source: 'env',
      locked: true,
      urlSet: true,
    })
  })
})
