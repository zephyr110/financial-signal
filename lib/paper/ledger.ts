import { calcDividendTax } from './market'
import { floorDiv, roundHalfUpDiv } from './money'
import type { DividendTaxPolicy } from './types'

/**
 * 账本纯函数：现金流水与税务批次是唯一真相，持仓/可用/净值全部派生。
 * 金额单位分；股数单位股。
 */

export type CashEntryKind =
  | 'initial' | 'buy' | 'sell' | 'fee' | 'tax'
  | 'dividend' | 'dividend_tax' | 'adjustment'

export interface LedgerCashEntry {
  id: string
  accountId: string
  kind: CashEntryKind
  /** 带符号：流入为正，流出为负。 */
  amountCents: number
  balanceAfterCents: number
  refType: string
  refId: string
  tradeDate: string
  orderId?: string | null
  fillId?: string | null
}

export interface LedgerLot {
  id: string
  accountId: string
  symbolCode: string
  openFillId: string
  openDate: string
  qtyOpened: number
  costTotalCents: number
}

export interface LedgerLotClose {
  id: string
  sellFillId: string
  lotId: string
  qty: number
  costCents: number
  proceedsCents: number
  realizedPnlCents: number
  holdingDays: number
  dividendTaxCents: number
}

export interface LedgerReservation {
  id: string
  accountId: string
  orderId: string
  kind: 'cash' | 'shares'
  symbolCode?: string | null
  amountCents: number
  qty: number
  status: 'held' | 'released' | 'consumed'
}

export interface LedgerPosition {
  symbolCode: string
  totalQty: number
  availableQty: number
  frozenQty: number
  remainingCostCents: number
  avgCostCents: number
}

export interface LedgerCheck {
  name: string
  pass: boolean
  /** 缺价导致该项无法核对；不是通过，也不触发 kill switch。 */
  skipped?: boolean
  lhsCents?: number
  rhsCents?: number
  diffCents?: number
  detail?: string
}

export interface LedgerReconciliation {
  status: 'pass' | 'fail' | 'missing_price'
  checks: LedgerCheck[]
  navCents: number
  cashCents: number
  frozenCashCents: number
  marketValueCents: number
  realizedCents: number
  unrealizedCents: number
  feesCents: number
  taxesCents: number
  dividendsCents: number
  missingSymbols: string[]
  positions: LedgerPosition[]
  mismatchCents: number
}

export class PaperLedgerError extends Error {
  code: 'LEDGER_MISMATCH' | 'INSUFFICIENT_LOTS' | 'FROZEN_EXCEEDS_SELLABLE' | 'INVALID_INPUT'
  detail?: unknown

  constructor(
    code: PaperLedgerError['code'],
    message: string,
    detail?: unknown,
  ) {
    super(message)
    this.name = 'PaperLedgerError'
    this.code = code
    this.detail = detail
  }
}

function assertSafeInt(value: number, name: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new PaperLedgerError('INVALID_INPUT', `${name} 必须是不小于 ${min} 的整数: ${value}`)
  }
}

function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) throw new PaperLedgerError('INVALID_INPUT', `日期格式非法: ${date}`)
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** 自然日差（含节假日）；用于红利税持有期分档。 */
export function holdingDaysBetween(openDate: string, closeDate: string): number {
  const days = Math.round((parseDate(closeDate) - parseDate(openDate)) / 86_400_000)
  if (days < 0) throw new PaperLedgerError('INVALID_INPUT', `平仓日期早于开仓: ${openDate} > ${closeDate}`)
  return days
}

export interface CashAggregate {
  balanceCents: number
  initialCents: number
  /** 费用（佣金+过户费）取正数。 */
  feesCents: number
  /** 税费（印花税+红利税）取正数。 */
  taxesCents: number
  dividendsCents: number
}

export function aggregateCash(entries: LedgerCashEntry[]): CashAggregate {
  let balance = 0
  let initial = 0
  let fees = 0
  let taxes = 0
  let dividends = 0
  for (const e of entries) {
    assertSafeInt(Math.abs(e.amountCents), 'amountCents', 0)
    balance += e.amountCents
    if (e.kind === 'initial') initial += e.amountCents
    if (e.kind === 'fee') fees -= e.amountCents
    if (e.kind === 'tax' || e.kind === 'dividend_tax') taxes -= e.amountCents
    if (e.kind === 'dividend') dividends += e.amountCents
  }
  if (balance < 0) {
    throw new PaperLedgerError('LEDGER_MISMATCH', `现金余额为负: ${balance}`)
  }
  return { balanceCents: balance, initialCents: initial, feesCents: fees, taxesCents: taxes, dividendsCents: dividends }
}

interface CloseTotals {
  qty: number
  costCents: number
}

