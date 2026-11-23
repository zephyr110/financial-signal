import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, ensureSameOrigin, sendError } from '../../../../../lib/cockpit/api'
import { bodyObject, sendPaperData, sendPaperError } from '../../../../../lib/paper/api'
import { resetPaperExperiment } from '../../../../../lib/paper/experiment'

/** POST /api/paper/experiments/:id/reset —— 关闭旧实验并原子创建 -v2 实验。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  try {
    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')
    const id = typeof req.query.id === 'string' ? req.query.id : ''
    if (!id) return sendError(req, res, 400, 'INVALID_INPUT', '缺少实验 id')
    const body = bodyObject(req.body)
    const result = await resetPaperExperiment({
      experimentId: id,
      name: typeof body.name === 'string' ? body.name : undefined,
    })
    return sendPaperData(res, 200, result)
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
