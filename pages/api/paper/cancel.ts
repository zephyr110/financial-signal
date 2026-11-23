import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, ensureSameOrigin, sendError } from '../../../lib/cockpit/api'
import { bodyObject, resolvePaperContext, sendPaperData, sendPaperError } from '../../../lib/paper/api'
import { cancelPaperOrder, getPaperOrder } from '../../../lib/paper/orders'

/** POST /api/paper/cancel —— 09:15 前撤销仍处于 confirmed 的委托。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  try {
    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')

    const body = bodyObject(req.body)
    const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : ''
    if (!orderId) return sendError(req, res, 400, 'INVALID_INPUT', '缺少 orderId')

    const ctx = await resolvePaperContext({
      experimentId: typeof body.experimentId === 'string' ? body.experimentId : null,
      accountId: typeof body.accountId === 'string' ? body.accountId : null,
    })
    if (ctx.account.kind !== 'user') {
      return sendError(req, res, 403, 'FORBIDDEN', '只能撤销主账户的委托')
    }
    const order = await getPaperOrder(orderId)
    // 不暴露其他账户的委托是否存在。
    if (!order || order.accountId !== ctx.account.id) {
      return sendError(req, res, 404, 'NOT_FOUND', '委托不存在')
    }

    const canceled = await cancelPaperOrder({ orderId })
    if (!canceled) {
      return sendError(req, res, 409, 'ALREADY_FINAL', '委托已进入冻结或已结束，不能撤销')
    }
    return sendPaperData(res, 200, { orderId, canceled: true })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
