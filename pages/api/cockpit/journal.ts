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
import { ensureCockpitDemoSeed } from '../../../lib/cockpit/demo'
import { getJournal } from '../../../lib/cockpit/repo'
import type { JournalEntry } from '../../../lib/cockpit/types'

const ACTIONS = ['watch', 'buy', 'sell', 'hold', 'avoid', 'review']

function todayShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
}

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try { return JSON.parse(body) as Record<string, unknown> } catch { return {} }
  }
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()

    if (req.method === 'GET') {
      const limit = Number(queryString(req.query.limit) || 20)
      return sendData(res, await getJournal(Number.isFinite(limit) ? limit : 20), await buildMeta())
    }

    if (!ensureSameOrigin(req)) {
      return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    }
    const body = bodyObject(req.body)
    const entryDate = typeof body.entryDate === 'string' ? body.entryDate : todayShanghai()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      return sendError(req, res, 400, 'INVALID_DATE', '记录日期格式应为 YYYY-MM-DD')
    }
    const action = typeof body.action === 'string' ? body.action : ''
    if (!ACTIONS.includes(action)) {
      return sendError(req, res, 400, 'INVALID_ACTION', '决定类型无效')
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason || reason.length > 500) {
      return sendError(req, res, 400, 'INVALID_REASON', '理由需为 1–500 字')
    }
    const code = typeof body.code === 'string' && body.code.trim() ? body.code.trim() : null
    if (code && code.length > 20) {
      return sendError(req, res, 400, 'INVALID_CODE', '股票代码过长')
    }
    const thesisId = typeof body.thesisId === 'string' && body.thesisId.trim() ? body.thesisId.trim() : null
    const outcomeNote = typeof body.outcomeNote === 'string' ? body.outcomeNote.trim().slice(0, 500) : null

    const db = await getDb()
    if (thesisId) {
      const thesis = await db.execute({ sql: 'SELECT id FROM theses WHERE id = ?', args: [thesisId] })
      if (!thesis.rows[0]) return sendError(req, res, 400, 'THESIS_NOT_FOUND', '关联论点不存在')
    }
    const now = new Date().toISOString()
    const inserted = await db.execute({
      sql: `INSERT INTO journal_entries
        (entry_date, code, action, thesis_id, reason, outcome_note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [entryDate, code, action, thesisId, reason, outcomeNote, now],
    })
    const entry: JournalEntry = {
      id: Number(inserted.lastInsertRowid),
      entryDate,
      code: code || undefined,
      action,
      reason,
      outcomeNote: outcomeNote || undefined,
      createdAt: now,
    }
    noStore(res)
    return res.status(201).json({ data: entry, meta: await buildMeta() })
  } catch (err) {
    console.error('[cockpit/journal]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'JOURNAL_FAILED', '读写研究日志失败')
  }
}
