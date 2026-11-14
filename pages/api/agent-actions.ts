import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, ensureSameOrigin, queryString, sendData, sendError } from '../../lib/cockpit/api'
import {
  listAgentActions,
  proposeAgentAction,
  resolveAgentAction,
  type AgentActionType,
} from '../../lib/agent/actions'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST', 'PATCH'])) return
  try {
    if (req.method === 'GET') {
      const actions = await listAgentActions({
        status: queryString(req.query.status),
        limit: Number(queryString(req.query.limit) || 30),
      })
      sendData(res, { actions }, await buildMeta())
      return
    }

    if (!ensureSameOrigin(req)) {
      return sendError(req, res, 403, 'CROSS_ORIGIN', '拒绝跨站请求')
    }
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}

    if (req.method === 'PATCH') {
      if (typeof body.id !== 'string' || !body.id) {
        return sendError(req, res, 400, 'MISSING_ID', '缺少动作 id')
      }
      if (body.decision !== 'confirm' && body.decision !== 'reject') {
        return sendError(req, res, 400, 'INVALID_DECISION', 'decision 需为 confirm 或 reject')
      }
      const action = await resolveAgentAction(body.id, body.decision)
      if (!action) return sendError(req, res, 404, 'ACTION_NOT_FOUND', '动作不存在')
      sendData(res, { action }, await buildMeta())
      return
    }

    if (typeof body.type !== 'string' || !body.payload || typeof body.payload !== 'object') {
      return sendError(req, res, 400, 'INVALID_ACTION', '需要 type 与 payload')
    }
    const action = await proposeAgentAction({
      type: body.type as AgentActionType,
      payload: body.payload as Record<string, unknown>,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      turnId: typeof body.turnId === 'string' ? body.turnId : null,
    })
    sendData(res, { action }, await buildMeta())
  } catch (err) {
    sendError(req, res, 400, 'ACTION_FAILED', err instanceof Error ? err.message : '动作操作失败')
  }
}
