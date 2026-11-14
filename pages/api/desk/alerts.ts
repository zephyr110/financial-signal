import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, ensureSameOrigin, queryString, sendData, sendError } from '../../../lib/cockpit/api'
import { acknowledgeAlert, listAlerts } from '../../../lib/desk/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST'])) return
  try {
    if (req.method === 'GET') {
      const status = queryString(req.query.status)
      if (status && !['open', 'acknowledged', 'expired'].includes(status)) {
        return sendError(req, res, 400, 'INVALID_STATUS', '预警状态无效')
      }
      sendData(res, await listAlerts({ status, limit: Number(queryString(req.query.limit) || 50) }), await buildMeta())
      return
    }

    if (!ensureSameOrigin(req)) {
      return sendError(req, res, 403, 'CROSS_ORIGIN', '拒绝跨站请求')
    }
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    if (typeof body.id !== 'string' || !body.id) {
      return sendError(req, res, 400, 'MISSING_ID', '缺少预警 id')
    }
    const alert = await acknowledgeAlert(body.id, body.status === 'expired' ? 'expired' : 'acknowledged')
    if (!alert) return sendError(req, res, 404, 'ALERT_NOT_FOUND', '预警不存在')
    sendData(res, alert, await buildMeta())
  } catch (err) {
    sendError(req, res, 500, 'ALERTS_FAILED', err instanceof Error ? err.message : '预警操作失败')
  }
}
