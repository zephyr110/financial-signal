import crypto from 'crypto'
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
import { getTheses } from '../../../lib/cockpit/repo'
import { validateThesis } from '../../../lib/cockpit/validators'

const STATUSES = ['active', 'strengthened', 'weakened', 'broken', 'review_due']
const CONFIDENCE = ['低', '中', '高']
const DEMO_ID = 'thesis-demo-'

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
      return sendData(res, await getTheses(), await buildMeta())
    }

    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const body = req.method === 'POST' ? bodyObject(req.body) : {}
    const db = await getDb()

    if (req.method === 'DELETE') {
      const id = queryString(req.query.id) || ''
      if (!id || id.length > 80) return sendError(req, res, 400, 'INVALID_ID', '论点 ID 无效')
      if (id.startsWith(DEMO_ID)) {
        return sendError(req, res, 409, 'DEMO_READONLY', '示例论点只读；请新建自己的论点')
      }
      await db.execute({ sql: 'DELETE FROM thesis_evidence WHERE thesis_id = ?', args: [id] })
      await db.execute({ sql: 'DELETE FROM theses WHERE id = ?', args: [id] })
      noStore(res)
      return res.status(200).json({ data: await getTheses(), meta: await buildMeta() })
    }

    const code = normalizeCode(body.code)
    if (!code) return sendError(req, res, 400, 'INVALID_CODE', '股票代码无效')
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    const claim = typeof body.claim === 'string' ? body.claim.trim() : ''
    const horizon = typeof body.horizon === 'string' ? body.horizon.trim() : ''
    if (!horizon || horizon.length > 40) {
      return sendError(req, res, 400, 'INVALID_HORIZON', '时间范围需为 1–40 字')
    }
    const status = typeof body.status === 'string' ? body.status : 'active'
    if (!STATUSES.includes(status)) {
      return sendError(req, res, 400, 'INVALID_STATUS', '论点状态无效')
    }
    const confidence = typeof body.confidence === 'string' ? body.confidence : '中'
    if (!CONFIDENCE.includes(confidence)) {
      return sendError(req, res, 400, 'INVALID_CONFIDENCE', '置信度应为低、中或高')
    }
    if (!Array.isArray(body.invalidation)) {
      return sendError(req, res, 400, 'INVALID_INVALIDATION', '论点必须包含失效条件数组')
    }
    const invalidation = body.invalidation
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
    if (invalidation.length === 0 || invalidation.length > 10 || invalidation.some((line) => line.length > 160)) {
      return sendError(req, res, 400, 'INVALID_INVALIDATION', '失效条件需为 1–10 条，每条不超过 160 字')
    }
    const validation = validateThesis({ title, claim, invalidation })
    if (!validation.ok) {
      return sendError(req, res, 400, 'THESIS_VALIDATION', '论点内容未通过校验', {
        issues: validation.issues.filter((issue) => issue.severity === 'fail'),
      })
    }

    const requestedId = typeof body.id === 'string' ? body.id.trim() : ''
    if (requestedId.length > 80) return sendError(req, res, 400, 'INVALID_ID', '论点 ID 无效')
    if (requestedId.startsWith(DEMO_ID)) {
      return sendError(req, res, 409, 'DEMO_READONLY', '示例论点只读；请新建自己的论点')
    }
    const now = new Date().toISOString()
    let id = requestedId
    if (id) {
      const existing = await db.execute({ sql: 'SELECT id FROM theses WHERE id = ?', args: [id] })
      if (!existing.rows[0]) return sendError(req, res, 404, 'THESIS_NOT_FOUND', '论点不存在')
      await db.execute({
        sql: `UPDATE theses SET code = ?, title = ?, claim = ?, horizon = ?, status = ?,
              confidence = ?, invalidation_json = ?, updated_at = ? WHERE id = ?`,
        args: [code, title, claim, horizon, status, confidence, JSON.stringify(invalidation), now, id],
      })
    } else {
      id = crypto.randomUUID()
      await db.execute({
        sql: `INSERT INTO theses
              (id, code, title, claim, horizon, status, confidence, invalidation_json,
               created_at, updated_at, last_reviewed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        args: [id, code, title, claim, horizon, status, confidence, JSON.stringify(invalidation), now, now],
      })
    }
    noStore(res)
    return res.status(requestedId ? 200 : 201).json({ data: await getTheses(), meta: await buildMeta() })
  } catch (err) {
    console.error('[cockpit/theses]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'THESES_FAILED', '读写论点失败')
  }
}
