import type { NextApiRequest, NextApiResponse } from 'next'
import {
  buildMeta,
  ensureMethod,
  ensureSameOrigin,
  queryString,
  sendData,
  sendError,
} from '../../../lib/cockpit/api'
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../../../lib/cockpit/notifications'

function bodyObject(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try { return JSON.parse(body) as Record<string, unknown> } catch { return {} }
  }
  return body && typeof body === 'object' ? body as Record<string, unknown> : {}
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST'])) return
  try {
    if (req.method === 'GET') {
      const limit = Number(queryString(req.query.limit) || 20)
      return sendData(res, await listNotifications(Number.isFinite(limit) ? limit : 20), await buildMeta())
    }

    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const body = bodyObject(req.body)
    if (body.all === true) {
      await markAllNotificationsRead()
      return sendData(res, await listNotifications(20), await buildMeta())
    }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id || id.length > 120) {
      return sendError(req, res, 400, 'INVALID_ID', '通知 ID 无效')
    }
    await markNotificationRead(id)
    return sendData(res, await listNotifications(20), await buildMeta())
  } catch (err) {
    console.error('[cockpit/notifications]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'NOTIFICATIONS_FAILED', '读写通知失败')
  }
}
