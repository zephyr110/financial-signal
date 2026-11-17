import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from '../pages/api/desktop/runtime'
import { getAllSettings } from '../lib/settings'

vi.mock('../lib/settings', () => ({
  getAllSettings: vi.fn(),
  SETTING_KEYS: { LLM_API_KEY: 'llm_api_key' },
}))

function mockReq(method = 'GET', headers: Record<string, string> = {}) {
  return { method, headers }
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

const localHeaders = { origin: 'http://127.0.0.1:3010', host: '127.0.0.1:3010' }

describe('/api/desktop/runtime', () => {
  beforeEach(() => {
    vi.mocked(getAllSettings).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    delete process.env.LLM_API_KEY
    delete process.env.DEEPSEEK_API_KEY
  })

  it('非桌面模式 → 404（不暴露内部状态）', async () => {
    const res = mockRes()
    await handler(mockReq('GET', localHeaders), res)
    expect(res._status).toBe(404)
    expect(getAllSettings).not.toHaveBeenCalled()
  })

  it('桌面模式但 Origin 非本机 → 403', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    const res = mockRes()
    await handler(mockReq('GET', { origin: 'https://evil.example', host: '127.0.0.1:3010' }), res)
    expect(res._status).toBe(403)
    expect(getAllSettings).not.toHaveBeenCalled()
  })

  it('桌面模式只接受 GET → 405', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    const res = mockRes()
    await handler(mockReq('POST', localHeaders), res)
    expect(res._status).toBe(405)
    expect(res._headers.Allow).toEqual(['GET'])
  })

  it('以数据库中的 LLM key 为准', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getAllSettings).mockResolvedValue({ llm_api_key: 'sk-db' } as any)
    const res = mockRes()
    await handler(mockReq('GET', localHeaders), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ llmConfigured: true })
    expect(res._headers['Cache-Control']).toBe('no-store')
  })

  it('未配置 key → false，环境变量可兜底', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getAllSettings).mockResolvedValue({} as any)
    const first = mockRes()
    await handler(mockReq('GET', localHeaders), first)
    expect(first._body).toEqual({ llmConfigured: false })

    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env')
    const second = mockRes()
    await handler(mockReq('GET', localHeaders), second)
    expect(second._body).toEqual({ llmConfigured: true })
  })
})
