import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import handler from '../pages/api/health'
import { getDb } from '../lib/db'
import { getPipelineHealth } from '../lib/pipeline'

/**
 * C2:prod 回归测试——桌面端首启(prod + 全新空 db 文件):
 * 健康检查在 db 文件缺失时不得触发 getDb(否则 lib/db initSchema 抢先建库,
 * 渲染层 getInfo 的 imported 恒 true,欢迎页永不出现)。
 *
 * 文件存在时保持原语义:getDb + pipeline 聚合 → 200 db:'ok';连接失败 → 503。
 * Turso 模式无文件概念,即使 NEWS_DB_PATH 指向缺失文件也照常 getDb。
 */
vi.mock('../lib/db', () => ({ getDb: vi.fn() }))
vi.mock('../lib/pipeline', () => ({ getPipelineHealth: vi.fn() }))

function mockReq(method = 'GET') {
  return { method }
}

function mockRes() {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { this._status = code; return this },
    setHeader() { return this },
    json(body: unknown) { this._body = body; return this },
    end() { return this },
  }
  return res
}

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-test-'))
  // 隔离环境:本测试只关心本地文件模式,确保 Turso 变量不存在
  delete process.env.TURSO_DATABASE_URL
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('GET /api/health', () => {
  it('db 文件缺失 + DESKTOP_MODE=1(桌面端首启)→ 200 + db:"missing",不触发 getDb(不抢先建库)', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.stubEnv('NEWS_DB_PATH', path.join(dir, 'nope.db'))
    const res = mockRes()
    await handler(mockReq(), res)

    expect(res._status).toBe(200)
    expect(res._body.ok).toBe(true)
    expect(res._body.db).toBe('missing')
    expect(res._body.pipeline).toBeNull()
    expect(res._body.latency_ms).toBeGreaterThanOrEqual(0)
    expect(getDb).not.toHaveBeenCalled()
    expect(getPipelineHealth).not.toHaveBeenCalled()
  })

  it('db 文件缺失同样对 HEAD 生效', async () => {
    vi.stubEnv('DESKTOP_MODE', '1')
    vi.stubEnv('NEWS_DB_PATH', path.join(dir, 'nope.db'))
    const res = mockRes()
    await handler(mockReq('HEAD'), res)

    expect(res._status).toBe(200)
    expect(res._body).toBeNull()
    expect(getDb).not.toHaveBeenCalled()
  })

  it('db 文件缺失 + 无 DESKTOP_MODE(web 自托管)→ 原行为:getDb 自愈建库', async () => {
    vi.stubEnv('NEWS_DB_PATH', path.join(dir, 'nope.db'))
    vi.mocked(getDb).mockResolvedValue({ execute: vi.fn().mockResolvedValue({ rows: [] }) } as any)
    vi.mocked(getPipelineHealth).mockResolvedValue({ hours: 24, jobs: [] } as any)

    const res = mockRes()
    await handler(mockReq(), res)

    expect(getDb).toHaveBeenCalledTimes(1) // 缺文件时桌面端 200 伪装不得泄漏到 web 探活
    expect(res._status).toBe(200)
    expect(res._body.db).toBe('ok')
  })

  it('db 文件存在 → 原行为:getDb + pipeline 聚合,200 + db:"ok"', async () => {
    const dbFile = path.join(dir, 'ok.db')
    fs.writeFileSync(dbFile, '') // 空文件即可,existsSync 只看存在性
    vi.stubEnv('NEWS_DB_PATH', dbFile)
    const pipeline = { hours: 24, jobs: [] }
    vi.mocked(getDb).mockResolvedValue({ execute: vi.fn().mockResolvedValue({ rows: [] }) } as any)
    vi.mocked(getPipelineHealth).mockResolvedValue(pipeline as any)

    const res = mockRes()
    await handler(mockReq(), res)

    expect(getDb).toHaveBeenCalledTimes(1)
    expect(getPipelineHealth).toHaveBeenCalledWith(24)
    expect(res._status).toBe(200)
    expect(res._body.db).toBe('ok')
    expect(res._body.pipeline).toEqual(pipeline)
  })

  it('db 文件存在但连接失败 → 503 + db:"error"(原语义不变)', async () => {
    const dbFile = path.join(dir, 'bad.db')
    fs.writeFileSync(dbFile, '')
    vi.stubEnv('NEWS_DB_PATH', dbFile)
    vi.mocked(getDb).mockRejectedValue(new Error('connection refused'))

    const res = mockRes()
    await handler(mockReq(), res)

    expect(res._status).toBe(503)
    expect(res._body.ok).toBe(false)
    expect(res._body.db).toBe('error')
    expect(res._body.db_error).toBe('connection refused')
  })

  it('Turso 模式:文件概念不存在,NEWS_DB_PATH 缺失也照常 getDb(行为不变)', async () => {
    vi.stubEnv('TURSO_DATABASE_URL', 'https://example.turso.io')
    vi.stubEnv('NEWS_DB_PATH', path.join(dir, 'nope.db'))
    vi.mocked(getDb).mockResolvedValue({ execute: vi.fn().mockResolvedValue({ rows: [] }) } as any)
    vi.mocked(getPipelineHealth).mockResolvedValue({ hours: 24, jobs: [] } as any)

    const res = mockRes()
    await handler(mockReq(), res)

    expect(getDb).toHaveBeenCalledTimes(1)
    expect(res._status).toBe(200)
    expect(res._body.db).toBe('ok')
  })
})
