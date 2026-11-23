import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryString, sendError } from '../../../lib/cockpit/api'
import { getDb } from '../../../lib/db'
import {
  isTradeDate,
  parseJsonColumn,
  resolvePaperContext,
  sendPaperData,
  sendPaperError,
  shanghaiToday,
} from '../../../lib/paper/api'

/** GET /api/paper/decisions —— 某一交易日的决策卡；缺省取最新一批。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const ctx = await resolvePaperContext({
      experimentId: queryString(req.query.experimentId),
      accountId: queryString(req.query.accountId),
    })
    const requested = queryString(req.query.tradeDate)
    if (requested && !isTradeDate(requested)) {
      return sendError(req, res, 400, 'INVALID_INPUT', 'tradeDate 应为 YYYY-MM-DD')
    }

    const db = await getDb()
    let tradeDate = requested
    if (!tradeDate) {
      const r = await db.execute({
        sql: 'SELECT MAX(trade_date) AS d FROM paper_decision_cards WHERE experiment_id = ?',
        args: [ctx.experiment.id],
      })
      const latest = r.rows[0]?.d
      tradeDate = latest == null ? shanghaiToday() : String(latest)
    }

    const r = await db.execute({
      sql: `SELECT c.*, m.name AS symbol_name, m.industry_name
            FROM paper_decision_cards c
            LEFT JOIN paper_symbol_meta m ON m.symbol_code = c.symbol_code
              AND m.valid_from = (
                SELECT MAX(m2.valid_from) FROM paper_symbol_meta m2
                WHERE m2.symbol_code = c.symbol_code
                  AND m2.valid_from <= c.trade_date
                  AND (m2.valid_to IS NULL OR m2.valid_to >= c.trade_date)
              )
            WHERE c.experiment_id = ? AND c.trade_date = ?
            ORDER BY c.confidence_score DESC, c.created_at, c.id`,
      args: [ctx.experiment.id, tradeDate],
    })

    const cards = r.rows.map((row) => ({
      id: String(row.id),
      experimentId: String(row.experiment_id),
      cardVersion: Number(row.card_version),
      tradeDate: String(row.trade_date),
      symbolCode: String(row.symbol_code),
      symbolName: row.symbol_name == null ? null : String(row.symbol_name),
      industryName: row.industry_name == null ? null : String(row.industry_name),
      snapshotId: String(row.snapshot_id),
      policyVersion: String(row.policy_version),
      status: String(row.status),
      stance: String(row.stance),
      horizon: String(row.horizon),
      thesis: String(row.thesis ?? ''),
      triggerBasis: String(row.trigger_basis),
      triggerOp: row.trigger_op == null ? null : String(row.trigger_op),
      triggerPriceCents: row.trigger_price_cents == null ? null : Number(row.trigger_price_cents),
      stopPriceCents: row.stop_price_cents == null ? null : Number(row.stop_price_cents),
      maxLossCents: row.max_loss_cents == null ? null : Number(row.max_loss_cents),
      maxPositionPctBp: Number(row.max_position_pct_bp),
      confidenceScore: Number(row.confidence_score),
      confidenceInputs: parseJsonColumn(row.confidence_inputs_json, null),
      evidence: parseJsonColumn(row.evidence_json, []),
      counterEvidence: parseJsonColumn(row.counter_evidence_json, []),
      invalidation: String(row.invalidation ?? ''),
      reviewDate: row.review_date == null ? null : String(row.review_date),
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
      dismissedReason: row.dismissed_reason == null ? null : String(row.dismissed_reason),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))

    return sendPaperData(res, 200, {
      experiment: {
        id: ctx.experiment.id,
        name: ctx.experiment.name,
        policyVersion: ctx.experiment.policyVersion,
        status: ctx.experiment.status,
      },
      account: {
        id: ctx.account.id,
        kind: ctx.account.kind,
        name: ctx.account.name,
        status: ctx.account.status,
        isDemo: ctx.account.isDemo,
      },
      tradeDate,
      cards,
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
