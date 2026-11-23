import type {
  DailyBar,
  DividendTaxPolicy,
  FeeBreakdown,
  FeePolicy,
  LotRule,
  MarketStatus,
  PaperBoard,
  PaperSide,
  RiskPolicy,
  SymbolMeta,
} from './types'
import { ceilDiv, floorDiv, PPM, ppmCeil, roundHalfUpDiv } from './money'

/** A 股板别判定只看代码段；未知代码不猜板别，由数据质量门拦截。 */
export function resolveBoard(symbolCode: string): PaperBoard | null {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/.exec(symbolCode)
  if (!m) return null
  const code = m[1]
  const exchange = m[2]
  if (exchange === 'SH') {
    if (/^(600|601|603|605)/.test(code)) return 'main_sh'
    if (/^(688|689)/.test(code)) return 'star'
    return null
  }
  if (exchange === 'SZ') {
    if (/^(000|001|002|003)/.test(code)) return 'main_sz'
    if (/^(300|301)/.test(code)) return 'chinext'
    return null
  }
  return 'bse'
}

export function boardLabel(board: PaperBoard): string {
  return {
    main_sh: '沪市主板',
    main_sz: '深市主板',
    star: '科创板',
    chinext: '创业板',
    bse: '北交所',
  }[board]
}

/** 科创板 200 股起、1 股递增；其余 100 股整数倍。 */
export function lotRuleFor(board: PaperBoard): LotRule {
  if (board === 'star') return { minQty: 200, step: 1, oddLotFullSell: true }
  if (board === 'bse') return { minQty: 100, step: 1, oddLotFullSell: true }
  return { minQty: 100, step: 100, oddLotFullSell: true }
}

/** 目标股数向下取整到可买手数；不足最小单位返回 0。 */
export function sizeBuyQuantity(targetQty: number, board: PaperBoard): number {
  const rule = lotRuleFor(board)
  if (!Number.isSafeInteger(targetQty) || targetQty < rule.minQty) return 0
  if (rule.step === 1) return targetQty
  return floorDiv(targetQty, rule.step) * rule.step
}

export type SellQtyIssue = 'QTY_INVALID' | 'RISK_T1' | 'ODD_LOT'

/** 卖出校验：可用数量来自批次（T+1），零股只允许一次清仓。 */
export function validateSellQuantity(input: {
  qty: number
  availableQty: number
  totalQty: number
  board: PaperBoard
}): { ok: true } | { ok: false; reason: SellQtyIssue } {
  const { qty, availableQty, totalQty, board } = input
  if (!Number.isSafeInteger(qty) || qty <= 0) return { ok: false, reason: 'QTY_INVALID' }
  if (qty > availableQty) return { ok: false, reason: 'RISK_T1' }
  if (qty > totalQty) return { ok: false, reason: 'QTY_INVALID' }
  const rule = lotRuleFor(board)
  if (qty >= rule.minQty && (rule.step === 1 || qty % rule.step === 0)) return { ok: true }
  // 零股（或不足一手）只能全部卖掉，且必须是整个持仓
  if (rule.oddLotFullSell && qty === totalQty && availableQty === totalQty) return { ok: true }
  return { ok: false, reason: 'ODD_LOT' }
}

/** 理论涨跌停幅度：主板 10%（ST 5%），创业板/科创板 20%，北交所 30%。 */
export function priceLimitBpFor(board: PaperBoard, isSt: boolean): number {
  if (board === 'main_sh' || board === 'main_sz') return isSt ? 500 : 1000
  if (board === 'star' || board === 'chinext') return 2000
  return 3000
}

/** 仅用于核对/展示；成交一律以 paper_limit_price_daily 的取值为准。 */
export function theoreticalLimitPrices(
  prevCloseCents: number,
  board: PaperBoard,
  isSt: boolean,
): { limitUpCents: number; limitDownCents: number } {
  const bp = priceLimitBpFor(board, isSt)
  return {
    limitUpCents: roundHalfUpDiv(prevCloseCents * (10_000 + bp), 10_000),
    limitDownCents: roundHalfUpDiv(prevCloseCents * (10_000 - bp), 10_000),
  }
}

