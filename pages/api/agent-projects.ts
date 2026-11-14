import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, ensureSameOrigin, queryString, sendData, sendError } from '../../lib/cockpit/api'
import {
  addProjectItem,
  createProject,
  getProject,
  listProjects,
  removeProjectItem,
  updateProject,
  type ProjectItemKind,
  type ProjectStatus,
} from '../../lib/agent/projects'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET', 'POST', 'PATCH', 'DELETE'])) return
  try {
    if (req.method === 'GET') {
      const id = queryString(req.query.id)
      if (id) {
        const project = await getProject(id)
        if (!project) return sendError(req, res, 404, 'PROJECT_NOT_FOUND', '研究项目不存在')
        sendData(res, project, await buildMeta())
        return
      }
      const projects = await listProjects({
        status: queryString(req.query.status) || 'active',
        limit: Number(queryString(req.query.limit) || 50),
      })
      sendData(res, { projects }, await buildMeta())
      return
    }

    if (!ensureSameOrigin(req)) {
      return sendError(req, res, 403, 'CROSS_ORIGIN', '拒绝跨站请求')
    }
    const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {}

    if (req.method === 'POST') {
      if (typeof body.name !== 'string') {
        return sendError(req, res, 400, 'INVALID_PROJECT', '缺少项目名称')
      }
      const project = await createProject({
        name: body.name,
        thesis: typeof body.thesis === 'string' ? body.thesis : undefined,
        industries: body.industries,
        symbols: body.symbols,
      })
      sendData(res, { project }, await buildMeta())
      return
    }

    if (typeof body.id !== 'string' || !body.id) {
      return sendError(req, res, 400, 'MISSING_ID', '缺少项目 id')
    }

    if (req.method === 'PATCH') {
      const item = body.item && typeof body.item === 'object' ? body.item as Record<string, unknown> : null
      if (item) {
        const added = await addProjectItem({
          projectId: body.id,
          kind: String(item.kind || '') as ProjectItemKind,
          refId: String(item.refId || ''),
          title: typeof item.title === 'string' ? item.title : undefined,
          note: typeof item.note === 'string' ? item.note : undefined,
        })
        if (!added) return sendError(req, res, 404, 'PROJECT_NOT_FOUND', '研究项目不存在')
        sendData(res, { item: added }, await buildMeta())
        return
      }
      if (body.removeItem && typeof body.removeItem === 'object') {
        const remove = body.removeItem as Record<string, unknown>
        const ok = await removeProjectItem(body.id, String(remove.kind || '') as ProjectItemKind, String(remove.refId || ''))
        sendData(res, { ok }, await buildMeta())
        return
      }
      const project = await updateProject(body.id, {
        name: typeof body.name === 'string' ? body.name : undefined,
        thesis: body.thesis === null ? null : typeof body.thesis === 'string' ? body.thesis : undefined,
        status: typeof body.status === 'string' ? body.status as ProjectStatus : undefined,
        industries: body.industries,
        symbols: body.symbols,
      })
      if (!project) return sendError(req, res, 404, 'PROJECT_NOT_FOUND', '研究项目不存在')
      sendData(res, { project }, await buildMeta())
      return
    }

    const project = await updateProject(body.id, { status: 'archived' })
    if (!project) return sendError(req, res, 404, 'PROJECT_NOT_FOUND', '研究项目不存在')
    sendData(res, { project }, await buildMeta())
  } catch (err) {
    sendError(req, res, 400, 'PROJECT_FAILED', err instanceof Error ? err.message : '研究项目操作失败')
  }
}
