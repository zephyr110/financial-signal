import path from 'path'
import os from 'os'
import fs from 'fs'
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { hashToken } from '../lib/auth'

/**
 * 会话认证安全加固测试（B1/B2/B5/B6）：
 *  - B2:会话 token 存库前 SHA-256 哈希(明文只出现在 cookie),DB 泄露不可直接冒用
 *  - B1:changeAccount 改密/改名后全部会话吊销(已泄露会话不得继续有效)
 *  - B5:token 为 64 hex 字符(256 位熵)的 randomBytes 输出(无弱熵 fallback)
 *  - B6:ensureDefaultAccount 幂等(并发首启不重复建账号/不 500)
 * 每个用例独立 DB 文件 + vi.resetModules 重载 lib/db、lib/auth。
 * 隔离:显式删除 Turso 环境变量(双保险——lib/db 在 NODE_ENV=test 下也强制本地文件),
 * 本套测试含破坏性操作(改密/清会话),严禁连到开发机 shell 导出的共享 Turso 库。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-session-test-'))

async function loadAuth(file: string) {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  process.env.NEWS_DB_PATH = file
  vi.resetModules()
  const dbMod = await import('../lib/db')
  const authMod = await import('../lib/auth')
  return { dbMod, authMod }
}

describe('会话认证加固', () => {
  beforeEach(() => {
    // 固定种子密码:避免随机初始密码(会 console.warn)与不可控
    process.env.ADMIN_INITIAL_PASSWORD = 'seed-pass-123'
  })
  afterEach(() => {
    delete process.env.ADMIN_INITIAL_PASSWORD
    delete process.env.NEWS_DB_PATH
  })
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('B5+B2:login 签发 64 位 hex token,DB 存 SHA-256 哈希而非明文,并关联 user_id', async () => {
    const file = path.join(dir, 't1.db')
    const { dbMod, authMod } = await loadAuth(file)
    const db = await dbMod.getDb()

    const token = await authMod.login('admin', 'seed-pass-123')
    expect(token).not.toBeNull()
    expect(token).toMatch(/^[0-9a-f]{64}$/)

    const rows = await db.execute({ sql: 'SELECT token, user_id FROM app_session', args: [] })
    expect(rows.rows).toHaveLength(1)
    expect(String(rows.rows[0].token)).toBe(hashToken(token!))
    expect(String(rows.rows[0].token)).not.toBe(token) // 明文不得落库
    expect(String(rows.rows[0].user_id)).toBe('1') // 关联到 admin 账号
  })

  it('B2:getSessionUser 用明文 cookie token 校验通过,logout 后失效', async () => {
    const file = path.join(dir, 't2.db')
    const { authMod } = await loadAuth(file)

    const token = await authMod.login('admin', 'seed-pass-123')
    expect(token).not.toBeNull()

    expect(await authMod.getSessionUser(token)).toBe('admin')
    // 错误 token / 缺失 token 均拒绝
    expect(await authMod.getSessionUser('ffff'.padEnd(64, 'f'))).toBeNull()
    expect(await authMod.getSessionUser(null)).toBeNull()

    await authMod.logout(token)
    expect(await authMod.getSessionUser(token)).toBeNull()
  })

  it('B1:changeAccount 改密后全部旧会话失效;新密码可重新登录', async () => {
    const file = path.join(dir, 't3.db')
    const { authMod } = await loadAuth(file)

    const oldToken = await authMod.login('admin', 'seed-pass-123')
    expect(oldToken).not.toBeNull()
    expect(await authMod.getSessionUser(oldToken)).toBe('admin')

    const res = await authMod.changeAccount({
      currentPassword: 'seed-pass-123',
      password: 'new-pass-456',
    })
    expect(res.ok).toBe(true)

    // B1:改密后旧会话被吊销
    expect(await authMod.getSessionUser(oldToken)).toBeNull()
    // 旧密码无法登录
    expect(await authMod.login('admin', 'seed-pass-123')).toBeNull()
    // 新密码可登录,且新会话有效
    const newToken = await authMod.login('admin', 'new-pass-456')
    expect(newToken).not.toBeNull()
    expect(await authMod.getSessionUser(newToken)).toBe('admin')
  })

  it('B1:仅改登录名同样吊销旧会话', async () => {
    const file = path.join(dir, 't4.db')
    const { authMod } = await loadAuth(file)

    const token = await authMod.login('admin', 'seed-pass-123')
    expect(token).not.toBeNull()

    const res = await authMod.changeAccount({ currentPassword: 'seed-pass-123', username: 'new-admin' })
    expect(res.ok).toBe(true)
    expect(await authMod.getSessionUser(token)).toBeNull()

    const newToken = await authMod.login('new-admin', 'seed-pass-123')
    expect(newToken).not.toBeNull()
  })

  it('B6:ensureDefaultAccount 幂等,重复调用只保留一个账号', async () => {
    const file = path.join(dir, 't5.db')
    const { dbMod, authMod } = await loadAuth(file)

    await authMod.ensureDefaultAccount()
    await authMod.ensureDefaultAccount()

    const db = await dbMod.getDb()
    const rows = await db.execute({ sql: 'SELECT COUNT(*) as n FROM app_account', args: [] })
    expect(Number(rows.rows[0].n)).toBe(1)
  })
})
