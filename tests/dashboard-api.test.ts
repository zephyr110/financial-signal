import path from 'path'
import os from 'os'
import fs from 'fs'
import type { NextApiRequest, NextApiResponse } from 'next'
import { describe, it, expect, beforeAll, vi } from 'vitest'

/** 聚合接口只做读取与区块筛选，不触碰真实账号与数据。 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-api-test-'))
let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>

function mockReq(method: string, query: Record<string, string> = {}): NextApiRequest {
  return { method, query, headers: {}, body: undefined } as unknown as NextApiRequest
}

function mockRes() {
  const res: any = {
    _status: 200,
    _body: null,
    _headers: {} as Record<string, unknown>,
    status(code: number) { this._status = code; return this },
    setHeader(name: string, value: unknown) { this._headers[name] = value; return this },
    json(body: unknown) { this._body = body; return this },
  }
  return res as NextApiResponse & typeof res
}

beforeAll(async () => {
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  delete process.env.COCKPIT_DEMO
  process.env.NEWS_DB_PATH = path.join(dir, 'dashboard-api.db')
  vi.resetModules()
  handler = (await import('../pages/api/dashboard')).default
})

describe('/api/dashboard', () => {
  it('只返回请求的区块，且禁止缓存', async () => {
    const res = mockRes()
    await handler(mockReq('GET', { sections: 'watchlist,tasks' }), res)
    expect(res._status).toBe(200)
    expect(Object.keys(res._body.data.sections)).toEqual(['watchlist', 'tasks'])
    expect(res._headers['Cache-Control']).toContain('no-store')
  })

  it('区块读取失败也返回 200，由前端按区块展示错误', async () => {
    const res = mockRes()
    await handler(mockReq('GET', { sections: 'pulse' }), res)
    expect(res._status).toBe(200)
    expect(res._body.data.sections.pulse.ok).toBe(true)
  })

  it('非 GET 方法返回 405', async () => {
    const res = mockRes()
    await handler(mockReq('POST'), res)
    expect(res._status).toBe(405)
  })
})