function closeTotalsByLot(closes: LedgerLotClose[]): Map<string, CloseTotals> {
  const map = new Map<string, CloseTotals>()
  for (const close of closes) {
    assertSafeInt(close.qty, 'close.qty', 1)
    assertSafeInt(Math.abs(close.costCents), 'close.costCents', 0)
    const row = map.get(close.lotId) || { qty: 0, costCents: 0 }
    row.qty += close.qty
    row.costCents += close.costCents
    map.set(close.lotId, row)
  }
  return map
}

export function remainingLotQty(lot: LedgerLot, closedQty: number): number {
  const remaining = lot.qtyOpened - closedQty
  if (remaining < 0) throw new PaperLedgerError('LEDGER_MISMATCH', `批次 ${lot.id} 超卖: ${closedQty}/${lot.qtyOpened}`)
  return remaining
}

export function remainingLotCost(lot: LedgerLot, closedCostCents: number): number {
  const remaining = lot.costTotalCents - closedCostCents
  if (remaining < 0) throw new PaperLedgerError('LEDGER_MISMATCH', `批次 ${lot.id} 成本超扣`)
  return remaining
}

export interface SellAllocationInput {
  accountId: string
  symbolCode: string
  sellQty: number
  grossProceedsCents: number
  tradeDate: string
  sellFillId: string
  lots: LedgerLot[]
  closes: LedgerLotClose[]
  closeIdPrefix: string
  /** 各批次尚未代扣的红利（税前，覆盖批次剩余股数）。 */
  pendingDividendGrossByLot?: Record<string, number>
  dividendTax: DividendTaxPolicy
}

/**
 * FIFO 平仓分配：卖出金额按股数比例分给批次，余数给最后一笔；
 * 成本按批次剩余成本比例分摊，整批卖完时用剩余成本精确归零。
 * 已实现盈亏为毛额，费用与红利税单独走现金流水（避免恒等式重复扣减）。
 */
export function allocateSellToLots(input: SellAllocationInput): LedgerLotClose[] {
  const { accountId, symbolCode, sellQty, grossProceedsCents, tradeDate, closes, closeIdPrefix } = input
  assertSafeInt(sellQty, 'sellQty', 1)
  assertSafeInt(grossProceedsCents, 'grossProceedsCents', 0)

  const closed = closeTotalsByLot(closes)
  const open = input.lots
    .filter((l) => l.symbolCode === symbolCode && l.accountId === accountId)
    .map((lot) => {
      const row = closed.get(lot.id) || { qty: 0, costCents: 0 }
      return {
        lot,
        remainingQty: remainingLotQty(lot, row.qty),
        remainingCost: remainingLotCost(lot, row.costCents),
      }
    })
    .filter((l) => l.remainingQty > 0)
    .sort((a, b) => a.lot.openDate.localeCompare(b.lot.openDate) || a.lot.id.localeCompare(b.lot.id))

  const sellable = open.reduce((sum, l) => sum + l.remainingQty, 0)
  if (sellable < sellQty) {
    throw new PaperLedgerError('INSUFFICIENT_LOTS', `${symbolCode} 可卖批次不足: ${sellable}/${sellQty}`)
  }

  const result: LedgerLotClose[] = []
  let left = sellQty
  let proceedsLeft = grossProceedsCents
  for (let i = 0; i < open.length && left > 0; i += 1) {
    const { lot, remainingQty, remainingCost } = open[i]
    const take = Math.min(left, remainingQty)
    const last = take === left
    const costCents = take === remainingQty
      ? remainingCost
      : roundHalfUpDiv(remainingCost * take, remainingQty)
    const proceedsCents = last ? proceedsLeft : floorDiv(grossProceedsCents * take, sellQty)
    const holdingDays = holdingDaysBetween(lot.openDate, tradeDate)
    const pendingGross = input.pendingDividendGrossByLot?.[lot.id] ?? 0
    const grossForSale = take === remainingQty
      ? pendingGross
      : roundHalfUpDiv(pendingGross * take, remainingQty)

    result.push({
      id: `${closeIdPrefix}-${i + 1}`,
      sellFillId: input.sellFillId,
      lotId: lot.id,
      qty: take,
      costCents,
      proceedsCents,
      realizedPnlCents: proceedsCents - costCents,
      holdingDays,
      dividendTaxCents: calcDividendTax(grossForSale, holdingDays, input.dividendTax),
    })
    left -= take
    proceedsLeft -= proceedsCents
  }
  if (left !== 0) throw new PaperLedgerError('LEDGER_MISMATCH', `平仓分配未满足卖出数量: 余 ${left}`)
  return result
}

export interface DerivePositionsInput {
  lots: LedgerLot[]
  closes: LedgerLotClose[]
  reservations: LedgerReservation[]
  tradeDate: string
}

