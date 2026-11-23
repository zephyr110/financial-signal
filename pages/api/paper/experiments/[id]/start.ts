import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, ensureSameOrigin, sendError } from '../../../../../lib/cockpit/api'
import { sendPaperData, sendPaperError } from '../../../../../lib/paper/api'
import { startPaperExperiment } from '../../../../../lib/paper/experiment'
import { listPaperAccounts } from '../../../../../lib/paper/repo'

/** POST /api/paper/experiments/:id/start —— 开始 planned 实验或恢复 paused 实验。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  try {
    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    if (!id) return sendError(req, res, 400, 'INVALID_INPUT', '缺少实验 id')
    const experiment = await startPaperExperiment({ experimentId: id })
    return sendPaperData(res, 200, {
      experiment,
      accounts: await listPaperAccounts(experiment.id),
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
