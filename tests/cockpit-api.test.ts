import path from 'path'
import os from 'os'
import fs from 'fs'
import type { NextApiRequest, NextApiResponse } from 'next'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 驾驶舱写入接口的边界：日志必须真正落库，任务参数在入队前就被拒绝，
 * 跨站写入不能靠页面按钮隐藏。使用临时 SQLite，不触碰真实账号与数据。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-api-test-'))
let journalHandler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>
let tasksHandler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>
let dbModule: typeof import('../lib/db')

function mockReq(method: string, options: {
  query?: Record<string, string>
  body?: unknown
  headers?: Record<string, string>
} = {}): NextApiRequest {
  return {
    method,
    query: options.query || {},
    body: options.body,
    headers: options.headers || {},
  } as unknown as NextApiRequest
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

describe('cockpit API', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.COCKPIT_DEMO
    process.env.NEWS_DB_PATH = path.join(dir, 'cockpit-api.db')
    vi.resetModules()
    journalHandler = (await import('../pages/api/cockpit/journal')).default
    tasksHandler = (await import('../pages/api/cockpit/tasks')).default
    dbModule = await import('../lib/db')
    await dbModule.getDb()
  })

  describe('/api/cockpit/journal', () => {
    it('GET 返回空日志并禁止缓存', async () => {
      const res = mockRes()
      await journalHandler(mockReq('GET'), res)
      expect(res._status).toBe(200)
      expect(res._body.data).toEqual([])
      expect(res._headers['Cache-Control']).toContain('no-store')
    })

    it('跨站来源拒绝写入', async () => {
      const res = mockRes()
      await journalHandler(mockReq('POST', {
        headers: { origin: 'https://evil.example', host: 'localhost:3211' },
        body: { action: 'watch', reason: '测试' },
      }), res)
      expect(res._status).toBe(403)
      expect(res._body.error.code).toBe('ORIGIN_MISMATCH')
    })

    it.each([
      [{ action: 'trade', reason: '测试' }, 'INVALID_ACTION'],
      [{ action: 'watch', reason: '   ' }, 'INVALID_REASON'],
      [{ action: 'watch', reason: 'x'.repeat(501) }, 'INVALID_REASON'],
      [{ entryDate: '2026/10/22', action: 'watch', reason: '测试' }, 'INVALID_DATE'],
      [{ action: 'watch', reason: '测试', code: 'x'.repeat(21) }, 'INVALID_CODE'],
    ])('非法输入 %j 返回 400', async (body, code) => {
      const res = mockRes()
      await journalHandler(mockReq('POST', { body }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe(code)
    })

    it('不存在的关联论点不写入', async () => {
      const res = mockRes()
      await journalHandler(mockReq('POST', {
        body: { action: 'watch', reason: '测试', thesisId: 'thesis-missing' },
      }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe('THESIS_NOT_FOUND')
    })

    it('合法记录 201 落库，并且 GET 能读回', async () => {
      const res = mockRes()
      await journalHandler(mockReq('POST', {
        body: {
          entryDate: '2026-10-22',
          action: 'watch',
          reason: '先观察广度能否回到 50% 以上',
          code: '600519.SH',
        },
      }), res)
      expect(res._status).toBe(201)
      expect(res._body.data).toMatchObject({
        entryDate: '2026-10-22',
        action: 'watch',
        code: '600519.SH',
      })

      const listed = mockRes()
      await journalHandler(mockReq('GET', { query: { limit: '10' } }), listed)
      expect(listed._status).toBe(200)
      expect(listed._body.data).toHaveLength(1)
      expect(listed._body.data[0].reason).toBe('先观察广度能否回到 50% 以上')
    })

    it.each([
      ['600519', '600519.SH'],
      ['SH600519', '600519.SH'],
      ['000001', '000001.SZ'],
    ])('代码 %s 写入前归一化为 %s', async (input, expected) => {
      const res = mockRes()
      await journalHandler(mockReq('POST', {
        body: { action: 'watch', reason: '代码归一化测试', code: input },
      }), res)
      expect(res._status).toBe(201)
      expect(res._body.data.code).toBe(expected)
    })

    it('小数 limit 不会把非法 SQL 参数传给 SQLite', async () => {
      const res = mockRes()
      await journalHandler(mockReq('GET', { query: { limit: '2.5' } }), res)
      expect(res._status).toBe(200)
      expect(Array.isArray(res._body.data)).toBe(true)
    })

    it('不支持的方法返回 405 与 Allow', async () => {
      const res = mockRes()
      await journalHandler(mockReq('DELETE'), res)
      expect(res._status).toBe(405)
      expect(res._headers.Allow).toBe('GET, POST')
    })
  })

  describe('/api/cockpit/tasks', () => {
    it('跨站来源拒绝派发', async () => {
      const res = mockRes()
      await tasksHandler(mockReq('POST', {
        headers: { origin: 'https://evil.example', host: 'localhost:3211' },
        body: { type: 'daily_brief', params: {} },
      }), res)
      expect(res._status).toBe(403)
      expect(res._body.error.code).toBe('ORIGIN_MISMATCH')
    })

    it('非法任务类型返回可选类型列表', async () => {
      const res = mockRes()
      await tasksHandler(mockReq('POST', { body: { type: 'trade_now' } }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe('INVALID_TASK_TYPE')
      expect(res._body.error.details.allowed).toContain('daily_brief')
    })

    it.each([
      [{ type: 'daily_brief', params: { tradeDate: '2026/10/22' } }, 'INVALID_DATE'],
      [{ type: 'ask', params: { question: 'x'.repeat(2001) } }, 'INVALID_QUESTION'],
      [{ type: 'ask', params: { question: '   ' } }, 'INVALID_QUESTION'],
      [{ type: 'symbol_deep_dive', params: { code: 'x'.repeat(21) } }, 'INVALID_CODE'],
      [{ type: 'symbol_deep_dive', params: { code: '  ' } }, 'INVALID_CODE'],
      [{ type: 'ask', params: { blob: 'x'.repeat(8300) } }, 'PARAMS_TOO_LARGE'],
    ])('非法参数 %j 在入队前拒绝', async (body, code) => {
      const res = mockRes()
      await tasksHandler(mockReq('POST', { body }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe(code)
    })

    it('GET 列表按接口格式返回', async () => {
      const res = mockRes()
      await tasksHandler(mockReq('GET', { query: { limit: '5' } }), res)
      expect(res._status).toBe(200)
      expect(Array.isArray(res._body.data)).toBe(true)
      expect(res._headers['Cache-Control']).toContain('no-store')
    })
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
