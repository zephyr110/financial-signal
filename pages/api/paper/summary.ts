import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod } from '../../../lib/cockpit/api'
import { sendPaperData, sendPaperError } from '../../../lib/paper/api'
import { buildPaperSummary } from '../../../lib/paper/summary'

/** GET /api/paper/summary —— 总览：今天要不要动、账户、待办、净值、风险与对账。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const summary = await buildPaperSummary()
    return sendPaperData(res, 200, summary)
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
