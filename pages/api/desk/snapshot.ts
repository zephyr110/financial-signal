import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryString, sendData, sendError } from '../../../lib/cockpit/api'
import { DeskSnapshotNotFoundError, getDeskSnapshot } from '../../../lib/desk/repo'

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
    if (err instanceof DeskSnapshotNotFoundError) {
      return sendError(req, res, 404, 'DESK_SNAPSHOT_NOT_FOUND', err.message)
    }
    console.error('[desk/snapshot]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'DESK_SNAPSHOT_FAILED', '读取投研台失败，请稍后重试')
  }
}
