import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, ensureSameOrigin, sendData, sendError } from '../../../lib/cockpit/api'
import { enqueueTask, scheduleTaskDrain } from '../../../lib/cockpit/tasks'
import { getDeskStatus } from '../../../lib/desk/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  if (!ensureSameOrigin(req)) {
    return sendError(req, res, 403, 'CROSS_ORIGIN', '拒绝跨站请求')
  }
  try {
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    const params: Record<string, unknown> = {}
    if (typeof body.tradeDate === 'string' && body.tradeDate) params.tradeDate = body.tradeDate
    // 手动刷新默认强制新任务；同一时间已在排队/运行的任务仍复用。
    if (body.force !== false) params.force = true
    const task = await enqueueTask({ type: 'desk_tick', params })
    if (task.status === 'queued') scheduleTaskDrain()
    sendData(res, { task, status: await getDeskStatus() }, await buildMeta())
  } catch (err) {
    sendError(req, res, 400, 'DESK_REFRESH_FAILED', err instanceof Error ? err.message : '投研台刷新入队失败')
  }
}
