import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, ensureSameOrigin, queryInt, queryString, sendData, sendError } from '../../../lib/cockpit/api'
import { enqueueTask, scheduleTaskDrain } from '../../../lib/cockpit/tasks'
import {
  createInvestigation,
  getInvestigation,
  listInvestigations,
  setInvestigationFeedback,
} from '../../../lib/desk/investigation'
import type { InvestigationFeedback } from '../../../lib/desk/types'

const FEEDBACK: InvestigationFeedback[] = ['useful', 'wrong', 'incomplete']

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST', 'PATCH'])) return
  try {
    if (req.method === 'GET') {
      const id = queryString(req.query.id)
      if (id) {
        const investigation = await getInvestigation(id)
        if (!investigation) return sendError(req, res, 404, 'INVESTIGATION_NOT_FOUND', '调查不存在')
        sendData(res, investigation, await buildMeta())
        return
      }
      const status = queryString(req.query.status)
      const alertId = queryString(req.query.alertId)
      const judgmentId = queryString(req.query.judgmentId)
      const items = await listInvestigations({
        status,
        alertId,
        judgmentId,
        limit: queryInt(req.query.limit, 20, 1, 50),
      })
      sendData(res, { investigations: items }, await buildMeta())
      return
    }

    if (!ensureSameOrigin(req)) {
      return sendError(req, res, 403, 'CROSS_ORIGIN', '拒绝跨站请求')
    }
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}

    if (req.method === 'PATCH') {
      if (typeof body.id !== 'string' || !body.id) {
        return sendError(req, res, 400, 'MISSING_ID', '缺少调查 id')
      }
      const feedback = body.feedback === null
        ? null
        : FEEDBACK.includes(body.feedback as InvestigationFeedback)
          ? body.feedback as InvestigationFeedback
          : undefined
      if (feedback === undefined) {
        return sendError(req, res, 400, 'INVALID_FEEDBACK', '反馈取值无效')
      }
      const ok = await setInvestigationFeedback(body.id, feedback)
      if (!ok) return sendError(req, res, 404, 'INVESTIGATION_NOT_FOUND', '调查不存在')
      sendData(res, { ok: true }, await buildMeta())
      return
    }

    const alertId = typeof body.alertId === 'string' && body.alertId ? body.alertId : undefined
    const judgmentId = typeof body.judgmentId === 'string' && body.judgmentId ? body.judgmentId : undefined
    if (!alertId && !judgmentId) {
      return sendError(req, res, 400, 'MISSING_TARGET', '需要 alertId 或 judgmentId')
    }
    const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : ''
    const { investigation, created } = await createInvestigation({
      alertId,
      judgmentId,
      question: question || undefined,
      triggerReason: typeof body.triggerReason === 'string' ? body.triggerReason.slice(0, 200) : undefined,
      manual: true,
    })
    let task = null
    if (created && investigation.status === 'queued') {
      task = await enqueueTask({ type: 'desk_investigation', params: { investigationId: investigation.id } })
      scheduleTaskDrain()
    }
    sendData(res, { investigation, created, task }, await buildMeta())
  } catch (err) {
    sendError(req, res, 500, 'INVESTIGATION_FAILED', err instanceof Error ? err.message : '调查操作失败')
  }
}
