import type { NextApiRequest, NextApiResponse } from 'next'
import { ensureMethod, queryString, sendError } from '../../../lib/cockpit/api'
import { getDb } from '../../../lib/db'
import {
  isTradeDate,
  loadPaperSymbolNames,
  resolvePaperContext,
  sendPaperData,
  sendPaperError,
  shanghaiToday,
} from '../../../lib/paper/api'
import {
  getPaperRiskState,
  loadPaperLedger,
  loadPaperRiskSnapshot,
} from '../../../lib/paper/repo'

/** GET /api/paper/positions —— 当前持仓与风控状态（派生态，不读物化表）。 */
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
        sql: 'SELECT MAX(trade_date) AS d FROM paper_nav WHERE account_id = ?',
        args: [ctx.account.id],
      })
      const latest = r.rows[0]?.d
      tradeDate = latest == null ? shanghaiToday() : String(latest)
    }

    const [snapshot, ledger, riskState] = await Promise.all([
      loadPaperRiskSnapshot({ accountId: ctx.account.id, tradeDate }),
      loadPaperLedger(ctx.account.id),
      getPaperRiskState(ctx.account.id),
    ])
    const names = await loadPaperSymbolNames(snapshot.positions.map((p) => p.symbolCode))
    const marketValueCents = snapshot.positions.reduce((sum, p) => sum + p.marketValueCents, 0)

    return sendPaperData(res, 200, {
      account: {
        id: ctx.account.id,
        kind: ctx.account.kind,
        name: ctx.account.name,
        status: ctx.account.status,
        isDemo: ctx.account.isDemo,
        initialCashCents: ctx.account.initialCashCents,
      },
      tradeDate,
      cashCents: snapshot.cashCents,
      frozenCashCents: ledger.frozenCashCents,
      navCents: snapshot.navCents,
      marketValueCents,
      positions: snapshot.positions.map((p) => ({
        ...p,
        symbolName: names[p.symbolCode] ?? null,
      })),
      missingPriceSymbols: snapshot.missingPriceSymbols,
      risk: {
        killSwitch: riskState.killSwitch,
        killReason: riskState.killReason,
        killSince: riskState.killSince,
        dataQuality: riskState.dataQuality,
        missingPriceSince: riskState.missingPriceSince,
        dailyOrders: snapshot.dailyOrders,
        dailyNewPositions: snapshot.dailyNewPositions,
        dailyLossBp: snapshot.dailyLossBp,
        drawdownBp: snapshot.drawdownBp,
      },
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
