import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, queryString, sendData, sendError } from '../../../../../lib/cockpit/api'
import { getTask, getTaskEvents } from '../../../../../lib/cockpit/tasks'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const id = queryString(req.query.id)
    if (!id) return sendError(req, res, 400, 'INVALID_ID', '任务 ID 无效')
    const task = await getTask(id)
    if (!task) return sendError(req, res, 404, 'TASK_NOT_FOUND', '任务不存在')
    const events = await getTaskEvents(id)
    return sendData(res, { task, events }, await buildMeta(task.finishedAt || task.startedAt))
  } catch (err) {
    console.error('[cockpit/tasks/id]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'TASK_FAILED', '读取任务失败')
  }
}
