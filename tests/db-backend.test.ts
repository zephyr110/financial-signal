import { describe, expect, it } from 'vitest'
import { resolveDbTarget } from '../lib/db'

const base = { NODE_ENV: 'production', NEWS_DB_PATH: '/tmp/cockpit-test.db' }

describe('resolveDbTarget', () => {
  it('默认本地库，即使环境里残留 TURSO_*', () => {
    const target = resolveDbTarget({
      ...base,
      TURSO_DATABASE_URL: 'libsql://stale.turso.io',
      TURSO_AUTH_TOKEN: 'stale-token',
    })
    expect(target).toEqual({ url: 'file:/tmp/cockpit-test.db' })
  })

  it('DB_BACKEND=turso 时连接远端', () => {
    expect(resolveDbTarget({
      ...base,
      DB_BACKEND: 'turso',
      TURSO_DATABASE_URL: 'libsql://db.turso.io',
      TURSO_AUTH_TOKEN: 'token',
    })).toEqual({ url: 'libsql://db.turso.io', authToken: 'token' })
  })

  it('DB_BACKEND=turso 缺少 URL 时明确报错', () => {
    expect(() => resolveDbTarget({ ...base, DB_BACKEND: 'turso' })).toThrow(/TURSO_DATABASE_URL/)
  })

  it('非法 DB_BACKEND 报错', () => {
    expect(() => resolveDbTarget({ ...base, DB_BACKEND: 'remote' })).toThrow(/local 或 turso/)
  })

  it('Vercel 未指定后端时仍默认 Turso', () => {
    expect(resolveDbTarget({
      ...base,
      VERCEL: '1',
      TURSO_DATABASE_URL: 'libsql://db.turso.io',
    }).url).toBe('libsql://db.turso.io')
    expect(() => resolveDbTarget({ ...base, VERCEL: '1' })).toThrow(/TURSO_DATABASE_URL/)
  })

  it('Vercel 拒绝显式本地库', () => {
    expect(() => resolveDbTarget({ ...base, VERCEL: '1', DB_BACKEND: 'local' })).toThrow(/持久磁盘/)
  })

  it('测试环境强制本地库', () => {
    expect(resolveDbTarget({
      NODE_ENV: 'test',
      NEWS_DB_PATH: '/tmp/test-isolated.db',
      TURSO_DATABASE_URL: 'libsql://shared.turso.io',
    })).toEqual({ url: 'file:/tmp/test-isolated.db' })
  })

  it('设置在启动配置里选了 Turso → 连接远端', () => {
    expect(resolveDbTarget(base, {
      backend: 'turso',
      tursoUrl: 'libsql://stored.turso.io',
      tursoToken: 'stored-token',
    })).toEqual({ url: 'libsql://stored.turso.io', authToken: 'stored-token' })
  })

  it('环境变量 DB_BACKEND 优先于设置文件', () => {
    expect(resolveDbTarget(
      { ...base, DB_BACKEND: 'local' },
      { backend: 'turso', tursoUrl: 'libsql://stored.turso.io' },
    )).toEqual({ url: 'file:/tmp/cockpit-test.db' })
  })

  it('Vercel 忽略设置文件，只认环境变量', () => {
    expect(resolveDbTarget(
      { ...base, VERCEL: '1', TURSO_DATABASE_URL: 'libsql://env.turso.io' },
      { backend: 'turso', tursoUrl: 'libsql://stored.turso.io' },
    ).url).toBe('libsql://env.turso.io')
  })

  it('设置文件里的 Turso 缺 URL → 回退本地库', () => {
    expect(resolveDbTarget(base, { backend: 'turso' })).toEqual({ url: 'file:/tmp/cockpit-test.db' })
  })
})
