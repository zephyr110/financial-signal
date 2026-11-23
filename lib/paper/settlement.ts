import {
  allocateSellToLots,
  PaperLedgerError,
  type LedgerCashEntry,
  type LedgerLot,
  type LedgerLotClose,
} from './ledger'
import { calcFees, resolveTradePrice, sizeBuyQuantity, validateSellQuantity } from './market'
import { floorDiv } from './money'
import type {
  DataQuality,
  DailyBar,
  MarketStatus,
  PaperBoard,
  PaperOrderType,
  PaperPolicy,
  PaperReasonCode,
  PaperSide,
  PriceLimit,
  SymbolMeta,
} from './types'

/**
 * 16:20 结算：用目标日官方开盘价把「已确认、待收盘确认」的委托落成成交。
 * 这里只做纯决策；事务写入由仓储层完成，任何一步失败整单回滚。
 * 缺价只作废该笔委托，账本对不上才标记 fatalLedger（由上层触发 kill switch）。
 */

export interface SettlementOrder {
  id: string
  accountId: string
  cardId: string | null
  cardVersion: number | null
  symbolCode: string
  side: PaperSide
  orderType: PaperOrderType
  qty: number
  conditionOp: 'lte' | 'gte' | null
  triggerPriceCents: number | null
  targetTradeDate: string
}

export interface SettlementCardState {
  id: string
  version: number
  status: string
  symbolCode: string
  stopPriceCents: number | null
  maxLossCents: number | null
}

export interface SettlementMarket {
  bar: DailyBar | null
  limit: PriceLimit | null
  status: MarketStatus | null
  priceSourceId?: string
  barHash?: string | null
  barFetchedAt?: string | null
}

export interface SettlementPositionSnapshot {
  totalQty: number
  availableQty: number
  frozenQty: number
}

export interface SettlementRiskState {
  killSwitch: boolean
  killSwitchReason: PaperReasonCode | null
  /** 账本不一致时连减仓也需人工复核；普通回撤只停买入。 */
  blocksSells: boolean
}

export interface PlannedFill {
  id: string
  orderId: string
  symbolCode: string
  side: PaperSide
  qty: number
  priceCents: number
  grossCents: number
  commissionCents: number
  stampTaxCents: number
  transferFeeCents: number
  slippageCents: number
  totalFeesCents: number
  tradeDate: string
  tradeTime: '09:25'
  settledAt: string
  priceBasis: 'official_daily_open'
  priceSourceId: string
  barHash: string | null
  barFetchedAt: string | null
}

export interface PlannedCashEntry {
  id: string
  kind: LedgerCashEntry['kind']
  amountCents: number
  balanceAfterCents: number
  refType: 'fill'
  refId: string
  orderId: string
  fillId: string
  memo?: string
}

export interface PlannedLot {
  id: string
  accountId: string
  symbolCode: string
  openFillId: string
  openDate: string
  qtyOpened: number
  costTotalCents: number
}

export type CardNextStatus = 'executed' | 'expired' | 'not_triggered'

export interface SettlementDecision {
  outcome: 'fill' | 'reject' | 'expire' | 'trigger_not_met'
  nextOrderStatus: 'filled' | 'rejected' | 'expired' | 'trigger_not_met'
  nextCardStatus: CardNextStatus | null
  reasonCode: PaperReasonCode | null
  detail: string
  /** 账本状态自相矛盾（批次不足/现金为负），上层应停牌核查。 */
  fatalLedger?: boolean
  fill?: PlannedFill
  cashEntries?: PlannedCashEntry[]
  lot?: PlannedLot
  lotCloses?: LedgerLotClose[]
}

export interface PlanSettlementInput {
  order: SettlementOrder
  card: SettlementCardState | null
  meta: SymbolMeta | null
  board: PaperBoard | null
  market: SettlementMarket
  isTradingDay: boolean
  dataQuality: DataQuality
  risk: SettlementRiskState
  navCents: number
  position: SettlementPositionSnapshot
  lots: LedgerLot[]
  closes: LedgerLotClose[]
  pendingDividendGrossByLot?: Record<string, number>
  reservedCashCents: number
  reservedShareQty: number
  /** 写入流水前账本现金总额（含全部冻结），用于 balance_after。 */
  cashLedgerBeforeCents: number
  policy: PaperPolicy
  settledAt: string
}

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function reject(
  reasonCode: PaperReasonCode,
  detail: string,
  nextCardStatus: CardNextStatus | null,
  fatalLedger = false,
): SettlementDecision {
  return {
    outcome: 'reject',
    nextOrderStatus: 'rejected',
    nextCardStatus,
    reasonCode,
    detail,
    ...(fatalLedger ? { fatalLedger: true } : {}),
  }
}