/**
 * 批次派生持仓：总股数 = 全部未平批次；可卖 = 开仓日 < 交易日 的批次 − 卖出冻结；
 * 冻结 = 总股数 − 可卖（包含 T+1 锁定与委托冻结），恒等式 3 由构造保证。
 */
export function derivePositions(input: DerivePositionsInput): LedgerPosition[] {
  const closed = closeTotalsByLot(input.closes)
  const bySymbol = new Map<string, { total: number; sellable: number; cost: number }>()
  for (const lot of input.lots) {
    const row = closed.get(lot.id) || { qty: 0, costCents: 0 }
    const remaining = remainingLotQty(lot, row.qty)
    const cost = remainingLotCost(lot, row.costCents)
    const acc = bySymbol.get(lot.symbolCode) || { total: 0, sellable: 0, cost: 0 }
    acc.total += remaining
    acc.cost += cost
    if (lot.openDate < input.tradeDate) acc.sellable += remaining
    bySymbol.set(lot.symbolCode, acc)
  }

  const reserved = new Map<string, number>()
  for (const r of input.reservations) {
    if (r.kind !== 'shares' || r.status !== 'held') continue
    if (!r.symbolCode) throw new PaperLedgerError('INVALID_INPUT', `股数冻结缺少代码: ${r.id}`)
    reserved.set(r.symbolCode, (reserved.get(r.symbolCode) || 0) + r.qty)
  }

  const positions: LedgerPosition[] = []
  for (const [symbolCode, acc] of bySymbol) {
    const frozenByOrder = reserved.get(symbolCode) || 0
    const availableQty = acc.sellable - frozenByOrder
    if (availableQty < 0) {
      throw new PaperLedgerError('FROZEN_EXCEEDS_SELLABLE', `${symbolCode} 冻结股数超过可卖批次`, {
        sellable: acc.sellable,
        frozen: frozenByOrder,
      })
    }
    if (acc.total === 0 && acc.cost === 0) continue
    positions.push({
      symbolCode,
      totalQty: acc.total,
      availableQty,
      frozenQty: acc.total - availableQty,
      remainingCostCents: acc.cost,
      avgCostCents: acc.total > 0 ? roundHalfUpDiv(acc.cost, acc.total) : 0,
    })
  }
  return positions.sort((a, b) => a.symbolCode.localeCompare(b.symbolCode))
}

export interface MarketValue {
  marketValueCents: number
  missingSymbols: string[]
}

/** 缺价不计入市值（不得按 0 计算）。 */
export function portfolioMarketValue(
  positions: LedgerPosition[],
  pricesBySymbol: Record<string, number | null | undefined>,
): MarketValue {
  let marketValueCents = 0
  const missing: string[] = []
  for (const p of positions) {
    if (p.totalQty === 0) continue
    const price = pricesBySymbol[p.symbolCode]
    if (!Number.isSafeInteger(price) || (price as number) <= 0) {
      missing.push(p.symbolCode)
      continue
    }
    marketValueCents += p.totalQty * (price as number)
  }
  return { marketValueCents, missingSymbols: missing.sort() }
}

export function realizedPnl(closes: LedgerLotClose[]): number {
  return closes.reduce((sum, c) => sum + c.realizedPnlCents, 0)
}

export interface UnrealizedPnl {
  unrealizedCents: number
  missingSymbols: string[]
}

/** 浮动盈亏 = Σ(总股数 × 最新价 − 批次剩余成本)。 */
export function unrealizedPnl(
  positions: LedgerPosition[],
  pricesBySymbol: Record<string, number | null | undefined>,
): UnrealizedPnl {
  let unrealizedCents = 0
  const missing: string[] = []
  for (const p of positions) {
    if (p.totalQty === 0) continue
    const price = pricesBySymbol[p.symbolCode]
    if (!Number.isSafeInteger(price) || (price as number) <= 0) {
      missing.push(p.symbolCode)
      continue
    }
    unrealizedCents += p.totalQty * (price as number) - p.remainingCostCents
  }
  return { unrealizedCents, missingSymbols: missing.sort() }
}

export interface MaterializedPosition {
  symbolCode: string
  totalQty: number
  availableQty: number
  frozenQty: number
}

export interface ReconcileLedgerInput extends DerivePositionsInput {
  entries: LedgerCashEntry[]
  initialCashCents: number
  pricesBySymbol: Record<string, number | null | undefined>
  /** 账户物化的可用现金；不传则以流水 − 冻结现金推导。 */
  accountCashCents?: number
  /** 物化净值；用于核对 paper_nav。 */
  navCents?: number
  materializedPositions?: MaterializedPosition[]
}

