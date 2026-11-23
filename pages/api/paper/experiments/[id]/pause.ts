import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, ensureSameOrigin, sendError } from '../../../../../lib/cockpit/api'
import { bodyObject, sendPaperData, sendPaperError } from '../../../../../lib/paper/api'
import { pausePaperExperiment } from '../../../../../lib/paper/experiment'
import { listPaperAccounts } from '../../../../../lib/paper/repo'

/** POST /api/paper/experiments/:id/pause —— 暂停实验；必须写原因。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  try {
    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    if (!id) return sendError(req, res, 400, 'INVALID_INPUT', '缺少实验 id')
    const body = bodyObject(req.body)
    const reason = typeof body.reason === 'string' ? body.reason : ''
    const experiment = await pausePaperExperiment({ experimentId: id, reason })
    return sendPaperData(res, 200, {
      experiment,
      accounts: await listPaperAccounts(experiment.id),
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
