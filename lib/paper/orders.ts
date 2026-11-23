import crypto from 'crypto'
import { getDb } from '../db'
import { isPaperTradingDay } from './calendar'
import { derivePositions, PaperLedgerError } from './ledger'
import { calcFees, reserveBuyPriceCents } from './market'
import {
  getPaperAccount,
  getPaperExperiment,
  getPaperExperimentPolicy,
  getPaperNavCents,
  getPaperRiskState,
  loadPaperLedger,
  loadPaperMarketInputs,
  loadPaperRiskSnapshot,
  loadPaperSymbolContext,
  loadPendingDividendGrossByLot,
  PaperRepoError,
  recordPaperRiskEvent,
  refreshPaperAccountCash,
  refreshPaperPositions,
  setPaperKillSwitch,
  setPaperMissingPriceState,
  writePaperAudit,
} from './repo'
import { evaluateRisk } from './risk'
import { planSettlement, type SettlementDecision } from './settlement'
import type {
  DataQuality,
  PaperOrderStatus,
  PaperOrderType,
  PaperReasonCode,
  PaperSide,
} from './types'

/**
 * 委托状态机与结算落库：
 * confirmed -> (09:15 freeze) settlement_pending -> 16:20 filled/rejected/expired/trigger_not_met；
 * 取消与结算都用条件 UPDATE 抢占状态，重复结算不会重复成交。
 */

type Row = Record<string, unknown>
type Conn = { execute: (stmt: { sql: string; args: unknown[] }) => Promise<{ rows: Row[]; rowsAffected: number }> }

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export interface PaperOrderRow {
  id: string
  experimentId: string
  accountId: string
  cardId: string | null
  cardVersion: number | null
  actor: 'user' | 'shadow'
  symbolCode: string
  side: PaperSide
  orderType: PaperOrderType
  qty: number
  conditionOp: 'lte' | 'gte' | null
  triggerPriceCents: number | null
  status: PaperOrderStatus
  clientRequestId: string
  idempotencyKey: string
  requestHash: string
  targetTradeDate: string
  offPlanReason: string | null
  rejectCode: string | null
  rejectDetail: string | null
  isDemo: boolean
  confirmedAt: string | null
  cutoffAt: string | null
  settledAt: string | null
  createdAt: string
  updatedAt: string
}

export interface PaperCardRow {
  id: string
  experimentId: string
  version: number
  tradeDate: string
  symbolCode: string
  snapshotId: string
  status: string
  stopPriceCents: number | null
  maxLossCents: number | null
}

function mapOrder(row: Row): PaperOrderRow {
  return {
    id: str(row.id),
    experimentId: str(row.experiment_id),
    accountId: str(row.account_id),
    cardId: str(row.card_id) || null,
    cardVersion: row.card_version == null ? null : num(row.card_version),
    actor: str(row.actor) === 'shadow' ? 'shadow' : 'user',
    symbolCode: str(row.symbol_code),
    side: str(row.side) === 'sell' ? 'sell' : 'buy',
    orderType: str(row.order_type) === 'open_price_condition' ? 'open_price_condition' : 'open_market',
    qty: num(row.qty),
    conditionOp: str(row.condition_op) === 'lte' || str(row.condition_op) === 'gte'
      ? (str(row.condition_op) as 'lte' | 'gte')
      : null,
    triggerPriceCents: row.trigger_price_cents == null ? null : num(row.trigger_price_cents),
    status: str(row.status, 'confirmed') as PaperOrderStatus,
    clientRequestId: str(row.client_request_id),
    idempotencyKey: str(row.idempotency_key),
    requestHash: str(row.request_hash),
    targetTradeDate: str(row.target_trade_date),
    offPlanReason: str(row.off_plan_reason) || null,
    rejectCode: str(row.reject_code) || null,
    rejectDetail: str(row.reject_detail) || null,
    isDemo: num(row.is_demo) === 1,
    confirmedAt: str(row.confirmed_at) || null,
    cutoffAt: str(row.cutoff_at) || null,
    settledAt: str(row.settled_at) || null,
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  }
}

export async function getPaperOrder(id: string): Promise<PaperOrderRow | null> {
  const db = await getDb()
  const r = await db.execute({ sql: 'SELECT * FROM paper_orders WHERE id = ?', args: [id] })
  return r.rows.length ? mapOrder(r.rows[0]) : null
}

