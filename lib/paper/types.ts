/** 纸面模拟盘共用类型：金额一律整数分，股数一律整数股。 */

export type PaperBoard = 'main_sh' | 'main_sz' | 'star' | 'chinext' | 'bse'
export type PaperSide = 'buy' | 'sell'
export type PaperOrderType = 'open_market' | 'open_price_condition'
export type PaperCardStatus =
  | 'active' | 'triggered' | 'confirmed' | 'executed'
  | 'not_triggered' | 'invalidated' | 'expired' | 'dismissed'
export type PaperOrderStatus =
  | 'confirmed' | 'settlement_pending' | 'filled' | 'rejected'
  | 'expired' | 'trigger_not_met' | 'canceled'
export type PaperStance = 'observe' | 'candidate' | 'caution' | 'avoid'
export type PaperIntent = 'none' | 'buy' | 'add' | 'reduce' | 'exit'
export type PaperHorizon = 'short' | 'swing' | 'medium'
export type DataQuality = 'pass' | 'warn' | 'fail'

export type PaperReasonCode =
  | 'RISK_POSITION_CAP' | 'RISK_INDUSTRY_CAP' | 'RISK_CASH' | 'RISK_DAILY_LOSS'
  | 'RISK_DRAWDOWN' | 'RISK_T1' | 'RISK_GAP' | 'LIMIT_UP' | 'LIMIT_DOWN'
  | 'SUSPENDED' | 'MISSING_PRICE' | 'DATA_QUALITY' | 'TRIGGER_NOT_MET'
  | 'TOO_LATE' | 'ODD_LOT'

/** SCD2 标的元数据；同一代码状态变化时新增一行，不改旧行。 */
export interface SymbolMeta {
  symbolCode: string
  name: string
  exchange: 'SH' | 'SZ' | 'BJ'
  board: PaperBoard
  industryCode: string | null
  industryName: string | null
  isSt: boolean
  lotSize: number
  limitPctBp: number | null
  noPriceLimit: boolean
  listDate: string | null
  delistDate: string | null
  sourceId: string
  validFrom: string
  validTo: string | null
}

export interface MarketStatus {
  symbolCode: string
  tradeDate: string
  isSuspended: boolean
  isSt: boolean
  source: string
}

export interface DailyBar {
  symbolCode: string
  tradeDate: string
  openCents: number
  closeCents: number
  prevCloseCents: number | null
  amountCents: number | null
}

export interface PriceLimit {
  symbolCode: string
  tradeDate: string
  limitUpCents: number
  limitDownCents: number
  sourceId: string
}

export interface FeePolicy {
  /** 佣金 0.025% = 250 ppm；最低 ¥5。 */
  commissionPpm: number
  minCommissionCents: number
  /** 印花税 0.05%，仅卖出。 */
  stampTaxPpm: number
  /** 过户费 0.001%，买卖双边。 */
  transferFeePpm: number
  /** 滑点 0.05%：买入加、卖出减。 */
  slippagePpm: number
}

export interface DividendTaxPolicy {
  withinOneMonthBp: number
  withinOneYearBp: number
  overOneYearBp: number
  /** 持有期未知时按一年内税率保守预扣。 */
  unknownBp: number
}

export interface RiskPolicy {
  maxSingleStockBp: number
  maxIndustryBp: number
  maxPositions: number
  maxNewPositionsPerDay: number
  maxOrdersPerDay: number
  minCashBufferBp: number
  maxLossPerTradeBp: number
  maxDailyLossBp: number
  maxDrawdownBp: number
  minAdvCents: number
  maxPositionAdvBp: number
  minListedTradingDays: number
  minConfidenceForBuy: number
}

export interface CardRulesPolicy {
  /** 证据分权重（合计 100）；输入是 0–1 的归一化证据强度。 */
  confidenceWeights: {
    policyEvent: number
    industry: number
    trend: number
    volume: number
    liquidity: number
  }
  /** 一条强反证最多扣的分；反证越强扣得越接近上限。 */
  counterPenaltyMax: number
  /** 止损价 = 参考价 − atrMultiple × ATR20。 */
  atrMultiple: number
  /** 可执行卡至少需要的证据条数（含反证）。 */
  minEvidenceItems: number
  /** 市场闸门：宽度与成交额低于阈值视为 risk-off，只出观察/减仓卡。 */
  marketGate: {
    minBreadthPct: number
    minTurnoverPct: number
  }
}

export interface PaperPolicy {
  version: string
  fees: FeePolicy
  dividendTax: DividendTaxPolicy
  risk: RiskPolicy
  cardRules: CardRulesPolicy
}

export interface FeeBreakdown {
  grossCents: number
  commissionCents: number
  stampTaxCents: number
  transferFeeCents: number
  totalFeesCents: number
  slippageCents: number
}

export interface LotRule {
  minQty: number
  step: number
  /** 卖出零股是否允许一次清仓（A 股：允许）。 */
  oddLotFullSell: boolean
}
