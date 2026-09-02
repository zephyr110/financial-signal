import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'

/**
 * 桌面端认证库分离:login 只写 auth.db,不得抢先创建 news_archive.db(首启欢迎页依赖主库文件缺失)。
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-db-test-'))

async function loadAuth(newsDb: string) {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.DESKTOP_MODE = '1'
  process.env.ADMIN_INITIAL_PASSWORD = 'seed-pass-123'
  process.env.NEWS_DB_PATH = newsDb
  delete process.env.AUTH_DB_PATH
  vi.resetModules()
  const authDbMod = await import('../lib/authDb')
  const authMod = await import('../lib/auth')
  return { authDbMod, authMod }
}

describe('桌面端 auth.db 分离', () => {
  afterEach(() => {
    delete process.env.DESKTOP_MODE
    delete process.env.ADMIN_INITIAL_PASSWORD
    delete process.env.NEWS_DB_PATH
    delete process.env.AUTH_DB_PATH
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('login 创建 auth.db 但不创建 news_archive.db', async () => {
    const newsDb = path.join(dir, 'missing-news.db')
    const authDb = path.join(dir, 'auth.db')
    expect(fs.existsSync(newsDb)).toBe(false)
    expect(fs.existsSync(authDb)).toBe(false)

    const { authMod } = await loadAuth(newsDb)
    const token = await authMod.login('admin', 'seed-pass-123')
    expect(token).not.toBeNull()

    expect(fs.existsSync(authDb)).toBe(true)
    expect(fs.existsSync(newsDb)).toBe(false)
  })

  it('getSessionUser 从 auth.db 校验,不触发主库', async () => {
    const newsDb = path.join(dir, 'still-missing.db')
    const { authMod } = await loadAuth(newsDb)
    const token = await authMod.login('admin', 'seed-pass-123')
    expect(await authMod.getSessionUser(token)).toBe('admin')
    expect(fs.existsSync(newsDb)).toBe(false)
  })
})
