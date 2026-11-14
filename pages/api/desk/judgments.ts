import type { NextApiRequest, NextApiResponse } from 'next'
import { buildMeta, ensureMethod, queryInt, queryString, sendData, sendError } from '../../../lib/cockpit/api'
import { listJudgmentDates, listJudgments } from '../../../lib/desk/repo'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const kindRaw = queryString(req.query.kind)
    if (kindRaw && kindRaw !== 'market' && kindRaw !== 'industry') {
      return sendError(req, res, 400, 'INVALID_KIND', 'kind 只能为 market 或 industry')
    }
    const result = await listJudgments({
      kind: kindRaw as 'market' | 'industry' | undefined,
      industry: queryString(req.query.industry),
      from: queryString(req.query.from),
      to: queryString(req.query.to),
      limit: queryInt(req.query.limit, 30, 1, 100),
      offset: queryInt(req.query.offset, 0, 0, 1_000_000),
    })
    sendData(res, {
      ...result,
      dates: await listJudgmentDates(30),
    }, await buildMeta())
  } catch (err) {
    sendError(req, res, 500, 'JUDGMENTS_FAILED', err instanceof Error ? err.message : '读取判断台账失败')
  }
}