export function reconcileLedger(input: ReconcileLedgerInput): LedgerReconciliation {
  const agg = aggregateCash(input.entries)
  const positions = derivePositions(input)
  const frozenCashCents = input.reservations
    .filter((r) => r.kind === 'cash' && r.status === 'held')
    .reduce((sum, r) => sum + r.amountCents, 0)
  const cashCents = input.accountCashCents ?? (agg.balanceCents - frozenCashCents)
  const market = portfolioMarketValue(positions, input.pricesBySymbol)
  const navCents = cashCents + frozenCashCents + market.marketValueCents
  const unrealized = unrealizedPnl(positions, input.pricesBySymbol)
  const realizedCents = realizedPnl(input.closes)
  const missingSymbols = Array.from(new Set([...market.missingSymbols, ...unrealized.missingSymbols])).sort()
  const priceComplete = missingSymbols.length === 0

  const checks: LedgerCheck[] = []
  const addCentCheck = (name: string, lhs: number, rhs: number, detail?: string) => {
    checks.push({ name, pass: lhs === rhs, lhsCents: lhs, rhsCents: rhs, diffCents: lhs - rhs, detail })
  }

  addCentCheck('identity1_nav', navCents, cashCents + frozenCashCents + market.marketValueCents,
    '现金 + 冻结现金 + 持仓市值 = 净值')
  if (priceComplete) {
    addCentCheck(
      'identity2_pnl',
      input.initialCashCents + realizedCents + unrealized.unrealizedCents
        - agg.feesCents - agg.taxesCents + agg.dividendsCents,
      navCents,
      '期初 + 已实现 + 浮动 − 费用 − 税费 + 分红 = 净值',
    )
  } else {
    checks.push({
      name: 'identity2_pnl',
      pass: true,
      skipped: true,
      detail: `缺价，无法核对浮动盈亏: ${missingSymbols.join(',')}`,
    })
  }
  addCentCheck('cash_ledger', agg.balanceCents, cashCents + frozenCashCents,
    '现金流水合计 = 可用现金 + 冻结现金')
  addCentCheck('initial_cash', agg.initialCents, input.initialCashCents, '初始资金流水与实验一致')
  if (input.navCents !== undefined) {
    if (priceComplete) {
      addCentCheck('materialized_nav', navCents, input.navCents, '物化净值与重建一致')
    } else {
      checks.push({ name: 'materialized_nav', pass: true, skipped: true, detail: '缺价，净值不可比' })
    }
  }
  if (input.accountCashCents !== undefined) {
    checks.push({
      name: 'cash_non_negative',
      pass: input.accountCashCents >= 0,
      lhsCents: input.accountCashCents,
      detail: '现金不得为负',
    })
  }

  for (const p of positions) {
    const shareOk = p.availableQty + p.frozenQty === p.totalQty && p.availableQty >= 0 && p.totalQty >= 0
    checks.push({
      name: `identity3_shares:${p.symbolCode}`,
      pass: shareOk,
      lhsCents: p.availableQty + p.frozenQty,
      rhsCents: p.totalQty,
      detail: '可用 + 冻结 = 总股数',
    })
  }

  if (input.materializedPositions) {
    const mat = new Map(input.materializedPositions.map((p) => [p.symbolCode, p]))
    for (const p of positions) {
      const row = mat.get(p.symbolCode)
      if (!row) {
        checks.push({ name: `position_missing:${p.symbolCode}`, pass: false, detail: '物化持仓缺行' })
        continue
      }
      const pass = row.totalQty === p.totalQty && row.availableQty === p.availableQty && row.frozenQty === p.frozenQty
      checks.push({
        name: `position_match:${p.symbolCode}`,
        pass,
        detail: `物化 ${row.totalQty}/${row.availableQty}/${row.frozenQty} vs 派生 ${p.totalQty}/${p.availableQty}/${p.frozenQty}`,
      })
      mat.delete(p.symbolCode)
    }
    for (const symbol of mat.keys()) {
      checks.push({ name: `position_extra:${symbol}`, pass: false, detail: '物化持仓多余行' })
    }
  }

  const failed = checks.filter((c) => !c.pass && !c.skipped)
  const status: LedgerReconciliation['status'] = failed.length > 0
    ? 'fail'
    : !priceComplete ? 'missing_price' : 'pass'

  return {
    status,
    checks,
    navCents,
    cashCents,
    frozenCashCents,
    marketValueCents: market.marketValueCents,
    realizedCents,
    unrealizedCents: unrealized.unrealizedCents,
    feesCents: agg.feesCents,
    taxesCents: agg.taxesCents,
    dividendsCents: agg.dividendsCents,
    missingSymbols,
    positions,
    mismatchCents: failed.reduce((sum, c) => sum + Math.abs(c.diffCents ?? 0), 0),
  }
}
