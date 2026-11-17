import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from '../pages/api/desktop/runtime'
import { getEffectiveLlmConfig } from '../lib/llm/config'

// key 解析与环境变量回退由 tests/llm-config.test.ts 覆盖；这里只测路由的门卫与映射。
vi.mock('../lib/llm/config', () => ({
  getEffectiveLlmConfig: vi.fn(),
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
const emptyConfig = { apiKey: '', baseUrl: '', model: '' }

describe('/api/desktop/runtime', () => {
  beforeEach(() => {
    vi.mocked(getEffectiveLlmConfig).mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('非桌面模式 → 404（不暴露内部状态）', async () => {
    const res = mockRes()
    await handler(mockReq('GET', localHeaders), res)
    expect(res._status).toBe(404)
    expect(getEffectiveLlmConfig).not.toHaveBeenCalled()
  })

  it('桌面模式但 Origin 非本机 → 403', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    const res = mockRes()
    await handler(mockReq('GET', { origin: 'https://evil.example', host: '127.0.0.1:3010' }), res)
    expect(res._status).toBe(403)
    expect(getEffectiveLlmConfig).not.toHaveBeenCalled()
  })

  it('桌面模式只接受 GET → 405', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    const res = mockRes()
    await handler(mockReq('POST', localHeaders), res)
    expect(res._status).toBe(405)
    expect(res._headers.Allow).toEqual(['GET'])
  })

  it('配置了 key → true', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getEffectiveLlmConfig).mockResolvedValue({ ...emptyConfig, apiKey: 'sk-db' })
    const res = mockRes()
    await handler(mockReq('GET', localHeaders), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ llmConfigured: true })
    expect(res._headers['Cache-Control']).toBe('no-store')
  })

  it('没有 key → false', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getEffectiveLlmConfig).mockResolvedValue(emptyConfig)
    const res = mockRes()
    await handler(mockReq('GET', localHeaders), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ llmConfigured: false })
  })

  it('解析配置失败 → 500（调度器据此降级为只抓取）', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.mocked(getEffectiveLlmConfig).mockRejectedValue(new Error('db down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = mockRes()
      await handler(mockReq('GET', localHeaders), res)
      expect(res._status).toBe(500)
    } finally {
      errorSpy.mockRestore()
    }
  })
})
