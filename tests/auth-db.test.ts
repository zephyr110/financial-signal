import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, afterEach, afterAll, vi } from 'vitest'

/**
 * 桌面端认证库分离:login 只写 auth.db,不得抢先创建 news_archive.db(首启欢迎页依赖主库文件缺失)。
 * auth.db 默认解析为 dirname(NEWS_DB_PATH)/auth.db,故每个用例用独立子目录,避免共享同一个 auth.db 文件。
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-db-test-'))

function caseDir(name: string) {
  return fs.mkdtempSync(path.join(dir, `${name}-`))
}

async function loadAuth(newsDb: string, seed = true) {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.DESKTOP_MODE = '1'
  if (seed) process.env.ADMIN_INITIAL_PASSWORD = 'seed-pass-123'
  else delete process.env.ADMIN_INITIAL_PASSWORD
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
    const c = caseDir('login')
    const newsDb = path.join(c, 'news.db')
    const authDb = path.join(c, 'auth.db')
    expect(fs.existsSync(newsDb)).toBe(false)
    expect(fs.existsSync(authDb)).toBe(false)

    const { authMod } = await loadAuth(newsDb)
    const token = await authMod.login('admin', 'seed-pass-123')
    expect(token).not.toBeNull()

    expect(fs.existsSync(authDb)).toBe(true)
    expect(fs.existsSync(newsDb)).toBe(false)
  })

  it('getSessionUser 从 auth.db 校验,不触发主库', async () => {
    const newsDb = path.join(caseDir('session'), 'news.db')
    const { authMod } = await loadAuth(newsDb)
    const token = await authMod.login('admin', 'seed-pass-123')
    expect(await authMod.getSessionUser(token)).toBe('admin')
    expect(fs.existsSync(newsDb)).toBe(false)
  })

  it('桌面首启无 ADMIN_INITIAL_PASSWORD:ensureDefaultAccount/login 不自动建随机账号', async () => {
    const newsDb = path.join(caseDir('no-seed'), 'news.db')
    const { authDbMod, authMod } = await loadAuth(newsDb, false)
    await authMod.ensureDefaultAccount()
    const db = await authDbMod.getAuthDb()
    const rows = await db.execute({ sql: 'SELECT COUNT(*) as n FROM app_account', args: [] })
    expect(Number(rows.rows[0].n)).toBe(0)
    // login 同样不自动建(随机密码对用户不可见,宁可不建也不锁死登录)
    expect(await authMod.login('admin', 'whatever')).toBeNull()
  })

  it('setupAccount 创建账号并直接签发可用会话;重复 setup 拒绝', async () => {
    const newsDb = path.join(caseDir('setup'), 'news.db')
    const { authDbMod, authMod } = await loadAuth(newsDb, false)
    const r = await authMod.setupAccount('admin', 'my-pass-123')
    expect(r.ok).toBe(true)
    expect(r.token).toMatch(/^[0-9a-f]{64}$/)
    expect(await authMod.getSessionUser(r.token!)).toBe('admin')

    const db = await authDbMod.getAuthDb()
    const rows = await db.execute({ sql: 'SELECT COUNT(*) as n FROM app_account', args: [] })
    expect(Number(rows.rows[0].n)).toBe(1)

    const again = await authMod.setupAccount('admin', 'another-pass-1')
    expect(again.ok).toBe(false)
    expect(again.error).toBe('账号已初始化')
    // 首启不抢先创建主库(欢迎页依赖主库文件缺失)
    expect(fs.existsSync(newsDb)).toBe(false)
  })

  it('setupAccount 校验:登录名至少 2 字符、密码至少 6 位,失败不建号', async () => {
    const newsDb = path.join(caseDir('setup-invalid'), 'news.db')
    const { authDbMod, authMod } = await loadAuth(newsDb, false)
    expect((await authMod.setupAccount('a', 'long-enough-1')).ok).toBe(false)
    expect((await authMod.setupAccount('admin', '123')).ok).toBe(false)
    const db = await authDbMod.getAuthDb()
    const rows = await db.execute({ sql: 'SELECT COUNT(*) as n FROM app_account', args: [] })
    expect(Number(rows.rows[0].n)).toBe(0)
  })
})
