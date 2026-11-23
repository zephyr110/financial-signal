import type { NextApiRequest, NextApiResponse } from 'next'
import { todayShanghai } from '../../../lib/cockpit/format'
import { ensureMethod, ensureSameOrigin, sendError } from '../../../lib/cockpit/api'
import { getDb } from '../../../lib/db'
import {
  bodyObject,
  isTradeDate,
  paperRequestHash,
  resolvePaperContext,
  sendPaperData,
  sendPaperError,
} from '../../../lib/paper/api'
import { isPaperTradingDay } from '../../../lib/paper/calendar'
import { calcFees, reserveBuyPriceCents } from '../../../lib/paper/market'
import { confirmPaperOrder, type ReservationRequest } from '../../../lib/paper/orders'
import { loadPaperSymbolContext, PaperRepoError } from '../../../lib/paper/repo'
import type { PaperOrderType } from '../../../lib/paper/types'

/**
 * POST /api/paper/execute —— 确认一张决策卡（或卖出）。
 * 触发价/版本一律取服务端卡片，客户端只能给卡 id 与股数，防止篡改。
 * 同一 clientRequestId/idempotencyKey 重放返回 200 + 原单，新请求用 201。
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!ensureMethod(req, res, ['POST'])) return
  try {
    if (!ensureSameOrigin(req)) return sendError(req, res, 403, 'ORIGIN_MISMATCH', '拒绝跨站写入')

    const body = bodyObject(req.body)
    const side = body.side === 'buy' || body.side === 'sell' ? body.side : null
    if (!side) return sendError(req, res, 400, 'INVALID_INPUT', 'side 必须是 buy 或 sell')
    const qty = Number(body.qty)
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      return sendError(req, res, 400, 'INVALID_INPUT', 'qty 必须是正整数')
    }
    const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : ''
    if (!clientRequestId) {
      return sendError(req, res, 400, 'INVALID_INPUT', '缺少 clientRequestId（用于幂等）')
    }
    const idempotencyKey = typeof body.idempotencyKey === 'string' && body.idempotencyKey.trim()
      ? body.idempotencyKey.trim()
      : clientRequestId

    const ctx = await resolvePaperContext({
      experimentId: typeof body.experimentId === 'string' ? body.experimentId : null,
      accountId: typeof body.accountId === 'string' ? body.accountId : null,
    })
    // 影子账户只能由系统按规则下单，不能借用用户身份写入。
    if (ctx.account.kind !== 'user') {
      return sendError(req, res, 403, 'FORBIDDEN', '只能对主账户下单')
    }
    const db = await getDb()

    const cardId = typeof body.cardId === 'string' && body.cardId.trim() ? body.cardId.trim() : null
    let symbolCode = typeof body.symbolCode === 'string' ? body.symbolCode.trim() : ''
    let cardVersion: number | null = null
    let targetTradeDate: string
    let orderType: PaperOrderType = 'open_market'
    let conditionOp: 'lte' | 'gte' | null = null
    let triggerPriceCents: number | null = null

    if (side === 'buy') {
      if (!cardId) return sendError(req, res, 400, 'INVALID_INPUT', '买入委托必须绑定决策卡')
      const r = await db.execute({
        sql: `SELECT id, experiment_id, card_version, trade_date, symbol_code, status, stance,
                     trigger_op, trigger_price_cents
              FROM paper_decision_cards WHERE id = ?`,
        args: [cardId],
      })
      if (!r.rows.length) return sendError(req, res, 404, 'NOT_FOUND', '决策卡不存在')
      const row = r.rows[0]
      if (String(row.experiment_id) !== ctx.experiment.id) {
        return sendError(req, res, 400, 'INVALID_INPUT', '决策卡属于其他实验')
      }
      const cardSymbol = String(row.symbol_code)
      if (symbolCode && symbolCode !== cardSymbol) {
        return sendError(req, res, 400, 'INVALID_INPUT', '决策卡与委托标的不一致')
      }
      // 只有候选立场允许买入：观察/谨慎/回避卡即使 active 也不能借接口下单。
      if (String(row.stance) !== 'candidate') {
        return sendError(req, res, 400, 'INVALID_INPUT', '只有候选买入卡可以下单')
      }
      symbolCode = cardSymbol
      cardVersion = Number(row.card_version)
      targetTradeDate = String(row.trade_date)
      if (row.trigger_op === 'lte' || row.trigger_op === 'gte') {
        conditionOp = row.trigger_op
        triggerPriceCents = row.trigger_price_cents == null ? null : Number(row.trigger_price_cents)
      }
      if (conditionOp && triggerPriceCents) orderType = 'open_price_condition'
    } else {
      if (!symbolCode) return sendError(req, res, 400, 'INVALID_INPUT', '卖出必须指定 symbolCode')
      const requested = body.targetTradeDate
      if (requested != null && !isTradeDate(requested)) {
        return sendError(req, res, 400, 'INVALID_INPUT', 'targetTradeDate 应为 YYYY-MM-DD')
      }
      targetTradeDate = isTradeDate(requested) ? requested : todayShanghai()
    }
    if (!isTradeDate(targetTradeDate)) {
      return sendError(req, res, 400, 'INVALID_INPUT', `目标交易日格式错误: ${targetTradeDate}`)
    }
    if (!(await isPaperTradingDay(targetTradeDate))) {
      return sendError(req, res, 400, 'INVALID_INPUT', `目标交易日 ${targetTradeDate} 休市`)
    }

    const reservations: ReservationRequest[] = []
    if (side === 'buy') {
      const symbolCtx = await loadPaperSymbolContext(symbolCode, targetTradeDate)
      // 限价单最多成交在触发价；市价单按 T-1 收盘 + 滑点冻结。
      const reservePriceCents = triggerPriceCents
        ?? (symbolCtx.lastCloseCents
          ? reserveBuyPriceCents(symbolCtx.lastCloseCents, ctx.policy.fees.slippagePpm)
          : null)
      if (!reservePriceCents || reservePriceCents <= 0) {
        throw new PaperRepoError('MISSING_PRICE', `缺少 ${symbolCode} 最近收盘价，无法计算冻结资金`)
      }
      const fees = calcFees('buy', qty, reservePriceCents, reservePriceCents, ctx.policy.fees)
      reservations.push({ kind: 'cash', amountCents: qty * reservePriceCents + fees.totalFeesCents })
    } else {
      reservations.push({ kind: 'shares', qty, symbolCode })
    }

    const requestHash = paperRequestHash({
      accountId: ctx.account.id,
      cardId,
      cardVersion,
      symbolCode,
      side,
      orderType,
      qty,
      conditionOp,
      triggerPriceCents,
      targetTradeDate,
    })

    const result = await confirmPaperOrder({
      accountId: ctx.account.id,
      experimentId: ctx.experiment.id,
      actor: 'user',
      cardId,
      cardVersion,
      symbolCode,
      side,
      orderType,
      qty,
      conditionOp,
      triggerPriceCents,
      clientRequestId,
      idempotencyKey,
      requestHash,
      targetTradeDate,
      reservations,
    })

    return sendPaperData(res, result.replayed ? 200 : 201, {
      order: result.order,
      replayed: result.replayed,
      account: { id: ctx.account.id, name: ctx.account.name },
    })
  } catch (err) {
    return sendPaperError(req, res, err)
  }
}
