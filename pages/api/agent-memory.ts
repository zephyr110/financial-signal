import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, ensureSameOrigin, queryInt, queryString, sendData, sendError } from '../../lib/cockpit/api'
import {
  deleteAgentMemory,
  listAgentMemories,
  upsertAgentMemory,
  type MemoryScope,
} from '../../lib/agent/memory'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST', 'DELETE'])) return
  try {
    if (req.method === 'GET') {
      const memories = await listAgentMemories({
        scope: queryString(req.query.scope),
        status: queryString(req.query.status),
        limit: queryInt(req.query.limit, 30, 1, 100),
      })
      sendData(res, { memories }, await buildMeta())
      return
    }

    if (!ensureSameOrigin(req)) {
      return sendError(req, res, 403, 'CROSS_ORIGIN', '拒绝跨站请求')
    }

    if (req.method === 'DELETE') {
      const id = queryString(req.query.id)
      if (!id) return sendError(req, res, 400, 'MISSING_ID', '缺少记忆 id')
      const ok = await deleteAgentMemory(id)
      sendData(res, { ok }, await buildMeta())
      return
    }

    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}
    if (typeof body.scope !== 'string' || typeof body.key !== 'string' || typeof body.value !== 'string') {
      return sendError(req, res, 400, 'INVALID_MEMORY', '需要 scope、key 与 value')
    }
    const memory = await upsertAgentMemory({
      scope: body.scope as MemoryScope,
      key: body.key,
      value: body.value,
      projectId: typeof body.projectId === 'string' ? body.projectId : null,
      confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
    })
    sendData(res, { memory }, await buildMeta())
  } catch (err) {
    sendError(req, res, 400, 'MEMORY_FAILED', err instanceof Error ? err.message : '记忆操作失败')
  }
}