export async function listPaperOrders(input: {
  accountId: string
  tradeDate?: string
  statuses?: PaperOrderStatus[]
  /** 只要最近 N 条时在 SQL 里截断，避免把整段历史读进内存。 */
  limit?: number
}): Promise<PaperOrderRow[]> {
  const db = await getDb()
  const args: unknown[] = [input.accountId]
  let where = 'account_id = ?'
  if (input.tradeDate) {
    where += ' AND target_trade_date = ?'
    args.push(input.tradeDate)
  }
  if (input.statuses?.length) {
    where += ` AND status IN (${input.statuses.map(() => '?').join(',')})`
    args.push(...input.statuses)
  }
  let sql = `SELECT * FROM paper_orders WHERE ${where} ORDER BY created_at, id`
  if (input.limit) {
    sql = `SELECT * FROM (SELECT * FROM paper_orders WHERE ${where}
             ORDER BY created_at DESC, id DESC LIMIT ?)
           ORDER BY created_at, id`
    args.push(input.limit)
  }
  const r = await db.execute({ sql, args })
  return r.rows.map(mapOrder)
}

export async function getPaperCard(id: string): Promise<PaperCardRow | null> {
  const db = await getDb()
  const r = await db.execute({ sql: 'SELECT * FROM paper_decision_cards WHERE id = ?', args: [id] })
  if (!r.rows.length) return null
  const row = r.rows[0]
  return {
    id: str(row.id),
    experimentId: str(row.experiment_id),
    version: num(row.card_version),
    tradeDate: str(row.trade_date),
    symbolCode: str(row.symbol_code),
    snapshotId: str(row.snapshot_id),
    status: str(row.status),
    stopPriceCents: row.stop_price_cents == null ? null : num(row.stop_price_cents),
    maxLossCents: row.max_loss_cents == null ? null : num(row.max_loss_cents),
  }
}

async function nextSeq(conn: Conn, table: 'paper_order_events' | 'paper_card_events', key: string): Promise<number> {
  const column = table === 'paper_order_events' ? 'order_id' : 'card_id'
  const r = await conn.execute({
    sql: `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM ${table} WHERE ${column} = ?`,
    args: [key],
  })
  return num(r.rows[0]?.next, 1)
}

async function insertOrderEvent(
  conn: Conn,
  orderId: string,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  payload: unknown,
  createdAt: string,
): Promise<void> {
  await conn.execute({
    sql: `INSERT INTO paper_order_events (order_id, seq, event_type, from_status, to_status, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [orderId, await nextSeq(conn, 'paper_order_events', orderId), eventType,
      fromStatus, toStatus, JSON.stringify(payload ?? {}), createdAt],
  })
}

async function insertCardEvent(
  conn: Conn,
  cardId: string,
  eventType: string,
  fromStatus: string | null,
  toStatus: string | null,
  payload: unknown,
  createdAt: string,
): Promise<void> {
  await conn.execute({
    sql: `INSERT INTO paper_card_events (card_id, seq, event_type, from_status, to_status, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [cardId, await nextSeq(conn, 'paper_card_events', cardId), eventType,
      fromStatus, toStatus, JSON.stringify(payload ?? {}), createdAt],
  })
}

export interface ReservationRequest {
  kind: 'cash' | 'shares'
  amountCents?: number
  qty?: number
  symbolCode?: string
}

export interface ConfirmPaperOrderInput {
  id?: string
  experimentId?: string
  accountId: string
  actor?: 'user' | 'shadow'
  cardId: string | null
  cardVersion?: number | null
  symbolCode: string
  side: PaperSide
  orderType: PaperOrderType
  qty: number
  conditionOp?: 'lte' | 'gte' | null
  triggerPriceCents?: number | null
  clientRequestId: string
  idempotencyKey: string
  requestHash: string
  targetTradeDate: string
  offPlanReason?: string | null
  reservations?: ReservationRequest[]
  confirmedAt?: string
  cutoffAt?: string | null
  /** 影子账户复用同一张卡下单，但不推进卡状态（卡状态只反映用户侧动作）。 */
  mutateCard?: boolean
}

export interface ConfirmPaperOrderResult {
  order: PaperOrderRow
  replayed: boolean
}

function validateConfirmInput(input: ConfirmPaperOrderInput): void {
  if (!Number.isSafeInteger(input.qty) || input.qty <= 0) {
    throw new PaperRepoError('INVALID_INPUT', `委托股数非法: ${input.qty}`)
  }
  if (!input.symbolCode?.trim()) throw new PaperRepoError('INVALID_INPUT', '缺少标的代码')
  if (!input.clientRequestId?.trim()) throw new PaperRepoError('INVALID_INPUT', '缺少 client_request_id')
  if (!input.idempotencyKey?.trim()) throw new PaperRepoError('INVALID_INPUT', '缺少幂等键')
  if (!input.requestHash?.trim()) throw new PaperRepoError('INVALID_INPUT', '缺少请求哈希')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetTradeDate)) {
    throw new PaperRepoError('INVALID_INPUT', `目标交易日格式错误: ${input.targetTradeDate}`)
  }
  if (input.side === 'buy' && !input.cardId) {
    throw new PaperRepoError('INVALID_INPUT', '买入委托必须绑定决策卡')
  }
  if (input.orderType === 'open_price_condition' && !(input.triggerPriceCents && input.triggerPriceCents > 0)) {
    throw new PaperRepoError('INVALID_INPUT', '条件单必须带正数触发价')
  }
  for (const r of input.reservations ?? []) {
    if (r.kind === 'cash' && (!(r.amountCents && r.amountCents > 0))) {
      throw new PaperRepoError('INVALID_INPUT', '现金冻结必须为正数分')
    }
    if (r.kind === 'shares' && (!(r.qty && r.qty > 0) || !(r.symbolCode || input.symbolCode))) {
      throw new PaperRepoError('INVALID_INPUT', '股数冻结必须带正数股数与代码')
    }
  }
}

