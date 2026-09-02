import { describe, it, expect, beforeEach, vi } from 'vitest'
import handler from '../pages/api/agent-sessions'
import { renameAgentSession, agentSessionExists } from '../lib/db'

vi.mock('../lib/db', () => ({
  listAgentSessions: vi.fn(),
  getAgentMessages: vi.fn(),
  deleteAgentSession: vi.fn(),
  renameAgentSession: vi.fn(),
  agentSessionExists: vi.fn(),
}))

function mockReq(method = 'GET', { query = {}, body, headers = {} }: {
  query?: Record<string, string>
  body?: Record<string, unknown>
  headers?: Record<string, string>
} = {}) {
  return { method, query, body, headers }
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

describe('PATCH /api/agent-sessions', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    vi.mocked(agentSessionExists).mockReset()
    vi.mocked(renameAgentSession).mockReset()
  })

  it('重命名成功 → 200', async () => {
    vi.mocked(agentSessionExists).mockResolvedValue(true)
    vi.mocked(renameAgentSession).mockResolvedValue(true)
    const res = mockRes()
    await handler(mockReq('PATCH', { query: { id: '1' }, body: { title: '我的研究' } }), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ ok: true, sessionId: 1, title: '我的研究' })
    expect(renameAgentSession).toHaveBeenCalledWith(1, '我的研究')
  })

  it('标题为空 → 400', async () => {
    const res = mockRes()
    await handler(mockReq('PATCH', { query: { id: '1' }, body: { title: '   ' } }), res)
    expect(res._status).toBe(400)
    expect(agentSessionExists).not.toHaveBeenCalled()
  })

  it('会话不存在 → 404', async () => {
    vi.mocked(agentSessionExists).mockResolvedValue(false)
    const res = mockRes()
    await handler(mockReq('PATCH', { query: { id: '9' }, body: { title: 'x' } }), res)
    expect(res._status).toBe(404)
  })

  it('桌面模式跨站 Origin → 403', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    const res = mockRes()
    await handler(
      mockReq('PATCH', {
        query: { id: '1' },
        body: { title: 'x' },
        headers: { origin: 'https://evil.example', host: '127.0.0.1:3010' },
      }),
      res,
    )
    expect(res._status).toBe(403)
    expect(renameAgentSession).not.toHaveBeenCalled()
  })
})
