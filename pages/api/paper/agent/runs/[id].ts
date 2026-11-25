import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, sendError } from '../../../../../lib/cockpit/api'
import { sendPaperData, sendPaperError } from '../../../../../lib/paper/api'
import { getPaperAgentRunDetail } from '../../../../../lib/paper/agent-stats'

/** GET /api/paper/agent/runs/:id —— 单次运行的完整审计：输入、模型尝试、决策、事件与成交。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(id)) {
      return sendError(req, res, 400, 'INVALID_INPUT', '运行 id 非法')
    }
    const detail = await getPaperAgentRunDetail(id)
    if (!detail) return sendError(req, res, 404, 'NOT_FOUND', '运行记录不存在')
    return sendPaperData(res, 200, detail)
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