export type TradePriceResult =
  | { ok: true; priceCents: number; slippageCents: number }
  | { ok: false; reasonCode: 'LIMIT_UP' | 'LIMIT_DOWN' | 'TRIGGER_NOT_MET' }

export interface TradePriceInput {
  side: PaperSide
  openCents: number
  slippagePpm: number
  limitUpCents: number
  limitDownCents: number
  condition?: { op: 'lte' | 'gte'; priceCents: number } | null
}

function conditionMet(openCents: number, condition: { op: 'lte' | 'gte'; priceCents: number }): boolean {
  return condition.op === 'lte' ? openCents <= condition.priceCents : openCents >= condition.priceCents
}

/**
 * 开盘价 + 滑点 -> 成交价。
 * 买入向上取整、不得高于涨停价/条件价；卖出向下取整、不得低于跌停价/条件价。
 * 开盘即涨跌停不做撮合（不模拟排队）。
 */
export function resolveTradePrice(input: TradePriceInput): TradePriceResult {
  const { side, openCents, slippagePpm, limitUpCents, limitDownCents, condition } = input
  if (!Number.isSafeInteger(openCents) || openCents <= 0) {
    return { ok: false, reasonCode: side === 'buy' ? 'LIMIT_UP' : 'LIMIT_DOWN' }
  }
  if (side === 'buy' && openCents >= limitUpCents) return { ok: false, reasonCode: 'LIMIT_UP' }
  if (side === 'sell' && openCents <= limitDownCents) return { ok: false, reasonCode: 'LIMIT_DOWN' }
  if (condition && !conditionMet(openCents, condition)) return { ok: false, reasonCode: 'TRIGGER_NOT_MET' }

  let priceCents: number
  if (side === 'buy') {
    priceCents = Math.min(
      ceilDiv(openCents * (PPM + slippagePpm), PPM),
      limitUpCents,
      condition?.priceCents ?? Number.MAX_SAFE_INTEGER,
    )
  } else {
    priceCents = Math.max(
      floorDiv(openCents * (PPM - slippagePpm), PPM),
      limitDownCents,
      condition?.priceCents ?? 0,
    )
  }
  if (priceCents <= 0) return { ok: false, reasonCode: side === 'buy' ? 'LIMIT_UP' : 'LIMIT_DOWN' }
  return { ok: true, priceCents, slippageCents: Math.abs(priceCents - openCents) }
}

/** 市价买单的冻结价上限：最近收盘价上浮滑点，向上取整。确认与下单必须共用这一口径。 */
export function reserveBuyPriceCents(lastCloseCents: number, slippagePpm: number): number {
  return ceilDiv(lastCloseCents * (PPM + slippagePpm), PPM)
}

/** 费用按整单成交额计，佣金有最低值；买入不收印花税。 */
export function calcFees(
  side: PaperSide,
  qty: number,
  priceCents: number,
  openCents: number,
  fees: FeePolicy,
): FeeBreakdown {
  const grossCents = qty * priceCents
  const commissionCents = Math.max(fees.minCommissionCents, ppmCeil(grossCents, fees.commissionPpm))
  const stampTaxCents = side === 'sell' ? ppmCeil(grossCents, fees.stampTaxPpm) : 0
  const transferFeeCents = ppmCeil(grossCents, fees.transferFeePpm)
  return {
    grossCents,
    commissionCents,
    stampTaxCents,
    transferFeeCents,
    totalFeesCents: commissionCents + stampTaxCents + transferFeeCents,
    slippageCents: Math.abs(priceCents - openCents) * qty,
  }
}

