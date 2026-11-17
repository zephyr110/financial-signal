import fs from 'fs'
import path from 'path'
import os from 'os'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from '../pages/api/settings'
import { getSessionUser } from '../lib/auth'
import { getAllSettings } from '../lib/settings'
import { probeTurso } from '../lib/turso-probe'

// 隔离 DB:settings 写入不能落在共享的项目 DB(并行 worker 会互相污染/锁冲突)
process.env.NEWS_DB_PATH = path.join(os.tmpdir(), `test-settings-${process.pid}.db`)

const dbConfigFile = path.join(os.tmpdir(), `test-settings-db-config-${process.pid}.json`)

// 桌面分支不走会话:getSessionUser 必须被跳过;web 分支用它做 401 判定
vi.mock('../lib/auth', () => ({
  SESSION_COOKIE: 'fs_session',
  getSessionUser: vi.fn(),
}))

// 不真的连远端：连通性探测本身由 lib/turso-probe 负责
vi.mock('../lib/turso-probe', () => ({ probeTurso: vi.fn() }))

// 保留真实实现，个别用例模拟远端库读取失败
vi.mock('../lib/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/settings')>()
  return { ...actual, getAllSettings: vi.fn(actual.getAllSettings) }
})

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
    vi.mocked(getAllSettings).mockClear()
    vi.mocked(probeTurso).mockReset().mockResolvedValue(undefined)
    process.env.DB_CONFIG_PATH = dbConfigFile
    fs.rmSync(dbConfigFile, { force: true })
  })

  afterEach(() => {
    fs.rmSync(dbConfigFile, { force: true })
    delete process.env.DB_CONFIG_PATH
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

  it('GET 返回存储状态:默认本地库、未锁定、无需重启', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(200)
    expect(res._body.storage).toMatchObject({
      backend: 'local',
      locked: false,
      activeBackend: 'local',
      restartRequired: false,
    })
  })

  it('GET 在设置表不可读时仍 200，存储状态可用以切回本地', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    vi.mocked(getAllSettings).mockRejectedValueOnce(new Error('turso down'))
    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(200)
    expect(res._body.settingsUnavailable).toBe(true)
    expect(res._body.llm).toBeDefined()
    expect(res._body.storage).toMatchObject({ backend: 'local', locked: false })
  })

  it('POST 明确切回本地库 → 写配置；当前已连本地库时无需重启', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('POST', { body: { storageBackend: 'local' } }), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ ok: true })
    expect(JSON.parse(fs.readFileSync(dbConfigFile, 'utf8'))).toEqual({ backend: 'local' })
  })

  it('POST 选 Turso 但缺 URL → 400 且不写文件', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('POST', { body: { storageBackend: 'turso' } }), res)
    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/URL/)
    expect(fs.existsSync(dbConfigFile)).toBe(false)
  })

  it('POST 选 Turso 写入 URL/token；再次保存留空 token 时沿用旧值', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'tok' },
    }), mockRes())
    expect(probeTurso).toHaveBeenCalledWith('libsql://db.turso.io', 'tok')
    expect(JSON.parse(fs.readFileSync(dbConfigFile, 'utf8'))).toEqual({
      backend: 'turso',
      tursoUrl: 'libsql://db.turso.io',
      tursoToken: 'tok',
    })

    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoUrl: 'libsql://db2.turso.io', tursoToken: '' },
    }), mockRes())
    expect(JSON.parse(fs.readFileSync(dbConfigFile, 'utf8'))).toEqual({
      backend: 'turso',
      tursoUrl: 'libsql://db2.turso.io',
      tursoToken: 'tok',
    })

    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoToken: null },
    }), mockRes())
    expect(JSON.parse(fs.readFileSync(dbConfigFile, 'utf8'))).toEqual({
      backend: 'turso',
      tursoUrl: 'libsql://db2.turso.io',
    })
    // 清除 token 且地址未变时没有凭据可探测，直接落盘
    expect(vi.mocked(probeTurso)).toHaveBeenCalledTimes(2)
  })

  it('存储配置未变化 → 不探测、不重写、不提示重启', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'tok' },
    }), mockRes())
    const before = fs.readFileSync(dbConfigFile, 'utf8')
    vi.mocked(probeTurso).mockClear()

    const res = mockRes()
    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'tok' },
    }), res)
    expect(res._status).toBe(200)
    expect(res._body).toEqual({ ok: true })
    expect(probeTurso).not.toHaveBeenCalled()
    expect(fs.readFileSync(dbConfigFile, 'utf8')).toBe(before)
  })

  it('切回本地并显式清除 Token → 保留 URL、删除凭据', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'tok' },
    }), mockRes())
    const res = mockRes()
    await handler(mockReq('POST', { body: { storageBackend: 'local', tursoToken: null } }), res)
    expect(res._status).toBe(200)
    expect(JSON.parse(fs.readFileSync(dbConfigFile, 'utf8'))).toEqual({
      backend: 'local',
      tursoUrl: 'libsql://db.turso.io',
    })
  })

  it('Turso 连不上时 400 且不写配置（避免重启后锁死）', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    vi.mocked(probeTurso).mockRejectedValue(new Error('unauthorized: bad token'))
    const res = mockRes()
    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'bad' },
    }), res)
    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/无法连接 Turso/)
    expect(fs.existsSync(dbConfigFile)).toBe(false)
  })

  it('从 Turso 切回本地时保留已存凭据', async () => {
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    await handler(mockReq('POST', {
      body: { storageBackend: 'turso', tursoUrl: 'libsql://db.turso.io', tursoToken: 'tok' },
    }), mockRes())
    const res = mockRes()
    await handler(mockReq('POST', { body: { storageBackend: 'local' } }), res)
    expect(res._status).toBe(200)
    expect(JSON.parse(fs.readFileSync(dbConfigFile, 'utf8'))).toEqual({
      backend: 'local',
      tursoUrl: 'libsql://db.turso.io',
      tursoToken: 'tok',
    })
  })

  it('DB_BACKEND 由环境变量锁定时拒绝在设置中切换', async () => {
    vi.stubEnv('DB_BACKEND', 'local')
    vi.mocked(getSessionUser).mockResolvedValue('admin')
    const res = mockRes()
    await handler(mockReq('POST', { body: { storageBackend: 'turso', tursoUrl: 'libsql://x.turso.io' } }), res)
    expect(res._status).toBe(400)
    expect(res._body.error).toMatch(/环境变量/)
    expect(fs.existsSync(dbConfigFile)).toBe(false)
  })
})
