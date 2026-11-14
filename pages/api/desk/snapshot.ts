import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryString, sendData, sendError } from '../../../lib/cockpit/api'
import { getDeskSnapshot } from '../../../lib/desk/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const tradeDate = queryString(req.query.tradeDate)
    const snapshot = await getDeskSnapshot(tradeDate)
    sendData(res, snapshot, {
      asOf: snapshot.asOf,
      sourceHealth: snapshot.dataQuality,
    })
  } catch (err) {
    sendError(req, res, 400, 'DESK_SNAPSHOT_FAILED', err instanceof Error ? err.message : '读取投研台失败')
  }
}
