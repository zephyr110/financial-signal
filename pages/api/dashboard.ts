import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, queryString, sendData, sendError } from '../../lib/cockpit/api'
import { ensureCockpitDemoSeed } from '../../lib/cockpit/demo'
import { parseDashboardSections } from '../../lib/dashboard/aggregate'
import { getDashboard } from '../../lib/dashboard/repo'

/** GET /api/dashboard?sections=brief,pulse — 单请求聚合首页数据，区块级失败隔离。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const sections = parseDashboardSections(queryString(req.query.sections))
    const payload = await getDashboard(sections)
    return sendData(res, payload, await buildMeta(payload.asOf))
  } catch (err) {
    console.error('[api/dashboard]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'DASHBOARD_FAILED', '驾驶舱数据暂时不可用')
  }
}
