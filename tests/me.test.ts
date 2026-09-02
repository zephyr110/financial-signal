import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from '../pages/api/auth/me'
import { getSessionUser } from '../lib/auth'

// 只测 handler 分支:getSessionUser 走 db,这里 mock 掉(web 分支判定逻辑在 lib/auth 自身测试覆盖)
vi.mock('../lib/auth', () => ({
  SESSION_COOKIE: 'fs_session',
  getSessionUser: vi.fn(),
}))

function mockReq(method = 'GET', cookies: Record<string, string> = {}) {
  return { method, cookies }
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

describe('GET /api/auth/me', () => {
  const prevDesktopMode = process.env.DESKTOP_MODE
  beforeEach(() => {
    vi.mocked(getSessionUser).mockReset()
    delete process.env.DESKTOP_MODE
  })
  afterEach(() => {
    if (prevDesktopMode === undefined) delete process.env.DESKTOP_MODE
    else process.env.DESKTOP_MODE = prevDesktopMode
  })

  it('web 模式无会话 → 401 { authenticated:false }', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null)
    const res = mockRes()
    await handler(mockReq('GET', { fs_session: 'bad-token' }), res)
    expect(res._status).toBe(401)
    expect(res._body).toEqual({ authenticated: false })
  })

  it('web 模式有效会话 → 200 { authenticated:true, username }', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('GET', { fs_session: 'good-token' }), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ authenticated: true, username: 'admin' })
  })

  it('桌面模式无会话 → 401(与 web 一致,走真实会话校验)', async () => {
    process.env.DESKTOP_MODE = '1'
    vi.mocked(getSessionUser).mockResolvedValue(null)
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(401)
    expect(res._body).toEqual({ authenticated: false })
  })

  it('桌面模式有效会话 → 200 { authenticated:true, username }', async () => {
    process.env.DESKTOP_MODE = '1'
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('GET', { fs_session: 'good-token' }), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ authenticated: true, username: 'admin' })
  })

  it('非 GET → 405', async () => {
    const res = mockRes()
    await handler(mockReq('POST'), res)
    expect(res._status).toBe(405)
    expect(res._headers.Allow).toEqual(['GET'])
  })
})
