import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, ensureSameOrigin, sendError } from '../../../../lib/cockpit/api'
import { todayShanghai } from '../../../../lib/cockpit/format'
import { enqueueTask } from '../../../../lib/cockpit/tasks'
import { bodyObject, isTradeDate, sendPaperData, sendPaperError } from '../../../../lib/paper/api'

/**
 * POST /api/paper/agent/run —— 手动补跑投资经理计划或评估。
 * 只入队不直接调模型：请求快速返回，进度与失败原因留在任务中心。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  try {
    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const body = bodyObject(req.body)
    const action = body.action === 'outcomes' ? 'outcomes' : body.action === 'plan' || body.action === undefined
      ? 'plan'
      : null
    if (!action) return sendError(req, res, 400, 'INVALID_INPUT', 'action 必须是 plan 或 outcomes')
    const tradeDate = body.tradeDate === undefined ? todayShanghai() : body.tradeDate
    if (!isTradeDate(tradeDate)) {
      return sendError(req, res, 400, 'INVALID_INPUT', 'tradeDate 必须是 YYYY-MM-DD')
    }
    const type = action === 'plan' ? 'paper_agent_plan' : 'paper_agent_outcomes'
    const params: Record<string, unknown> = { tradeDate, manual: true }
    if (typeof body.experimentId === 'string' && body.experimentId) {
      params.experimentId = body.experimentId
    }
    // 手动按“日期+动作”幂等；同一天连点不会堆一串相同任务。
    const task = await enqueueTask({
      type,
      params,
      idempotencyKey: `manual:${type}:${tradeDate}:${String(params.experimentId ?? 'current')}`,
    })
    return sendPaperData(res, 202, {
      taskId: task.id,
      type,
      status: task.status,
      tradeDate,
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
