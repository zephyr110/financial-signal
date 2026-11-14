import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, sendData, sendError } from '../../../lib/cockpit/api'
import { getOverseasQuotes } from '../../../lib/desk/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    sendData(res, await getOverseasQuotes(), await buildMeta())
  } catch (err) {
    sendError(req, res, 500, 'OVERSEAS_FAILED', err instanceof Error ? err.message : '读取外盘行情失败')
  }
}