function expire(
  reasonCode: PaperReasonCode,
  detail: string,
  nextCardStatus: CardNextStatus | null,
): SettlementDecision {
  return {
    outcome: 'expire',
    nextOrderStatus: 'expired',
    nextCardStatus,
    reasonCode,
    detail,
  }
}

function triggerNotMet(
  detail: string,
  nextCardStatus: CardNextStatus | null,
): SettlementDecision {
  return {
    outcome: 'trigger_not_met',
    nextOrderStatus: 'trigger_not_met',
    nextCardStatus,
    reasonCode: 'TRIGGER_NOT_MET',
    detail,
  }
}

/** 只有「已确认」的卡才随本次结算迁移状态；历史状态原样保留。 */
function plannedCardStatus(card: SettlementCardState | null, next: CardNextStatus): CardNextStatus | null {
  return card && card.status === 'confirmed' ? next : null
}

export function planSettlement(input: PlanSettlementInput): SettlementDecision {
  const { order, card, meta, board, market, risk, policy } = input
  const cardConfirmed = card !== null && card.status === 'confirmed'
  const expiredCard = cardConfirmed ? 'expired' : null

  if (!order.qty || !Number.isSafeInteger(order.qty) || order.qty <= 0) {
    return reject('DATA_QUALITY', `委托股数非法: ${order.qty}`, expiredCard)
  }
  if (!Number.isSafeInteger(input.cashLedgerBeforeCents) || input.cashLedgerBeforeCents < 0) {
    return reject('DATA_QUALITY', '账本现金基线非法', expiredCard, true)
  }
  if (!input.isTradingDay) {
    return expire('DATA_QUALITY', `目标日 ${order.targetTradeDate} 不是交易日`, expiredCard)
  }
  if (!board) return reject('DATA_QUALITY', `无法识别板块: ${order.symbolCode}`, expiredCard)
  if (input.dataQuality === 'fail') {
    return expire('DATA_QUALITY', '关键数据质量不通过，今日不结算', expiredCard)
  }
  if (risk.killSwitch && (order.side === 'buy' || risk.blocksSells)) {
    return reject(risk.killSwitchReason ?? 'RISK_DRAWDOWN', '账户处于 kill switch，禁止成交', expiredCard)
  }
  if (!meta) return reject('DATA_QUALITY', `缺少标的元数据: ${order.symbolCode}`, expiredCard)

  if (card) {
    if (card.symbolCode !== order.symbolCode) {
      return reject('DATA_QUALITY', '卡片与委托标的不一致', null)
    }
    if (order.cardVersion !== null && card.version !== order.cardVersion) {
      return reject('DATA_QUALITY', `卡片版本已变化: ${order.cardVersion} -> ${card.version}`, null)
    }
    if (!cardConfirmed) {
      return reject('DATA_QUALITY', `卡片状态不是已确认: ${card.status}`, null)
    }
  } else if (order.side === 'buy') {
    return reject('DATA_QUALITY', '买入委托缺少决策卡', null)
  }

  if (!market.status || market.status.tradeDate !== order.targetTradeDate) {
    return expire('MISSING_PRICE', '缺少当日停牌状态', expiredCard)
  }
  if (market.status.isSuspended) return reject('SUSPENDED', '停牌，无法成交', expiredCard)
  if (!market.bar || market.bar.tradeDate !== order.targetTradeDate) {
    return expire('MISSING_PRICE', '缺少当日官方日线', expiredCard)
  }
  if (!isPositiveInt(market.bar.openCents)) {
    return expire('MISSING_PRICE', '官方开盘价无效', expiredCard)
  }
  if (!market.limit
    || market.limit.tradeDate !== order.targetTradeDate
    || !isPositiveInt(market.limit.limitUpCents)
    || !isPositiveInt(market.limit.limitDownCents)
    || market.limit.limitDownCents > market.limit.limitUpCents) {
    return expire('MISSING_PRICE', '缺少当日有效涨跌停价', expiredCard)
  }

  if (order.side === 'buy' && (meta.isSt || market.status.isSt || meta.delistDate !== null)) {
    return reject('DATA_QUALITY', 'ST/退市标的不允许买入', expiredCard)
  }

  const condition = order.orderType === 'open_price_condition'
    ? {
        op: order.conditionOp ?? (order.side === 'buy' ? 'lte' : 'gte'),
        priceCents: order.triggerPriceCents ?? 0,
      }
    : null
  if (condition && !isPositiveInt(condition.priceCents)) {
    return reject('DATA_QUALITY', '条件单缺少触发价', expiredCard)
  }

  const priced = resolveTradePrice({
    side: order.side,
    openCents: market.bar.openCents,
    slippagePpm: policy.fees.slippagePpm,
    limitUpCents: market.limit.limitUpCents,
    limitDownCents: market.limit.limitDownCents,
    condition,
  })
  if (!priced.ok) {
    // strictNullChecks 关闭时字面量判别收窄失效，这里显式取失败分支的 reasonCode
    const reasonCode = (priced as { ok: false; reasonCode: 'LIMIT_UP' | 'LIMIT_DOWN' | 'TRIGGER_NOT_MET' }).reasonCode
    if (reasonCode === 'TRIGGER_NOT_MET') {
      return triggerNotMet('开盘价未满足条件，委托作废', plannedCardStatus(card, 'not_triggered'))
    }
    return reject(reasonCode, reasonCode === 'LIMIT_UP' ? '开盘涨停，买不到' : '开盘跌停，卖不出', expiredCard)
  }

  if (order.side === 'buy') {
    if (sizeBuyQuantity(order.qty, board) !== order.qty) {
      return reject('DATA_QUALITY', `买入数量不符合手数规则: ${order.qty}`, expiredCard)
    }
  } else {
    const shareCheck = validateSellQuantity({
      qty: order.qty,
      availableQty: input.position.availableQty + input.reservedShareQty,
      totalQty: input.position.totalQty,
      board,
    })
    if (!shareCheck.ok) {
      const issue = (shareCheck as { ok: false; reason: 'QTY_INVALID' | 'RISK_T1' | 'ODD_LOT' }).reason
      if (issue === 'ODD_LOT') {
        return reject('ODD_LOT', '零股必须一次卖完', expiredCard)
      }
      if (issue === 'RISK_T1') {
        return reject('RISK_T1', '可卖数量不足（含 T+1 锁定）', expiredCard)
      }
      return reject('DATA_QUALITY', '卖出数量非法', expiredCard)
    }
    if (input.reservedShareQty < order.qty) {
      return reject('DATA_QUALITY', `股数冻结不足: ${input.reservedShareQty}/${order.qty}`, expiredCard)
    }
  }

  const fees = calcFees(order.side, order.qty, priced.priceCents, market.bar.openCents, policy.fees)
  const totalCost = fees.grossCents + fees.totalFeesCents

  if (order.side === 'buy') {
    if (input.reservedCashCents <= 0) {
      return reject('DATA_QUALITY', '缺少现金冻结记录', expiredCard)
    }
    if (input.reservedCashCents < totalCost) {
      return reject('RISK_CASH', `冻结现金不足以覆盖成交与费用: ${input.reservedCashCents}/${totalCost}`, expiredCard)
    }
    if (!card || !isPositiveInt(card.stopPriceCents ?? 0)) {
      return reject('DATA_QUALITY', '买入卡缺少数字止损价', expiredCard)
    }
    if (!isPositiveInt(input.navCents)) {
      return expire('MISSING_PRICE', '缺少账户净值，无法核对单笔风险', expiredCard)
    }
    const maxLossCents = Math.max(0, (priced.priceCents - (card.stopPriceCents as number)) * order.qty + fees.totalFeesCents)
    const policyCap = floorDiv(input.navCents * policy.risk.maxLossPerTradeBp, 10_000)
    const cardCap = card.maxLossCents ?? Number.MAX_SAFE_INTEGER
    if (maxLossCents > Math.min(policyCap, cardCap)) {
      return reject('RISK_GAP',
        `按开盘价重算最大亏损 ${maxLossCents} 分，超过上限 ${Math.min(policyCap, cardCap)} 分`, expiredCard)
    }
  }

  let lotCloses: LedgerLotClose[] | undefined
  if (order.side === 'sell') {
    try {
      lotCloses = allocateSellToLots({
        accountId: order.accountId,
        symbolCode: order.symbolCode,
        sellQty: order.qty,
        grossProceedsCents: fees.grossCents,
        tradeDate: order.targetTradeDate,
        sellFillId: `fill-${order.id}`,
        lots: input.lots,
        closes: input.closes,
        closeIdPrefix: `close-${order.id}`,
        pendingDividendGrossByLot: input.pendingDividendGrossByLot,
        dividendTax: policy.dividendTax,
      })
    } catch (err) {
      if (err instanceof PaperLedgerError) {
        return reject('DATA_QUALITY', `批次分配失败: ${err.message}`, expiredCard, true)
      }
      throw err
    }
  }

  const fillId = `fill-${order.id}`
  const fill: PlannedFill = {
    id: fillId,
    orderId: order.id,
    symbolCode: order.symbolCode,
    side: order.side,
    qty: order.qty,
    priceCents: priced.priceCents,
    grossCents: fees.grossCents,
    commissionCents: fees.commissionCents,
    stampTaxCents: fees.stampTaxCents,
    transferFeeCents: fees.transferFeeCents,
    slippageCents: fees.slippageCents,
    totalFeesCents: fees.totalFeesCents,
    tradeDate: order.targetTradeDate,
    tradeTime: '09:25',
    settledAt: input.settledAt,
    priceBasis: 'official_daily_open',
    priceSourceId: market.priceSourceId ?? market.limit.sourceId,
    barHash: market.barHash ?? null,
    barFetchedAt: market.barFetchedAt ?? null,
  }

  let running = input.cashLedgerBeforeCents
  const cashEntries: PlannedCashEntry[] = []
  const addEntry = (kind: LedgerCashEntry['kind'], amountCents: number, memo?: string) => {
    running += amountCents
    if (running < 0) throw new PaperLedgerError('LEDGER_MISMATCH', `结算后现金为负: ${running}`)
    cashEntries.push({
      id: `${fillId}:${kind}`,
      kind,
      amountCents,
      balanceAfterCents: running,
      refType: 'fill',
      refId: fillId,
      orderId: order.id,
      fillId,
      memo,
    })
  }

  try {
    if (order.side === 'buy') {
      addEntry('buy', -fees.grossCents, `买入 ${order.symbolCode}`)
      addEntry('fee', -(fees.commissionCents + fees.transferFeeCents), '佣金+过户费')
    } else {
      addEntry('sell', fees.grossCents, `卖出 ${order.symbolCode}`)
      addEntry('fee', -(fees.commissionCents + fees.transferFeeCents), '佣金+过户费')
      if (fees.stampTaxCents > 0) addEntry('tax', -fees.stampTaxCents, '印花税')
      const dividendTax = (lotCloses ?? []).reduce((sum, c) => sum + c.dividendTaxCents, 0)
      if (dividendTax > 0) addEntry('dividend_tax', -dividendTax, '红利税代扣')
    }
  } catch (err) {
    if (err instanceof PaperLedgerError) {
      return reject('DATA_QUALITY', err.message, expiredCard, true)
    }
    throw err
  }

  const lot: PlannedLot | undefined = order.side === 'buy'
    ? {
        id: `lot-${fillId}`,
        accountId: order.accountId,
        symbolCode: order.symbolCode,
        openFillId: fillId,
        openDate: order.targetTradeDate,
        qtyOpened: order.qty,
        costTotalCents: fees.grossCents,
      }
    : undefined

  return {
    outcome: 'fill',
    nextOrderStatus: 'filled',
    nextCardStatus: plannedCardStatus(card, 'executed'),
    reasonCode: null,
    detail: `按官方开盘价 ${priced.priceCents} 分成交`,
    fill,
    cashEntries,
    lot,
    lotCloses,
  }
}
