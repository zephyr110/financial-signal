import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, sendData, sendError } from '../../../lib/cockpit/api'
import { ensureCockpitDemoSeed } from '../../../lib/cockpit/demo'
import { getWatchlist } from '../../../lib/cockpit/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    return sendData(res, await getWatchlist(), await buildMeta())
  } catch (err) {
    console.error('[cockpit/watchlist]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'WATCHLIST_FAILED', '读取自选失败')
  }
}
