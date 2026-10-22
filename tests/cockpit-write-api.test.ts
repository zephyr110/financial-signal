import path from 'path'
import os from 'os'
import fs from 'fs'
import type { NextApiRequest, NextApiResponse } from 'next'
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

/**
 * 自选/持仓/论点的写入边界：代码规范化、整数股数与分、示例只读、
 * 跨站拒绝，以及通知的去重与已读。全部使用临时 SQLite。
 */

vi.mock('../lib/auth', () => ({
  getSessionUser: vi.fn(async () => 'tester'),
  SESSION_COOKIE: 'session',
}))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-write-api-test-'))

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>
let watchlistHandler: Handler
let portfolioHandler: Handler
let thesesHandler: Handler
let notificationsHandler: Handler
let settingsHandler: Handler
let notifications: typeof import('../lib/cockpit/notifications')
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

describe('驾驶舱写入接口', () => {
  beforeAll(async () => {
    delete process.env.TURSO_DATABASE_URL
    delete process.env.TURSO_AUTH_TOKEN
    delete process.env.COCKPIT_DEMO
    process.env.NEWS_DB_PATH = path.join(dir, 'write-api.db')
    vi.resetModules()
    dbModule = await import('../lib/db')
    await dbModule.getDb()
    watchlistHandler = (await import('../pages/api/cockpit/watchlist')).default
    portfolioHandler = (await import('../pages/api/cockpit/portfolio')).default
    thesesHandler = (await import('../pages/api/cockpit/theses')).default
    notificationsHandler = (await import('../pages/api/cockpit/notifications')).default
    settingsHandler = (await import('../pages/api/settings')).default
    notifications = await import('../lib/cockpit/notifications')
  })

  describe('自选', () => {
    it('六位代码自动补交易所并允许更新备注', async () => {
      const created = mockRes()
      await watchlistHandler(mockReq('POST', { body: { code: '600519', note: '关注批价' } }), created)
      expect(created._status).toBe(201)
      expect(created._body.data).toEqual([
        expect.objectContaining({ code: '600519.SH', note: '关注批价' }),
      ])

      const updated = mockRes()
      await watchlistHandler(mockReq('POST', { body: { code: 'SH600519', note: '再看一周' } }), updated)
      expect(updated._status).toBe(201)
      expect(updated._body.data).toHaveLength(1)
      expect(updated._body.data[0]).toMatchObject({ code: '600519.SH', note: '再看一周' })
    })

    it('未携带 note 时保留旧备注，显式空串才清空', async () => {
      const kept = mockRes()
      await watchlistHandler(mockReq('POST', { body: { code: '600519' } }), kept)
      expect(kept._body.data[0]).toMatchObject({ code: '600519.SH', note: '再看一周' })

      const cleared = mockRes()
      await watchlistHandler(mockReq('POST', { body: { code: '600519', note: '' } }), cleared)
      expect(cleared._body.data[0].note == null).toBe(true)
    })

    it.each([
      [{ code: '60051' }, 'INVALID_CODE'],
      [{ code: '600519', note: 'x'.repeat(201) }, 'INVALID_NOTE'],
      [{ code: '600519', note: 123 }, 'INVALID_NOTE'],
    ])('非法输入 %j 返回 400', async (body, code) => {
      const res = mockRes()
      await watchlistHandler(mockReq('POST', { body }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe(code)
    })

    it('跨站写入被拒绝；DELETE 只删除指定自选', async () => {
      const blocked = mockRes()
      await watchlistHandler(mockReq('POST', {
        headers: { origin: 'https://evil.example', host: 'localhost:3000' },
        body: { code: '300750' },
      }), blocked)
      expect(blocked._status).toBe(403)

      const removed = mockRes()
      await watchlistHandler(mockReq('DELETE', { query: { code: '600519.SH' } }), removed)
      expect(removed._status).toBe(200)
      expect(removed._body.data).toEqual([])
    })
  })

  describe('持仓', () => {
    it('真实持仓写入非示例账户，股数与成本按整数校验', async () => {
      const created = mockRes()
      await portfolioHandler(mockReq('POST', {
        body: { code: '600519', shares: 100, avgCostCents: 150_000 },
      }), created)
      expect(created._status).toBe(201)
      expect(created._body.data.positions[0]).toMatchObject({ code: '600519.SH', shares: 100 })

      const db = await dbModule.getDb()
      const row = await db.execute({
        sql: 'SELECT account_id FROM positions WHERE code = ?',
        args: ['600519.SH'],
      })
      expect(row.rows[0]?.account_id).toBe('main-account')
    })

    it.each([
      [{ code: '600519', shares: 1.5, avgCostCents: 100 }, 'INVALID_SHARES'],
      [{ code: '600519', shares: 0, avgCostCents: 100 }, 'INVALID_SHARES'],
      [{ code: '600519', shares: 100, avgCostCents: -1 }, 'INVALID_COST'],
      [{ code: '600519', shares: 100, avgCostCents: 1.5 }, 'INVALID_COST'],
      [{ code: '600519', shares: null, avgCostCents: 100 }, 'INVALID_SHARES'],
      [{ code: '600519', shares: '', avgCostCents: 100 }, 'INVALID_SHARES'],
      [{ code: '600519', shares: 100, avgCostCents: null }, 'INVALID_COST'],
      [{ code: '600519', shares: 100, avgCostCents: '' }, 'INVALID_COST'],
      [{ code: '600519', shares: 100, avgCostCents: true }, 'INVALID_COST'],
      [{ shares: 100, avgCostCents: 100 }, 'INVALID_CODE'],
    ])('非法输入 %j 返回 400', async (body, code) => {
      const res = mockRes()
      await portfolioHandler(mockReq('POST', { body }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe(code)
    })

    it('示例账户里的持仓不会被真实写入覆盖', async () => {
      const db = await dbModule.getDb()
      const now = new Date().toISOString()
      await db.execute({
        sql: `INSERT OR IGNORE INTO portfolio_accounts (id, name, currency, created_at)
              VALUES ('demo-account', '示例账户', 'CNY', ?)`,
        args: [now],
      })
      await db.execute({
        sql: `INSERT OR IGNORE INTO positions (account_id, code, shares, avg_cost_cents, updated_at)
              VALUES ('demo-account', '300750.SZ', 10, 1000, ?)`,
        args: [now],
      })

      const res = mockRes()
      await portfolioHandler(mockReq('POST', {
        body: { code: '300750', shares: 200, avgCostCents: 5000 },
      }), res)
      expect(res._status).toBe(201)

      const demo = await db.execute({
        sql: "SELECT shares FROM positions WHERE account_id = 'demo-account' AND code = '300750.SZ'",
        args: [],
      })
      expect(Number(demo.rows[0]?.shares)).toBe(10)
    })

    it('DELETE 能找到仅存在于示例账户的持仓', async () => {
      const db = await dbModule.getDb()
      await db.execute({
        sql: `INSERT INTO positions (account_id, code, shares, avg_cost_cents, updated_at)
              VALUES ('demo-account', '000999.SZ', 10, 1000, ?)`,
        args: [new Date().toISOString()],
      })
      const res = mockRes()
      await portfolioHandler(mockReq('DELETE', { query: { code: '000999.SZ' } }), res)
      expect(res._status).toBe(200)
      const row = await db.execute({
        sql: "SELECT COUNT(*) AS n FROM positions WHERE account_id = 'demo-account' AND code = '000999.SZ'",
        args: [],
      })
      expect(Number(row.rows[0]?.n)).toBe(0)
    })

    it('DELETE 只移除当前账户的持仓', async () => {
      const res = mockRes()
      await portfolioHandler(mockReq('DELETE', { query: { code: '600519.SH' } }), res)
      expect(res._status).toBe(200)
      expect(res._body.data.positions.some((item: { code: string }) => item.code === '600519.SH')).toBe(false)
    })
  })

  describe('论点', () => {
    const validBody = {
      code: '600519',
      title: '高端白酒需求韧性',
      claim: '批价与渠道库存会先于报表反映压力。',
      horizon: '6-12 个月',
      status: 'active',
      confidence: '中',
      invalidation: ['批价连续四周走弱'],
    }

    it('新建后可修订，示例论点只读', async () => {
      const created = mockRes()
      await thesesHandler(mockReq('POST', { body: validBody }), created)
      expect(created._status).toBe(201)
      const thesis = created._body.data.find((item: { title: string }) => item.title === validBody.title)
      expect(thesis).toMatchObject({ code: '600519.SH', status: 'active' })

      const updated = mockRes()
      await thesesHandler(mockReq('POST', {
        body: { ...validBody, id: thesis.id, status: 'weakened', confidence: '低' },
      }), updated)
      expect(updated._status).toBe(200)
      expect(updated._body.data.find((item: { id: string }) => item.id === thesis.id)).toMatchObject({
        status: 'weakened',
        confidence: '低',
      })

      const db = await dbModule.getDb()
      const now = new Date().toISOString()
      await db.execute({
        sql: `INSERT INTO theses
              (id, code, title, claim, horizon, status, confidence, invalidation_json,
               created_at, updated_at, last_reviewed_at)
              VALUES ('thesis-demo-test', '600519.SH', '示例论点', '只读', '1 个月', 'active', '中', '[]', ?, ?, NULL)`,
        args: [now, now],
      })
      const blockedDelete = mockRes()
      await thesesHandler(mockReq('DELETE', { query: { id: 'thesis-demo-test' } }), blockedDelete)
      expect(blockedDelete._status).toBe(409)
      expect(blockedDelete._body.error.code).toBe('DEMO_READONLY')

      const blockedUpdate = mockRes()
      await thesesHandler(mockReq('POST', { body: { ...validBody, id: 'thesis-demo-test' } }), blockedUpdate)
      expect(blockedUpdate._status).toBe(409)
      await db.execute({ sql: "DELETE FROM theses WHERE id = 'thesis-demo-test'", args: [] })
    })

    it.each([
      [{ ...validBody, code: 'abc' }, 'INVALID_CODE'],
      [{ ...validBody, horizon: '' }, 'INVALID_HORIZON'],
      [{ ...validBody, status: 'strong' }, 'INVALID_STATUS'],
      [{ ...validBody, confidence: '很高' }, 'INVALID_CONFIDENCE'],
      [{ ...validBody, invalidation: [] }, 'INVALID_INVALIDATION'],
      [{ ...validBody, invalidation: 'not-array' }, 'INVALID_INVALIDATION'],
      [{ ...validBody, title: 'x'.repeat(81) }, 'THESIS_VALIDATION'],
    ])('非法输入 %j 返回 400', async (body, code) => {
      const res = mockRes()
      await thesesHandler(mockReq('POST', { body }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe(code)
    })

    it('主张超过 300 字时返回字段级原因', async () => {
      const res = mockRes()
      await thesesHandler(mockReq('POST', {
        body: { ...validBody, claim: 'x'.repeat(301) },
      }), res)
      expect(res._status).toBe(400)
      expect(res._body.error.code).toBe('THESIS_VALIDATION')
      expect(res._body.error.details.issues[0].message).toContain('300')
    })

    it('跨站修订被拒绝', async () => {
      const res = mockRes()
      await thesesHandler(mockReq('POST', {
        headers: { origin: 'https://evil.example', host: 'localhost:3000' },
        body: validBody,
      }), res)
      expect(res._status).toBe(403)
    })
  })

  describe('通知', () => {
    it('相同 id 去重，未读数与已读状态可查询', async () => {
      const first = await notifications.createNotification({
        id: 'notice-1',
        kind: 'task_succeeded',
        title: '收盘简报已生成',
        deepLink: '/today',
      })
      const again = await notifications.createNotification({
        id: 'notice-1',
        kind: 'task_succeeded',
        title: '重复写入',
      })
      expect(again.title).toBe(first.title)

      const listed = await notifications.listNotifications()
      expect(listed.items).toHaveLength(1)
      expect(listed.unread).toBe(1)

      expect(await notifications.markNotificationRead('notice-1')).toBe(true)
      expect(await notifications.markNotificationRead('notice-1')).toBe(false)
      expect((await notifications.listNotifications()).unread).toBe(0)
    })

    it('API 返回列表并支持全部已读；跨站与非法 id 被拒绝', async () => {
      await notifications.createNotification({ title: '行情入库完成', kind: 'task_succeeded' })

      const listed = mockRes()
      await notificationsHandler(mockReq('GET', { query: { limit: '10' } }), listed)
      expect(listed._status).toBe(200)
      expect(listed._body.data.items.length).toBeGreaterThan(0)

      const blocked = mockRes()
      await notificationsHandler(mockReq('POST', {
        headers: { origin: 'https://evil.example', host: 'localhost:3000' },
        body: { all: true },
      }), blocked)
      expect(blocked._status).toBe(403)

      const invalid = mockRes()
      await notificationsHandler(mockReq('POST', { body: { id: 'x'.repeat(121) } }), invalid)
      expect(invalid._status).toBe(400)

      const allRead = mockRes()
      await notificationsHandler(mockReq('POST', { body: { all: true } }), allRead)
      expect(allRead._status).toBe(200)
      expect(allRead._body.data.unread).toBe(0)
    })
  })

  describe('设置', () => {
    it('Tushare token 只回传是否已设置，写入后热生效并可清除', async () => {
      const saved = mockRes()
      await settingsHandler(mockReq('POST', { body: { tushareToken: 'tk-secret' } }), saved)
      expect(saved._status).toBe(200)

      const masked = mockRes()
      await settingsHandler(mockReq('GET'), masked)
      expect(masked._status).toBe(200)
      expect(masked._body.tushare).toEqual({ tokenSet: true })
      expect(JSON.stringify(masked._body)).not.toContain('tk-secret')

      const cleared = mockRes()
      await settingsHandler(mockReq('POST', { body: { tushareToken: '' } }), cleared)
      expect(cleared._status).toBe(200)

      const after = mockRes()
      await settingsHandler(mockReq('GET'), after)
      expect(after._body.tushare).toEqual({ tokenSet: false })
    })
  })

  afterAll(async () => {
    const db = await dbModule.getDb()
    await db.close?.()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
