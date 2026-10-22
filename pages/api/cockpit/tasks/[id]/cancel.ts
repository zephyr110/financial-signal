import type { NextApiRequest, NextApiResponse } from 'next'
import {
  buildMeta,
  ensureMethod,
  ensureSameOrigin,
  queryString,
  sendData,
  sendError,
} from '../../../../../lib/cockpit/api'
import { cancelTask, getTask } from '../../../../../lib/cockpit/tasks'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
  try {
    const id = queryString(req.query.id)
    if (!id) return sendError(req, res, 400, 'INVALID_ID', '任务 ID 无效')
    const before = await getTask(id)
    if (!before) return sendError(req, res, 404, 'TASK_NOT_FOUND', '任务不存在')
    if (before.status === 'running') {
      return sendError(req, res, 409, 'TASK_RUNNING', '任务已开始执行，暂不支持中断')
    }
    const task = await cancelTask(id)
    return sendData(res, task, await buildMeta())
  } catch (err) {
    console.error('[cockpit/tasks/cancel]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'TASK_FAILED', '取消任务失败')
  }
}
