import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryInt, queryString } from '../../../lib/cockpit/api'
import { getDb } from '../../../lib/db'
import {
  loadPaperSymbolNames,
  resolvePaperContext,
  sendPaperData,
  sendPaperError,
} from '../../../lib/paper/api'

/** GET /api/paper/fills —— 最近成交（默认 50 笔）。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const ctx = await resolvePaperContext({
      experimentId: queryString(req.query.experimentId),
      accountId: queryString(req.query.accountId),
    })
    const limit = queryInt(req.query.limit, 50, 1, 500)

    const db = await getDb()
    const r = await db.execute({
      sql: `SELECT * FROM paper_fills WHERE account_id = ?
            ORDER BY settled_at DESC, id DESC LIMIT ?`,
      args: [ctx.account.id, limit],
    })
    const names = await loadPaperSymbolNames(r.rows.map((row) => String(row.symbol_code)))

    const fills = r.rows.map((row) => ({
      id: String(row.id),
      orderId: String(row.order_id),
      experimentId: String(row.experiment_id),
      accountId: String(row.account_id),
      symbolCode: String(row.symbol_code),
      symbolName: names[String(row.symbol_code)] ?? null,
      side: String(row.side),
      qty: Number(row.qty),
      priceCents: Number(row.price_cents),
      grossCents: Number(row.gross_cents),
      commissionCents: Number(row.commission_cents),
      stampTaxCents: Number(row.stamp_tax_cents),
      transferFeeCents: Number(row.transfer_fee_cents),
      slippageCents: Number(row.slippage_cents),
      totalFeesCents: Number(row.total_fees_cents),
      tradeDate: String(row.trade_date),
      tradeTime: String(row.trade_time),
      settledAt: String(row.settled_at),
      priceBasis: String(row.price_basis),
      priceSourceId: row.price_source_id == null ? null : String(row.price_source_id),
      barFetchedAt: row.bar_fetched_at == null ? null : String(row.bar_fetched_at),
      barHash: row.bar_hash == null ? null : String(row.bar_hash),
      snapshotId: row.snapshot_id == null ? null : String(row.snapshot_id),
      isDemo: Number(row.is_demo) === 1,
      createdAt: String(row.created_at),
    }))

    return sendPaperData(res, 200, {
      account: { id: ctx.account.id, name: ctx.account.name },
      fills,
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
