import path from 'path'
import os from 'os'
import fs from 'fs'
import type { NextApiRequest, NextApiResponse } from 'next'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 每日收盘 cron 的节流边界：收盘前目标是上一工作日、周末顺延、
 * 已发布简报与已成功任务都不重复拉行情；鉴权失败不触发任何写入。
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-cron-test-'))
let handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>
let resolveTarget: (now?: Date) => { tradeDate: string; afterClose: boolean }
let dbModule: typeof import('../lib/db')

function mockReq(method: string, options: {
  query?: Record<string, string>
  headers?: Record<string, string>
} = {}): NextApiRequest {
  return { method, query: options.query || {}, headers: options.headers || {} } as unknown as NextApiRequest
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

describe('每日收盘 cron', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.DESKTOP_MODE
    delete process.env.CRON_SECRET
    process.env.NEWS_DB_PATH = path.join(dir, 'cron.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    await dbModule.getDb()
    const route = await import('../pages/api/cron/cockpit-daily')
    handler = route.default
    resolveTarget = route.resolveCockpitDailyTarget
  })

  it('收盘前目标为上一工作日，16:10 起切到当天，周末顺延到周五', () => {
    expect(resolveTarget(new Date('2026-10-22T07:00:00Z'))).toEqual({
      tradeDate: '2026-10-21',
      afterClose: false,
    })
    expect(resolveTarget(new Date('2026-10-22T08:09:00Z'))).toEqual({
      tradeDate: '2026-10-21',
      afterClose: false,
    })
    expect(resolveTarget(new Date('2026-10-22T08:10:00Z'))).toEqual({
      tradeDate: '2026-10-22',
      afterClose: true,
    })
    expect(resolveTarget(new Date('2026-10-24T02:00:00Z'))).toEqual({
      tradeDate: '2026-10-23',
      afterClose: false,
    })
    expect(resolveTarget(new Date('2026-10-26T01:00:00Z'))).toEqual({
      tradeDate: '2026-10-23',
      afterClose: false,
    })
  })

  it('已发布当天简报时直接跳过，不创建任务', async () => {
    const target = resolveTarget().tradeDate
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO reports
            (kind, subject_code, trade_date, version, status, payload_json, is_demo, created_at, published_at)
            VALUES ('daily_brief', '', ?, 1, 'published', '{}', 0, ?, ?)`,
      args: [target, new Date().toISOString(), new Date().toISOString()],
    })

    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(200)
    expect(res._body).toMatchObject({ ok: true, skipped: 'already_built', tradeDate: target })

    const tasks = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM tasks', args: [] })
    expect(Number(tasks.rows[0]?.n)).toBe(0)
    await db.execute({ sql: 'DELETE FROM reports', args: [] })
  })

  it('当天任务已经成功过时跳过，节假日不会重复拉行情', async () => {
    const target = resolveTarget().tradeDate
    const db = await dbModule.getDb()
    await db.execute({
      sql: `INSERT INTO tasks
            (id, type, params_json, status, progress, step, idempotency_key, attempts,
             model, cost_micros, created_at, started_at, finished_at, heartbeat_at)
            VALUES ('cron-existing', 'daily_close', '{}', 'succeeded', 100, '完成', ?, 1,
                    'deterministic', 0, ?, ?, ?, ?)`,
      args: [
        `cockpit-daily:${target}`,
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
        new Date().toISOString(),
      ],
    })

    const res = mockRes()
    await handler(mockReq('GET'), res)
    expect(res._status).toBe(200)
    expect(res._body).toMatchObject({ ok: true, skipped: 'task_exists' })
    expect(res._body.task.status).toBe('succeeded')
    await db.execute({ sql: "DELETE FROM tasks WHERE id = 'cron-existing'", args: [] })
  })

  it('非法日期与不支持的方法被拒绝', async () => {
    const badDate = mockRes()
    await handler(mockReq('GET', { query: { tradeDate: '2026/10/22' } }), badDate)
    expect(badDate._status).toBe(400)

    const badMethod = mockRes()
    await handler(mockReq('POST'), badMethod)
    expect(badMethod._status).toBe(405)
    expect(badMethod._headers.Allow).toBe('GET')
  })

  it('配置 CRON_SECRET 后无令牌 401，带 Bearer 才放行', async () => {
    process.env.CRON_SECRET = 's3cret'
    try {
      const denied = mockRes()
      await handler(mockReq('GET'), denied)
      expect(denied._status).toBe(401)

      const target = resolveTarget().tradeDate
      const db = await dbModule.getDb()
      await db.execute({
        sql: `INSERT INTO reports
              (kind, subject_code, trade_date, version, status, payload_json, is_demo, created_at, published_at)
              VALUES ('daily_brief', '', ?, 1, 'published', '{}', 0, ?, ?)`,
        args: [target, new Date().toISOString(), new Date().toISOString()],
      })
      const allowed = mockRes()
      await handler(mockReq('GET', { headers: { authorization: 'Bearer s3cret' } }), allowed)
      expect(allowed._status).toBe(200)
      expect(allowed._body.skipped).toBe('already_built')
      await db.execute({ sql: 'DELETE FROM reports', args: [] })
    } finally {
      delete process.env.CRON_SECRET
    }
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