/** 红利税按持股期：≤1 个月 20%，1 个月–1 年 10%，>1 年 0；未知按一年内保守预扣。 */
export function dividendTaxBp(
  holdingDays: number,
  policy: DividendTaxPolicy,
  rateKnown = true,
): number {
  if (!rateKnown || !Number.isSafeInteger(holdingDays) || holdingDays < 0) return policy.unknownBp
  if (holdingDays <= 30) return policy.withinOneMonthBp
  if (holdingDays <= 365) return policy.withinOneYearBp
  return policy.overOneYearBp
}

export function calcDividendTax(
  grossDividendCents: number,
  holdingDays: number,
  policy: DividendTaxPolicy,
  rateKnown = true,
): number {
  const bp = dividendTaxBp(holdingDays, policy, rateKnown)
  return bp === 0 ? 0 : ceilDiv(grossDividendCents * bp, 10_000)
}

export interface CorporateActionShares {
  whole: number
  remainder: number
  denominator: number
}

/** 送转/拆股后的股数；不足 1 股的部分由调用方按除权参考价折现金。 */
export function corporateActionShares(
  qty: number,
  bonusPer10: number,
  splitNum = 1,
  splitDen = 1,
): CorporateActionShares {
  if (!Number.isSafeInteger(qty) || qty < 0 || bonusPer10 < 0 || splitNum <= 0 || splitDen <= 0) {
    throw new Error(`送转参数非法: ${qty}/${bonusPer10}/${splitNum}:${splitDen}`)
  }
  const numerator = qty * (10 + bonusPer10) * splitNum
  const denominator = 10 * splitDen
  const whole = floorDiv(numerator, denominator)
  return { whole, remainder: numerator - whole * denominator, denominator }
}

/** 零股折现金补偿：四舍五入到分（不是单向保守取整，属于对账差额）。 */
export function cashInLieuCents(
  remainder: number,
  denominator: number,
  refPriceCents: number,
): number {
  return roundHalfUpDiv(remainder * refPriceCents, denominator)
}

export type BuyExclusion =
  | 'MISSING_META' | 'BSE' | 'ST' | 'DELISTED' | 'SUSPENDED'
  | 'NEW_STOCK' | 'MISSING_ADV' | 'LOW_LIQUIDITY'

/** 新开仓/加仓的排除项；持仓仍会生成观察/退出卡，不受此函数影响。 */
export function buyExclusionReason(
  meta: SymbolMeta | null,
  status: MarketStatus | null,
  input: {
    listedTradingDays: number | null
    adv20Cents: number | null
    risk: Pick<RiskPolicy, 'minListedTradingDays' | 'minAdvCents'>
  },
): BuyExclusion | null {
  if (!meta) return 'MISSING_META'
  if (meta.board === 'bse') return 'BSE'
  if (meta.isSt || status?.isSt) return 'ST'
  if (meta.delistDate) return 'DELISTED'
  if (status?.isSuspended) return 'SUSPENDED'
  if (input.listedTradingDays === null) return 'MISSING_META'
  if (input.listedTradingDays < input.risk.minListedTradingDays) return 'NEW_STOCK'
  if (input.adv20Cents === null) return 'MISSING_ADV'
  if (input.adv20Cents < input.risk.minAdvCents) return 'LOW_LIQUIDITY'
  return null
}

/** 20 日日均成交额；不足 20 根返回 null（不拿短窗口冒充 ADV）。 */
export function averageDailyTurnoverCents(bars: DailyBar[], days = 20): number | null {
  const valid = bars
    .filter((b) => Number.isSafeInteger(b.amountCents) && (b.amountCents as number) >= 0)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate))
  if (valid.length < days) return null
  const window = valid.slice(-days)
  return floorDiv(window.reduce((sum, b) => sum + (b.amountCents as number), 0), days)
}

/** 单票持仓市值不得超过 ADV 的 5%。 */
export function positionWithinAdv(
  positionValueCents: number,
  adv20Cents: number,
  risk: Pick<RiskPolicy, 'maxPositionAdvBp'>,
): boolean {
  return positionValueCents * 10_000 <= adv20Cents * risk.maxPositionAdvBp
}
