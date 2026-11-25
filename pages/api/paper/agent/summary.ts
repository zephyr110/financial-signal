import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod } from '../../../../lib/cockpit/api'
import { sendPaperData, sendPaperError } from '../../../../lib/paper/api'
import { buildPaperAgentDashboard } from '../../../../lib/paper/agent-stats'

/** GET /api/paper/agent/summary —— 投资经理战绩：正确率、校准、运行记录与近期决策。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const experimentId = typeof req.query.experimentId === 'string' ? req.query.experimentId : null
    const dashboard = await buildPaperAgentDashboard({ experimentId })
    return sendPaperData(res, 200, dashboard)
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
