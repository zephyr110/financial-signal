import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, queryString, sendData, sendError } from '../../../../lib/cockpit/api'
import { ensureCockpitDemoSeed } from '../../../../lib/cockpit/demo'
import { getStockDetail } from '../../../../lib/cockpit/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const code = queryString(req.query.code)
    if (!code || code.length > 20) {
      return sendError(req, res, 400, 'INVALID_CODE', '股票代码无效')
    }
    const detail = await getStockDetail(code)
    if (!detail) return sendError(req, res, 404, 'STOCK_NOT_FOUND', '未找到该标的')
    return sendData(res, detail, await buildMeta(detail.asOf))
  } catch (err) {
    console.error('[cockpit/stocks]', err instanceof Error ? err.message : err)
    return sendError(req, res, 500, 'STOCK_FAILED', '读取个股失败')
  }
}
