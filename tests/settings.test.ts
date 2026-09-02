import path from 'path'
import os from 'os'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import handler from '../pages/api/settings'
import { getSessionUser, SESSION_COOKIE } from '../lib/auth'

// 隔离 DB:settings 写入不能落在共享的项目 DB(并行 worker 会互相污染/锁冲突)
process.env.NEWS_DB_PATH = path.join(os.tmpdir(), `test-settings-${process.pid}.db`)

// 桌面分支不走会话:getSessionUser 必须被跳过;web 分支用它做 401 判定
vi.mock('../lib/auth', () => ({
  SESSION_COOKIE: 'fs_session',
  getSessionUser: vi.fn(),
}))

function mockReq(method = 'GET', { cookies = {}, headers = {}, body }: {
  cookies?: Record<string, string>
  headers?: Record<string, string>
  body?: Record<string, unknown>
} = {}) {
  return { method, cookies, headers, body }
}

function mockRes() {
  const res: any = {
    _status: 200,
    _body: null,
    _headers: {},
    status(code: number) { this._status = code; return this },
    setHeader(name: string, value: unknown) { this._headers[name] = value; return this },
    json(body: unknown) { this._body = body; return this },
  }
  return res
}

describe('/api/settings', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.mocked(getSessionUser).mockReset()
  })

  it('web 模式无会话 → 401', async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null)
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(401)
  })

  it('web 模式有效会话 → 200 返回配置', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(200)
    expect(res._body.llm).toBeDefined()
  })

  it('桌面模式 GET 无 cookie → 401(与会话鉴权一致)', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getSessionUser).mockResolvedValue(null)
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(401)
  })

  it('桌面模式 GET 有效会话 → 200', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(200)
    expect(res._body.llm).toBeDefined()
  })

  it('桌面模式 POST 无会话 → 401', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getSessionUser).mockResolvedValue(null)
    const res = mockRes()
    await handler(mockReq('POST', { headers: { origin: 'http://127.0.0.1:3010', host: '127.0.0.1:3010' }, body: { llmModel: 'gpt-x' } }), res)
    expect(res._status).toBe(401)
  })

  it('桌面模式 POST 恶意 Origin → 403(防 form-POST 窃取 API key)', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('POST', { headers: { origin: 'https://evil.example' }, body: { llmModel: 'gpt-x' } }), res)
    expect(res._status).toBe(403)
    expect(res._body.error).toBe('Forbidden origin')
  })

  it('桌面模式 POST 本机 Origin(端口匹配 Host)→ 200 并落库', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('POST', { headers: { origin: 'http://127.0.0.1:3010', host: '127.0.0.1:3010' }, body: { llmModel: 'deepseek-chat' } }), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ ok: true })
  })

  it('桌面模式 POST 本机 Origin 但端口不匹配 Host → 403(同机其他本地服务)', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('POST', { headers: { origin: 'http://127.0.0.1:9999', host: '127.0.0.1:3010' }, body: { llmModel: 'gpt-x' } }), res)
    expect(res._status).toBe(403)
    expect(res._body.error).toBe('Forbidden origin')
  })

  it('web 模式 POST 恶意 Origin + 有效会话 → 200(web 只走会话鉴权,Origin 不参与)', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('POST', { headers: { origin: 'https://evil.example' }, body: { llmModel: 'gpt-x' } }), res)
    expect(res._status).toBe(200)
  })
})