async function findOrderByKeys(
  conn: Conn,
  accountId: string,
  idempotencyKey: string,
  clientRequestId: string,
): Promise<PaperOrderRow | null> {
  const r = await conn.execute({
    sql: `SELECT * FROM paper_orders
          WHERE account_id = ? AND (idempotency_key = ? OR client_request_id = ?) LIMIT 1`,
    args: [accountId, idempotencyKey, clientRequestId],
  })
  return r.rows.length ? mapOrder(r.rows[0]) : null
}

function replayOrConflict(existing: PaperOrderRow, input: ConfirmPaperOrderInput): ConfirmPaperOrderResult {
  if (existing.idempotencyKey === input.idempotencyKey && existing.requestHash === input.requestHash) {
    return { order: existing, replayed: true }
  }
  throw new PaperRepoError('IDEMPOTENCY_CONFLICT',
    '相同幂等键/请求号携带了不同请求内容，拒绝覆盖')
}

export async function confirmPaperOrder(input: ConfirmPaperOrderInput): Promise<ConfirmPaperOrderResult> {
  validateConfirmInput(input)
  const db = await getDb()
  const account = await getPaperAccount(input.accountId)
  if (!account) throw new PaperRepoError('NOT_FOUND', `账户不存在: ${input.accountId}`)
  if (account.status !== 'active') throw new PaperRepoError('INVALID_STATE', `账户未激活: ${account.status}`)
  if (input.experimentId && input.experimentId !== account.experimentId) {
    throw new PaperRepoError('INVALID_INPUT', '账户与实验不匹配')
  }

  const now = input.confirmedAt ?? new Date().toISOString()
  const id = input.id ?? `ord-${crypto.randomUUID()}`

  // 幂等重放优先返回原单；只有新请求才受截止时间与风控约束。
  const existingBefore = await findOrderByKeys(db, input.accountId, input.idempotencyKey, input.clientRequestId)
  if (existingBefore) return replayOrConflict(existingBefore, input)
  assertBeforeCutoff(input.targetTradeDate, now)
  await assertConfirmRisk(input, account.experimentId)

  const tx = await db.transaction('write')
  try {
    const existing = await findOrderByKeys(tx, input.accountId, input.idempotencyKey, input.clientRequestId)
    if (existing) {
      await tx.rollback()
      return replayOrConflict(existing, input)
    }

    if (input.cardId) {
      const cardR = await tx.execute({
        sql: `SELECT id, experiment_id, symbol_code, card_version, status, trade_date
              FROM paper_decision_cards WHERE id = ?`,
        args: [input.cardId],
      })
      if (!cardR.rows.length) throw new PaperRepoError('NOT_FOUND', `决策卡不存在: ${input.cardId}`)
      const card = cardR.rows[0]
      if (str(card.experiment_id) !== account.experimentId) {
        throw new PaperRepoError('INVALID_INPUT', '决策卡属于其他实验')
      }
      if (str(card.symbol_code) !== input.symbolCode) {
        throw new PaperRepoError('INVALID_INPUT', '决策卡与委托标的不一致')
      }
      if (str(card.trade_date) !== input.targetTradeDate) {
        throw new PaperRepoError('INVALID_INPUT',
          `决策卡交易日 ${str(card.trade_date)} 与委托目标日 ${input.targetTradeDate} 不一致`)
      }
      const cardStatus = str(card.status)
      const allowed = input.mutateCard === false
        ? ['active', 'triggered', 'confirmed']
        : ['active', 'triggered']
      if (!allowed.includes(cardStatus)) {
        throw new PaperRepoError('INVALID_STATE', `决策卡不可确认: ${cardStatus}`)
      }
      if (input.cardVersion != null && input.cardVersion !== num(card.card_version)) {
        throw new PaperRepoError('INVALID_STATE',
          `决策卡版本已变化: ${input.cardVersion} -> ${num(card.card_version)}`)
      }
      if (input.mutateCard !== false) {
        await tx.execute({
          sql: `UPDATE paper_decision_cards SET status = 'confirmed', updated_at = ?
                WHERE id = ? AND status IN ('active','triggered')`,
          args: [now, input.cardId],
        })
        await insertCardEvent(tx, input.cardId, 'confirmed', cardStatus, 'confirmed',
          { orderId: id, actor: input.actor ?? 'user' }, now)
      }
    }

    await tx.execute({
      sql: `INSERT INTO paper_orders
        (id, experiment_id, account_id, card_id, card_version, actor, symbol_code, side, order_type,
         qty, condition_op, trigger_price_cents, status, client_request_id, idempotency_key,
         request_hash, target_trade_date, off_plan_reason, is_demo, confirmed_at, cutoff_at,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, account.experimentId, input.accountId, input.cardId,
        input.cardVersion ?? null, input.actor ?? 'user', input.symbolCode, input.side,
        input.orderType, input.qty, input.conditionOp ?? null, input.triggerPriceCents ?? null,
        input.clientRequestId, input.idempotencyKey, input.requestHash, input.targetTradeDate,
        input.offPlanReason ?? null, account.isDemo ? 1 : 0, now, input.cutoffAt ?? null, now, now,
      ],
    })
    await insertOrderEvent(tx, id, 'confirmed', null, 'confirmed',
      { qty: input.qty, side: input.side, symbolCode: input.symbolCode }, now)

    for (const reservation of input.reservations ?? []) {
      const symbolCode = reservation.kind === 'shares'
        ? (reservation.symbolCode ?? input.symbolCode)
        : null
      await tx.execute({
        sql: `INSERT INTO paper_reservations
          (id, account_id, order_id, kind, symbol_code, amount_cents, qty, status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)`,
        args: [
          `res-${id}-${reservation.kind}`, input.accountId, id, reservation.kind, symbolCode,
          reservation.kind === 'cash' ? reservation.amountCents ?? 0 : 0,
          reservation.kind === 'shares' ? reservation.qty ?? 0 : 0, now,
        ],
      })
    }

    // 冻结后可用现金/可卖股数不得为负；越界说明上游风控算错，直接回滚。
    await refreshPaperAccountCash(tx, input.accountId)
    await refreshPaperPositions(tx, input.accountId, input.targetTradeDate)
    await writePaperAudit(tx, {
      actor: input.actor ?? 'user',
      action: 'order.confirmed',
      entityType: 'paper_order',
      entityId: id,
      requestHash: input.requestHash,
      cardId: input.cardId,
      orderId: id,
      payload: { symbolCode: input.symbolCode, side: input.side, qty: input.qty, targetTradeDate: input.targetTradeDate },
      createdAt: now,
    })
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }

  const order = await getPaperOrder(id)
  if (!order) throw new PaperRepoError('NOT_FOUND', '委托创建后读取失败')
  return { order, replayed: false }
}

export async function cancelPaperOrder(input: { orderId: string; now?: string }): Promise<boolean> {
  const order = await getPaperOrder(input.orderId)
  if (!order) throw new PaperRepoError('NOT_FOUND', `委托不存在: ${input.orderId}`)
  if (order.status !== 'confirmed') return false

  const db = await getDb()
  const now = input.now ?? new Date().toISOString()
  assertBeforeCutoff(order.targetTradeDate, now)
  const tx = await db.transaction('write')
  try {
    const guard = await tx.execute({
      sql: `UPDATE paper_orders SET status = 'canceled', updated_at = ?
            WHERE id = ? AND status = 'confirmed'`,
      args: [now, input.orderId],
    })
    if (guard.rowsAffected === 0) {
      await tx.rollback()
      return false
    }
    await tx.execute({
      sql: `UPDATE paper_reservations SET status = 'released', released_at = ?
            WHERE order_id = ? AND status = 'held'`,
      args: [now, input.orderId],
    })
    await insertOrderEvent(tx, input.orderId, 'canceled', 'confirmed', 'canceled', {}, now)
    if (order.cardId) {
      const cardGuard = await tx.execute({
        sql: `UPDATE paper_decision_cards SET status = 'active', updated_at = ?
              WHERE id = ? AND status = 'confirmed'`,
        args: [now, order.cardId],
      })
      if (cardGuard.rowsAffected > 0) {
        await insertCardEvent(tx, order.cardId, 'reopened', 'confirmed', 'active',
          { orderId: input.orderId }, now)
      }
    }
    await refreshPaperAccountCash(tx, order.accountId)
    await refreshPaperPositions(tx, order.accountId, order.targetTradeDate)
    await writePaperAudit(tx, {
      actor: 'user',
      action: 'order.canceled',
      entityType: 'paper_order',
      entityId: input.orderId,
      cardId: order.cardId,
      orderId: input.orderId,
      createdAt: now,
    })
    await tx.commit()
    return true
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }
}

const CONFIRM_CUTOFF = 'T09:15:00+08:00'

/** 09:15 后不再接受新的确认或撤销；已确认的委托进入冻结，等 16:20 结算。 */
function assertBeforeCutoff(tradeDate: string, at: string): void {
  const cutoffMs = Date.parse(`${tradeDate}${CONFIRM_CUTOFF}`)
  if (!Number.isFinite(cutoffMs) || Date.parse(at) >= cutoffMs) {
    throw new PaperRepoError('TOO_LATE', `已过 ${tradeDate} 09:15 确认截止，委托不能再提交或撤销`)
  }
}

/** 确认时点风控：仓位/行业/流动性/现金/当日笔数/回撤全部再过一遍，规则与卡生成同源。 */
async function assertConfirmRisk(input: ConfirmPaperOrderInput, experimentId: string): Promise<void> {
  const { policy } = await getPaperExperimentPolicy(experimentId)
  const riskState = await getPaperRiskState(input.accountId)
  const snapshot = await loadPaperRiskSnapshot({
    accountId: input.accountId,
    tradeDate: input.targetTradeDate,
  })
  const symbolContext = await loadPaperSymbolContext(input.symbolCode, input.targetTradeDate)

  let cardRisk: { confidenceScore: number | null; stopPriceCents: number | null; maxLossCents: number | null } | null = null
  if (input.cardId) {
    const db = await getDb()
    const r = await db.execute({
      sql: 'SELECT confidence_score, stop_price_cents, max_loss_cents FROM paper_decision_cards WHERE id = ?',
      args: [input.cardId],
    })
    if (r.rows.length) {
      cardRisk = {
        confidenceScore: r.rows[0].confidence_score == null ? null : num(r.rows[0].confidence_score),
        stopPriceCents: r.rows[0].stop_price_cents == null ? null : num(r.rows[0].stop_price_cents),
        maxLossCents: r.rows[0].max_loss_cents == null ? null : num(r.rows[0].max_loss_cents),
      }
    }
  }

  // 限价买不可能成交在触发价之上；市价买按最近收盘价加滑点估上限。
  const lastCloseCents = symbolContext.lastCloseCents ?? 0
  const priceCents = input.orderType === 'open_price_condition' && input.triggerPriceCents
    ? input.triggerPriceCents
    : lastCloseCents > 0
      ? reserveBuyPriceCents(lastCloseCents, policy.fees.slippagePpm)
      : 0
  if (input.side === 'buy' && priceCents <= 0) {
    throw new PaperRepoError('MISSING_PRICE', `缺少 ${input.symbolCode} 最近收盘价，无法核对仓位与现金`)
  }
  const grossCents = input.qty * priceCents
  const fees = priceCents > 0 ? calcFees(input.side, input.qty, priceCents, priceCents, policy.fees) : null

  if (input.side === 'buy' && fees) {
    const reservedCash = (input.reservations ?? [])
      .filter((r) => r.kind === 'cash')
      .reduce((sum, r) => sum + (r.amountCents ?? 0), 0)
    if (reservedCash < grossCents + fees.totalFeesCents) {
      throw new PaperRepoError('INVALID_INPUT',
        `冻结现金不足：按最大成交价需要 ${grossCents + fees.totalFeesCents} 分，实际 ${reservedCash} 分`)
    }
  }

  const isNewPosition = input.side === 'buy'
    && !snapshot.positions.some((p) => p.symbolCode === input.symbolCode && p.totalQty > 0)

  const evaluation = evaluateRisk({
    checkpoint: 'confirm',
    policy,
    gate: {
      killSwitch: riskState.killSwitch,
      killReason: riskState.killReason,
      blocksSells: riskState.killReason === 'LEDGER_MISMATCH',
      dataQuality: riskState.dataQuality,
    },
    ledger: {
      navCents: snapshot.navCents,
      cashCents: snapshot.cashCents,
      positions: snapshot.positions,
      dailyOrders: snapshot.dailyOrders,
      dailyNewPositions: snapshot.dailyNewPositions,
      dailyLossBp: snapshot.dailyLossBp,
      drawdownBp: snapshot.drawdownBp,
      missingPriceSymbols: snapshot.missingPriceSymbols,
    },
    proposal: {
      symbolCode: input.symbolCode,
      industryCode: symbolContext.meta?.industryCode ?? null,
      side: input.side,
      qty: input.qty,
      priceCents,
      grossCents,
      feesCents: fees?.totalFeesCents ?? 0,
      stopPriceCents: cardRisk?.stopPriceCents ?? null,
      maxLossCents: cardRisk?.maxLossCents ?? null,
      board: symbolContext.meta?.board ?? null,
      lotSize: symbolContext.meta?.lotSize ?? 0,
      isNewPosition,
      confidenceScore: cardRisk?.confidenceScore ?? null,
    },
    market: {
      meta: symbolContext.meta,
      status: symbolContext.status,
      adv20Cents: symbolContext.adv20Cents,
      listedTradingDays: symbolContext.listedTradingDays,
    },
  })
  if (!evaluation.ok) {
    const first = evaluation.violations[0]
    throw new PaperRepoError('RISK_REJECTED', `风控拒绝：${first.message}（${first.reasonCode}）`, {
      reasonCode: first.reasonCode,
      violations: evaluation.violations,
    })
  }
}

/** 09:15 冻结：之后不可取消，16:20 结算只处理已冻结/已确认委托。 */
export async function freezePaperOrders(input: {
  experimentId: string
  tradeDate: string
  at?: string
}): Promise<number> {
  const db = await getDb()
  const at = input.at ?? new Date().toISOString()
  const r = await db.execute({
    sql: `UPDATE paper_orders SET status = 'settlement_pending', cutoff_at = ?, updated_at = ?
          WHERE experiment_id = ? AND target_trade_date = ? AND status = 'confirmed'`,
    args: [at, at, input.experimentId, input.tradeDate],
  })
  return r.rowsAffected ?? 0
}

export interface SettlePaperOrderResult {
  applied: boolean
  orderId: string
  reason?: 'NOT_PENDING' | 'ACCOUNT_INACTIVE' | 'STATE_CHANGED' | 'FATAL_LEDGER' | 'ERROR'
  decision?: SettlementDecision
}

export async function settlePaperOrder(input: {
  orderId: string
  settledAt?: string
  dataQuality?: DataQuality
}): Promise<SettlePaperOrderResult> {
  const settledAt = input.settledAt ?? new Date().toISOString()
  const order = await getPaperOrder(input.orderId)
  if (!order) throw new PaperRepoError('NOT_FOUND', `委托不存在: ${input.orderId}`)
  if (order.status !== 'confirmed' && order.status !== 'settlement_pending') {
    return { applied: false, orderId: order.id, reason: 'NOT_PENDING' }
  }

  const account = await getPaperAccount(order.accountId)
  if (!account) throw new PaperRepoError('NOT_FOUND', `账户不存在: ${order.accountId}`)
  if (account.status !== 'active') {
    return { applied: false, orderId: order.id, reason: 'ACCOUNT_INACTIVE' }
  }
  const experiment = await getPaperExperiment(order.experimentId)
  if (!experiment) throw new PaperRepoError('NOT_FOUND', `实验不存在: ${order.experimentId}`)
  if (experiment.status !== 'active') {
    return { applied: false, orderId: order.id, reason: 'ACCOUNT_INACTIVE' }
  }

  const { policy } = await getPaperExperimentPolicy(order.experimentId)
  const card = order.cardId ? await getPaperCard(order.cardId) : null
  const { meta, market } = await loadPaperMarketInputs(order.symbolCode, order.targetTradeDate)
  const isTradingDay = await isPaperTradingDay(order.targetTradeDate)
  const ledger = await loadPaperLedger(order.accountId)

  let position = { totalQty: 0, availableQty: 0, frozenQty: 0 }
  try {
    const positions = derivePositions({
      lots: ledger.lots,
      closes: ledger.closes,
      reservations: ledger.reservations,
      tradeDate: order.targetTradeDate,
    })
    position = positions.find((p) => p.symbolCode === order.symbolCode) ?? position
  } catch (err) {
    if (err instanceof PaperLedgerError) {
      await setPaperKillSwitch({
        accountId: order.accountId,
        reason: 'LEDGER_MISMATCH',
        now: settledAt,
      })
      await recordPaperRiskEvent(await getDb(), {
        accountId: order.accountId,
        rule: 'ledger_state',
        severity: 'block',
        action: 'kill_switch',
        message: `持仓派生失败: ${err.message}`,
        dataQuality: 'fail',
        orderId: order.id,
        createdAt: settledAt,
      })
      return { applied: false, orderId: order.id, reason: 'FATAL_LEDGER' }
    }
    throw err
  }

  const orderReservations = ledger.reservations.filter((r) => r.orderId === order.id && r.status === 'held')
  const reservedCashCents = orderReservations
    .filter((r) => r.kind === 'cash')
    .reduce((sum, r) => sum + r.amountCents, 0)
  const reservedShareQty = orderReservations
    .filter((r) => r.kind === 'shares' && (!r.symbolCode || r.symbolCode === order.symbolCode))
    .reduce((sum, r) => sum + r.qty, 0)

  const riskState = await getPaperRiskState(order.accountId)
  const navCents = await getPaperNavCents(order.accountId, order.targetTradeDate) ?? 0

  const decision = planSettlement({
    order: {
      id: order.id,
      accountId: order.accountId,
      cardId: order.cardId,
      cardVersion: order.cardVersion,
      symbolCode: order.symbolCode,
      side: order.side,
      orderType: order.orderType,
      qty: order.qty,
      conditionOp: order.conditionOp,
      triggerPriceCents: order.triggerPriceCents,
      targetTradeDate: order.targetTradeDate,
    },
    card: card
      ? {
          id: card.id,
          version: card.version,
          // 影子单自己就是确认动作，卡状态仍归用户侧；否则结算会因卡未确认被拒。
          status: order.actor === 'shadow' ? 'confirmed' : card.status,
          symbolCode: card.symbolCode,
          stopPriceCents: card.stopPriceCents,
          maxLossCents: card.maxLossCents,
        }
      : null,
    meta,
    board: meta?.board ?? null,
    market,
    isTradingDay,
    // 账户持久化的数据质量 fail 必须延续到对账清除为止，否则停牌/缺价窗口内仍会成交。
    dataQuality: input.dataQuality ?? riskState.dataQuality,
    risk: {
      killSwitch: riskState.killSwitch,
      killSwitchReason: (riskState.killReason || null) as PaperReasonCode | null,
      blocksSells: riskState.killReason === 'LEDGER_MISMATCH',
    },
    navCents,
    position,
    lots: ledger.lots,
    closes: ledger.closes,
    pendingDividendGrossByLot: await loadPendingDividendGrossByLot(order.accountId),
    reservedCashCents,
    reservedShareQty,
    cashLedgerBeforeCents: ledger.cashTotalCents,
    policy,
    settledAt,
  })

  const db = await getDb()
  const tx = await db.transaction('write')
  try {
    const currentR = await tx.execute({
      sql: 'SELECT status FROM paper_orders WHERE id = ?',
      args: [order.id],
    })
    const currentStatus = str(currentR.rows[0]?.status, order.status)
    const guard = await tx.execute({
      sql: `UPDATE paper_orders SET status = ?, reject_code = ?, reject_detail = ?, settled_at = ?, updated_at = ?
            WHERE id = ? AND status IN ('confirmed','settlement_pending')`,
      args: [decision.nextOrderStatus, decision.reasonCode, decision.detail, settledAt, settledAt, order.id],
    })
    if (guard.rowsAffected === 0) {
      await tx.rollback()
      return { applied: false, orderId: order.id, reason: 'STATE_CHANGED', decision }
    }

    await insertOrderEvent(tx, order.id, 'settled', currentStatus, decision.nextOrderStatus, {
      outcome: decision.outcome,
      reasonCode: decision.reasonCode,
      detail: decision.detail,
    }, settledAt)

    // 影子单不推进用户侧的卡状态；卡由用户确认/截止时统一收口。
    if (decision.nextCardStatus && order.cardId && order.actor === 'user') {
      const cardGuard = await tx.execute({
        sql: `UPDATE paper_decision_cards SET status = ?, updated_at = ?
              WHERE id = ? AND status = 'confirmed'`,
        args: [decision.nextCardStatus, settledAt, order.cardId],
      })
      if (cardGuard.rowsAffected > 0) {
        await insertCardEvent(tx, order.cardId, 'settled', 'confirmed', decision.nextCardStatus,
          { orderId: order.id, outcome: decision.outcome }, settledAt)
      }
    }

    if (decision.outcome === 'fill' && decision.fill) {
      const fill = decision.fill
      await tx.execute({
        sql: `INSERT INTO paper_fills
          (id, order_id, experiment_id, account_id, symbol_code, side, qty, price_cents, gross_cents,
           commission_cents, stamp_tax_cents, transfer_fee_cents, slippage_cents, total_fees_cents,
           trade_date, trade_time, settled_at, price_basis, price_source_id, bar_fetched_at, bar_hash,
           snapshot_id, is_demo, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          fill.id, order.id, order.experimentId, order.accountId, fill.symbolCode, fill.side,
          fill.qty, fill.priceCents, fill.grossCents, fill.commissionCents, fill.stampTaxCents,
          fill.transferFeeCents, fill.slippageCents, fill.totalFeesCents, fill.tradeDate,
          fill.tradeTime, fill.settledAt, fill.priceBasis, fill.priceSourceId, fill.barFetchedAt ?? null,
          fill.barHash ?? null, card?.snapshotId ?? null, account.isDemo ? 1 : 0, settledAt,
        ],
      })
      for (const entry of decision.cashEntries ?? []) {
        await tx.execute({
          sql: `INSERT INTO paper_cash_entries
            (id, account_id, kind, amount_cents, balance_after_cents, ref_type, ref_id, order_id,
             fill_id, trade_date, memo, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            entry.id, order.accountId, entry.kind, entry.amountCents, entry.balanceAfterCents,
            entry.refType, entry.refId, entry.orderId, entry.fillId, fill.tradeDate,
            entry.memo ?? null, settledAt,
          ],
        })
      }
      if (decision.lot) {
        await tx.execute({
          sql: `INSERT INTO paper_tax_lots
            (id, account_id, symbol_code, open_fill_id, open_date, qty, cost_total_cents, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            decision.lot.id, order.accountId, decision.lot.symbolCode, decision.lot.openFillId,
            decision.lot.openDate, decision.lot.qtyOpened, decision.lot.costTotalCents, settledAt,
          ],
        })
      }
      for (const close of decision.lotCloses ?? []) {
        await tx.execute({
          sql: `INSERT INTO paper_lot_closes
            (id, sell_fill_id, lot_id, qty, cost_cents, proceeds_cents, realized_pnl_cents,
             holding_days, dividend_tax_cents, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            close.id, close.sellFillId, close.lotId, close.qty, close.costCents,
            close.proceedsCents, close.realizedPnlCents, close.holdingDays,
            close.dividendTaxCents, settledAt,
          ],
        })
      }
      await tx.execute({
        sql: `UPDATE paper_reservations SET status = 'consumed', released_at = ?
              WHERE order_id = ? AND status = 'held'`,
        args: [settledAt, order.id],
      })
    } else {
      await tx.execute({
        sql: `UPDATE paper_reservations SET status = 'released', released_at = ?
              WHERE order_id = ? AND status = 'held'`,
        args: [settledAt, order.id],
      })
    }

    await refreshPaperAccountCash(tx, order.accountId)
    await refreshPaperPositions(tx, order.accountId, order.targetTradeDate)

    if (decision.fatalLedger) {
      await tx.execute({
        sql: `INSERT INTO paper_risk_state (account_id, kill_switch, kill_reason, kill_since, updated_at)
              VALUES (?, 1, 'LEDGER_MISMATCH', ?, ?)
              ON CONFLICT(account_id) DO UPDATE SET
                kill_switch = 1, kill_reason = 'LEDGER_MISMATCH',
                kill_since = COALESCE(paper_risk_state.kill_since, excluded.kill_since),
                updated_at = excluded.updated_at`,
        args: [order.accountId, settledAt, settledAt],
      })
      await recordPaperRiskEvent(tx, {
        accountId: order.accountId,
        rule: 'ledger_state',
        severity: 'block',
        action: 'kill_switch',
        message: decision.detail,
        dataQuality: 'fail',
        orderId: order.id,
        createdAt: settledAt,
      })
    }

    await writePaperAudit(tx, {
      actor: order.actor,
      action: 'order.settled',
      entityType: 'paper_order',
      entityId: order.id,
      cardId: order.cardId,
      orderId: order.id,
      payload: {
        outcome: decision.outcome,
        nextOrderStatus: decision.nextOrderStatus,
        nextCardStatus: decision.nextCardStatus,
        reasonCode: decision.reasonCode,
        fillId: decision.fill?.id ?? null,
      },
      createdAt: settledAt,
    })
    await tx.commit()
  } catch (err) {
    await tx.rollback().catch(() => {})
    throw err
  }

  if (decision.reasonCode === 'MISSING_PRICE') {
    await setPaperMissingPriceState({
      accountId: order.accountId,
      since: order.targetTradeDate,
      now: settledAt,
    })
    await recordPaperRiskEvent(await getDb(), {
      accountId: order.accountId,
      rule: 'missing_price',
      severity: 'block',
      action: 'block_buys',
      message: `结算缺少 ${order.symbolCode} 官方开盘价，委托按缺价过期`,
      dataQuality: 'fail',
      orderId: order.id,
      cardId: order.cardId,
      createdAt: settledAt,
    })
  }

  return { applied: true, orderId: order.id, decision }
}

export interface SettleBatchResult {
  settled: number
  failed: number
  skipped: number
  results: SettlePaperOrderResult[]
}

export async function settlePaperOrders(input: {
  experimentId: string
  tradeDate: string
  settledAt?: string
  dataQuality?: DataQuality
}): Promise<SettleBatchResult> {
  const db = await getDb()
  const r = await db.execute({
    sql: `SELECT id FROM paper_orders
          WHERE experiment_id = ? AND target_trade_date = ?
            AND status IN ('confirmed','settlement_pending')
          ORDER BY created_at, id`,
    args: [input.experimentId, input.tradeDate],
  })
  const results: SettlePaperOrderResult[] = []
  let settled = 0
  let failed = 0
  let skipped = 0
  for (const row of r.rows) {
    try {
      const result = await settlePaperOrder({
        orderId: str(row.id),
        settledAt: input.settledAt,
        dataQuality: input.dataQuality,
      })
      results.push(result)
      if (result.applied) settled += 1
      else skipped += 1
    } catch (err) {
      failed += 1
      results.push({ applied: false, orderId: str(row.id), reason: 'ERROR' })
      console.error(`[paper] 结算失败 ${str(row.id)}:`, (err as Error).message)
    }
  }
  return { settled, failed, skipped, results }
}
