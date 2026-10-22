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
import { getWatchlist } from '../../../lib/cockpit/repo'

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try { return JSON.parse(body) as Record<string, unknown> } catch { return {} }
  }
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST', 'DELETE'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()

    if (req.method === 'GET') {
      return sendData(res, await getWatchlist(), await buildMeta())
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
      await db.execute({ sql: 'DELETE FROM watchlist_items WHERE code = ?', args: [code] })
      noStore(res)
      return res.status(200).json({ data: await getWatchlist(), meta: await buildMeta() })
    }

    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (note.length > 200) {
      return sendError(req, res, 400, 'INVALID_NOTE', '备注最多 200 字')
    }
    await db.execute({
      sql: `INSERT INTO watchlist_items (code, note, created_at) VALUES (?, ?, ?)
            ON CONFLICT(code) DO UPDATE SET note = excluded.note`,
      args: [code, note || null, new Date().toISOString()],
    })
    noStore(res)
    return res.status(201).json({ data: await getWatchlist(), meta: await buildMeta() })
  } catch (err) {
    console.error('[cockpit/watchlist]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'WATCHLIST_FAILED', '读写自选失败')
  }
}
