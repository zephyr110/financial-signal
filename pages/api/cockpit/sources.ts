import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, sendData, sendError } from '../../../lib/cockpit/api'
import { ensureCockpitDemoSeed } from '../../../lib/cockpit/demo'
import { getSourceHealth } from '../../../lib/cockpit/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const health = await getSourceHealth()
    return sendData(res, health, await buildMeta())
  } catch (err) {
    console.error('[cockpit/sources]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'SOURCES_FAILED', '读取数据源状态失败')
  }
}
