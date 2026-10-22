import type { NextApiRequest, NextApiResponse } from 'next'
import {
  buildMeta,
  ensureMethod,
  ensureSameOrigin,
  queryString,
  sendData,
  sendError,
} from '../../../../lib/cockpit/api'
import { enqueueTask, listTasks, processNextTask, TASK_TYPES } from '../../../../lib/cockpit/tasks'
import type { TaskType } from '../../../../lib/cockpit/types'

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
      const limit = Number(queryString(req.query.limit) || 50)
      return sendData(res, await listTasks(Number.isFinite(limit) ? limit : 50), await buildMeta())
    }

    if (!ensureSameOrigin(req)) {
      return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站任务写入')
    }
    const body = bodyObject(req.body)
    const type = typeof body.type === 'string' ? body.type : ''
    if (!TASK_TYPES.includes(type as TaskType)) {
      return sendError(req, res, 400, 'INVALID_TASK_TYPE', '任务类型无效', { allowed: TASK_TYPES })
    }
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? body.params as Record<string, unknown>
      : {}
    if (JSON.stringify(params).length > 8192) {
      return sendError(req, res, 400, 'PARAMS_TOO_LARGE', '任务参数超过 8KB')
    }
    if (params.tradeDate !== undefined && (typeof params.tradeDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(params.tradeDate))) {
      return sendError(req, res, 400, 'INVALID_DATE', 'tradeDate 格式应为 YYYY-MM-DD')
    }
    if (params.question !== undefined && (typeof params.question !== 'string' || params.question.length > 2000)) {
      return sendError(req, res, 400, 'INVALID_QUESTION', '问题需为 1–2000 字')
    }
    if (params.code !== undefined && (typeof params.code !== 'string' || params.code.length > 20)) {
      return sendError(req, res, 400, 'INVALID_CODE', '股票代码无效')
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim().slice(0, 128)
      : undefined

    const task = await enqueueTask({ type: type as TaskType, params, idempotencyKey })
    if (task.status === 'queued') {
      setTimeout(() => {
        void processNextTask().catch((err) => {
          console.error('[cockpit/tasks] worker', err instanceof Error ? err.message : err)
        })
      }, 10)
    }
    const meta = await buildMeta()
    res.setHeader('Cache-Control', 'no-store, max-age=0')
    return res.status(202).json({ data: task, meta })
  } catch (err) {
    console.error('[cockpit/tasks]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'TASK_FAILED', '任务操作失败')
  }
}
