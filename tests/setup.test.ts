import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from '../pages/api/auth/setup'
import { setupAccount, sessionCookie } from '../lib/auth'

// 只测 handler 门禁与响应:setupAccount 的账号逻辑在 lib/auth 自身测试覆盖(auth-db.test.ts)
vi.mock('../lib/auth', () => ({
  setupAccount: vi.fn(),
  sessionCookie: vi.fn(() => 'fs_session=mock-token; Path=/; HttpOnly; SameSite=Lax'),
}))

function mockReq(method = 'POST', body: unknown = {}) {
  return { method, body }
}

function mockRes() {
  const res: any = {
    _status: 200,
    _body: null,
    _headers: {},
    status(code: number) { this._status = code; return this },
    setHeader(name: string, value: string) { this._headers[name] = value; return this },
    json(body: unknown) { this._body = body; return this },
  }
  return res
}

describe('POST /api/auth/setup', () => {
  beforeEach(() => {
    vi.mocked(setupAccount).mockReset()
    delete process.env.DESKTOP_MODE
  })
  afterEach(() => {
    delete process.env.DESKTOP_MODE
  })

  it('非桌面模式 → 403', async () => {
    const res = mockRes()
    await handler(mockReq('POST', { password: 'whatever-1' }), res)
    expect(res._status).toBe(403)
    expect(setupAccount).not.toHaveBeenCalled()
  })

  it('桌面模式创建成功 → 200 + Set-Cookie 会话', async () => {
    process.env.DESKTOP_MODE = '1'
    vi.mocked(setupAccount).mockResolvedValue({ ok: true, token: 'token-123' })
    const res = mockRes()
    await handler(mockReq('POST', { username: 'admin', password: 'my-pass-123' }), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ ok: true })
    expect(setupAccount).toHaveBeenCalledWith('admin', 'my-pass-123')
    expect(res._headers['Set-Cookie']).toContain('fs_session=mock-token')
  })

  it('桌面模式校验失败 → 400 透传 error(如账号已初始化)', async () => {
    process.env.DESKTOP_MODE = '1'
    vi.mocked(setupAccount).mockResolvedValue({ ok: false, error: '账号已初始化' })
    const res = mockRes()
    await handler(mockReq('POST', { username: 'admin', password: 'short' }), res)
    expect(res._status).toBe(400)
    expect(res._body).toEqual({ error: '账号已初始化' })
  })

  it('缺 password → 默认 username=admin,空密码交给 setupAccount 校验', async () => {
    process.env.DESKTOP_MODE = '1'
    vi.mocked(setupAccount).mockResolvedValue({ ok: false, error: '密码至少 6 位' })
    const res = mockRes()
    await handler(mockReq('POST', {}), res)
    expect(setupAccount).toHaveBeenCalledWith('admin', '')
    expect(res._status).toBe(400)
    expect(res._body).toEqual({ error: '密码至少 6 位' })
  })

  it('非 POST → 405', async () => {
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(405)
    expect(res._headers.Allow).toEqual(['POST'])
  })
})
