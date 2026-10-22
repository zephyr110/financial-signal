import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, queryString, sendData, sendError } from '../../../lib/cockpit/api'
import { ensureCockpitDemoSeed } from '../../../lib/cockpit/demo'
import { getTodayPayload } from '../../../lib/cockpit/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const date = queryString(req.query.date)
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendError(req, res, 400, 'INVALID_DATE', '日期格式应为 YYYY-MM-DD')
    }
    const payload = await getTodayPayload(date)
    if (!payload) {
      return sendError(req, res, 404, 'NO_BRIEF', '还没有收盘简报，先运行“生成今日简报”任务')
    }
    return sendData(res, payload, await buildMeta(payload.generatedAt))
  } catch (err) {
    console.error('[cockpit/today]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'TODAY_FAILED', '读取收盘简报失败')
  }
}
