import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryInt, queryString } from '../../../lib/cockpit/api'
import { getDb } from '../../../lib/db'
import {
  parseJsonColumn,
  resolvePaperContext,
  sendPaperData,
  sendPaperError,
} from '../../../lib/paper/api'
import { getPaperRiskState } from '../../../lib/paper/repo'

/** GET /api/paper/risk-events —— 最近风控事件 + 当前 kill switch 状态。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const ctx = await resolvePaperContext({
      experimentId: queryString(req.query.experimentId),
      accountId: queryString(req.query.accountId),
    })
    const limit = queryInt(req.query.limit, 50, 1, 200)

    const db = await getDb()
    const [eventsR, riskState] = await Promise.all([
      db.execute({
        sql: `SELECT * FROM paper_risk_events WHERE account_id = ?
              ORDER BY created_at DESC, id DESC LIMIT ?`,
        args: [ctx.account.id, limit],
      }),
      getPaperRiskState(ctx.account.id),
    ])

    return sendPaperData(res, 200, {
      account: { id: ctx.account.id, name: ctx.account.name },
      riskState: {
        killSwitch: riskState.killSwitch,
        killReason: riskState.killReason,
        killSince: riskState.killSince,
        dataQuality: riskState.dataQuality,
        missingPriceSince: riskState.missingPriceSince,
        releaseAfterDate: riskState.releaseAfterDate,
        lastEvaluatedAt: riskState.lastEvaluatedAt,
      },
      events: eventsR.rows.map((row) => ({
        id: String(row.id),
        rule: String(row.rule),
        severity: String(row.severity),
        thresholdValue: row.threshold_value == null ? null : Number(row.threshold_value),
        actualValue: row.actual_value == null ? null : Number(row.actual_value),
        action: String(row.action),
        message: String(row.message ?? ''),
        detail: parseJsonColumn(row.detail_json, null),
        dataQuality: String(row.data_quality),
        refType: row.ref_type == null ? null : String(row.ref_type),
        refId: row.ref_id == null ? null : String(row.ref_id),
        orderId: row.order_id == null ? null : String(row.order_id),
        cardId: row.card_id == null ? null : String(row.card_id),
        createdAt: String(row.created_at),
      })),
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
