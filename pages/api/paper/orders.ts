import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryInt, queryString, sendError } from '../../../lib/cockpit/api'
import { getDb } from '../../../lib/db'
import {
  isTradeDate,
  loadPaperSymbolNames,
  resolvePaperContext,
  sendPaperData,
  sendPaperError,
} from '../../../lib/paper/api'
import { listPaperOrders } from '../../../lib/paper/orders'
import type { PaperOrderStatus } from '../../../lib/paper/types'

const ORDER_STATUSES: PaperOrderStatus[] = [
  'confirmed', 'settlement_pending', 'filled', 'rejected', 'expired', 'trigger_not_met', 'canceled',
]

/** GET /api/paper/orders —— 账户委托列表；默认最近 100 条，可按交易日/状态过滤。 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['GET'])) return
  try {
    const ctx = await resolvePaperContext({
      experimentId: queryString(req.query.experimentId),
      accountId: queryString(req.query.accountId),
    })

    const tradeDate = queryString(req.query.tradeDate)
    if (tradeDate && !isTradeDate(tradeDate)) {
      return sendError(req, res, 400, 'INVALID_INPUT', 'tradeDate 应为 YYYY-MM-DD')
    }
    const rawStatuses = (queryString(req.query.status) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const statuses: PaperOrderStatus[] = []
    for (const s of rawStatuses) {
      if (!ORDER_STATUSES.includes(s as PaperOrderStatus)) {
        return sendError(req, res, 400, 'INVALID_INPUT', `未知委托状态: ${s}`)
      }
      statuses.push(s as PaperOrderStatus)
    }
    const limit = queryInt(req.query.limit, 100, 1, 500)

    const orders = (await listPaperOrders({
      accountId: ctx.account.id,
      tradeDate,
      statuses,
      limit,
    })).reverse()

    const [names, cardMap] = await Promise.all([
      loadPaperSymbolNames(orders.map((o) => o.symbolCode)),
      loadCardTheses(orders.map((o) => o.cardId).filter((id): id is string => Boolean(id))),
    ])

    return sendPaperData(res, 200, {
      account: { id: ctx.account.id, name: ctx.account.name, kind: ctx.account.kind },
      tradeDate: tradeDate ?? null,
      orders: orders.map((o) => ({
        ...o,
        symbolName: names[o.symbolCode] ?? null,
        cardThesis: o.cardId ? cardMap[o.cardId]?.thesis ?? null : null,
        cardStance: o.cardId ? cardMap[o.cardId]?.stance ?? null : null,
      })),
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}

async function loadCardTheses(cardIds: string[]): Promise<Record<string, { thesis: string; stance: string }>> {
  const unique = [...new Set(cardIds)]
  if (!unique.length) return {}
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT id, thesis, stance FROM paper_decision_cards
          WHERE id IN (${unique.map(() => '?').join(',')})`,
    args: unique,
  })
  const out: Record<string, { thesis: string; stance: string }> = {}
  for (const row of r.rows) {
    out[String(row.id)] = { thesis: String(row.thesis ?? ''), stance: String(row.stance) }
  }
  return out
}
