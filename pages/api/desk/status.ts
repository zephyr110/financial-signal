import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, sendData, sendError } from '../../../lib/cockpit/api'
import { getDeskStatus } from '../../../lib/desk/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    sendData(res, await getDeskStatus(), await buildMeta())
  } catch (err) {
    sendError(req, res, 500, 'DESK_STATUS_FAILED', err instanceof Error ? err.message : '读取投研台状态失败')
  }
}
