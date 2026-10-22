import type { NextApiRequest, NextApiResponse } from 'next'
import { getDb } from '../../../lib/db'
import {
  buildMeta,
  ensureMethod,
  ensureSameOrigin,
  noStore,
  queryString,
  sendData,
  sendError,
} from '../../../lib/cockpit/api'
import { normalizeCode } from '../../../lib/cockpit/codes'
import { ensureCockpitDemoSeed } from '../../../lib/cockpit/demo'
import { getPortfolio } from '../../../lib/cockpit/repo'

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try { return JSON.parse(body) as Record<string, unknown> } catch { return {} }
  }
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

function integerValue(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim())
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

/** 真实持仓永远落在非示例账户；示例账户仅作为空库演示沙箱。 */
async function resolveAccount(): Promise<string> {
  const db = await getDb()
  const existing = await db.execute({
    sql: `SELECT id FROM portfolio_accounts WHERE id <> 'demo-account' ORDER BY created_at LIMIT 1`,
    args: [],
  })
  if (existing.rows[0]) return String(existing.rows[0].id)
  const now = new Date().toISOString()
  await db.execute({
    sql: `INSERT OR IGNORE INTO portfolio_accounts (id, name, currency, created_at)
          VALUES ('main-account', '我的账户', 'CNY', ?)`,
    args: [now],
  })
  return 'main-account'
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST', 'DELETE'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()

    if (req.method === 'GET') {
      return sendData(res, await getPortfolio(), await buildMeta())
    }

    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const body = req.method === 'POST' ? bodyObject(req.body) : {}
    const raw = req.method === 'DELETE' ? queryString(req.query.code) : body.code
    const code = normalizeCode(raw)
    if (!code) {
      return sendError(req, res, 400, 'INVALID_CODE', '股票代码应为 600519、600519.SH 或 SH600519')
    }
    const db = await getDb()

    if (req.method === 'DELETE') {
      // DELETE 不创建账户：先找该代码现有持仓所属账户，示例账户兜底。
      const owner = await db.execute({
        sql: `SELECT account_id FROM positions WHERE code = ?
              ORDER BY CASE WHEN account_id = 'demo-account' THEN 1 ELSE 0 END LIMIT 1`,
        args: [code],
      })
      const accountId = owner.rows[0] ? String(owner.rows[0].account_id) : null
      if (accountId) {
        await db.execute({
          sql: 'DELETE FROM positions WHERE account_id = ? AND code = ?',
          args: [accountId, code],
        })
      }
      noStore(res)
      return res.status(200).json({ data: await getPortfolio(), meta: await buildMeta() })
    }

    const accountId = await resolveAccount()
    const shares = integerValue(body.shares)
    if (shares === null || shares <= 0 || shares > 1_000_000_000) {
      return sendError(req, res, 400, 'INVALID_SHARES', '股数需为 1–1,000,000,000 的整数')
    }
    const cents = integerValue(body.avgCostCents)
    if (cents === null || cents < 0 || cents > 100_000_000_000) {
      return sendError(req, res, 400, 'INVALID_COST', '成本价需以整数分表示，且不超过 10 亿元')
    }
    const now = new Date().toISOString()
    await db.execute({
      sql: `INSERT INTO positions (account_id, code, shares, avg_cost_cents, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(account_id, code) DO UPDATE SET
              shares = excluded.shares,
              avg_cost_cents = excluded.avg_cost_cents,
              closed_at = NULL,
              updated_at = excluded.updated_at`,
      args: [accountId, code, shares, cents, now],
    })
    noStore(res)
    return res.status(201).json({ data: await getPortfolio(), meta: await buildMeta() })
  } catch (err) {
    console.error('[cockpit/portfolio]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'PORTFOLIO_FAILED', '读写持仓失败')
  }
}
