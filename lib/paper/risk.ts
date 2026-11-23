import { buyExclusionReason, lotRuleFor, positionWithinAdv, sizeBuyQuantity, validateSellQuantity } from './market'
import { floorDiv } from './money'
import type {
  DataQuality,
  MarketStatus,
  PaperBoard,
  PaperPolicy,
  PaperReasonCode,
  PaperSide,
  SymbolMeta,
} from './types'

/**
 * 风控纯函数：卡生成与用户确认（execute）两处共用；16:20 成交级检查在 settlement.ts。
 * 不通过返回可解释的规则与数值，调用方负责降级为观察卡或拒绝委托。
 */

export type RiskCheckpoint = 'card' | 'confirm'

export type RiskRule =
  | 'data_quality'
  | 'kill_switch'
  | 'excluded'
  | 'suspended'
  | 'liquidity'
  | 'lot_feasibility'
  | 'confidence_gate'
  | 'daily_loss'
  | 'drawdown'
  | 'max_positions'
  | 'new_positions_per_day'
  | 'orders_per_day'
  | 'single_stock_cap'
  | 'industry_cap'
  | 'position_adv'
  | 'cash_buffer'
  | 'max_loss_per_trade'
  | 'available_shares'

export interface RiskGate {
  killSwitch: boolean
  killReason: string | null
  /** 账本不一致时连减仓也需人工复核。 */
  blocksSells: boolean
  dataQuality: DataQuality
}

export interface RiskPosition {
  symbolCode: string
  industryCode: string | null
  marketValueCents: number
  totalQty: number
  availableQty: number
}

export interface RiskLedgerInput {
  /** 最新净值；缺失时禁止买入（无法核对仓位上限）。 */
  navCents: number | null
  cashCents: number
  positions: RiskPosition[]
  dailyOrders: number
  dailyNewPositions: number
  /** 今日亏损 bp（正数表示亏损）。 */
  dailyLossBp: number | null
  /** 当前回撤 bp（正数）。 */
  drawdownBp: number | null
  /** 持仓中无法估值的标的；有值时禁止买入。 */
  missingPriceSymbols?: string[]
}

export interface RiskProposal {
  symbolCode: string
  industryCode: string | null
  side: PaperSide
  qty: number
  /** 预估成交价（确认时用最近收盘价，卡阶段用参考价）。 */
  priceCents: number
  grossCents: number
  feesCents: number
  stopPriceCents: number | null
  maxLossCents: number | null
  board: PaperBoard | null
  lotSize: number
  isNewPosition: boolean
  confidenceScore?: number | null
}

export interface RiskMarketInput {
  meta: SymbolMeta | null
  status: MarketStatus | null
  adv20Cents: number | null
  listedTradingDays: number | null
}

export interface RiskViolation {
  rule: RiskRule
  reasonCode: PaperReasonCode
  message: string
  limitCents?: number
  actualCents?: number
}

export interface RiskBudget {
  singleStockCents: number | null
  industryCents: number | null
  maxLossCents: number | null
  cashBufferCents: number | null
  remainingCashCents: number
}

export interface RiskEvaluation {
  ok: boolean
  violations: RiskViolation[]
  budget: RiskBudget
}

export interface EvaluateRiskInput {
  checkpoint: RiskCheckpoint
  policy: PaperPolicy
  gate: RiskGate
  ledger: RiskLedgerInput
  proposal: RiskProposal
  market: RiskMarketInput
}

function bpOf(amountCents: number, bp: number): number {
  return floorDiv(amountCents * bp, 10_000)
}

function violation(
  rule: RiskRule,
  reasonCode: PaperReasonCode,
  message: string,
  limitCents?: number,
  actualCents?: number,
): RiskViolation {
  return { rule, reasonCode, message, ...(limitCents == null ? {} : { limitCents }), ...(actualCents == null ? {} : { actualCents }) }
}

function exclusionViolation(reason: ReturnType<typeof buyExclusionReason>): RiskViolation | null {
  switch (reason) {
    case 'SUSPENDED':
      return violation('suspended', 'SUSPENDED', '停牌中，不能买入')
    case 'ST':
      return violation('excluded', 'DATA_QUALITY', 'ST 标的不允许买入')
    case 'DELISTED':
      return violation('excluded', 'DATA_QUALITY', '退市标的不能买入')
    case 'NEW_STOCK':
      return violation('excluded', 'DATA_QUALITY', '上市不足 60 个交易日，暂不买入')
    case 'BSE':
      return violation('excluded', 'DATA_QUALITY', '北交所暂不纳入模拟盘')
    case 'MISSING_META':
      return violation('excluded', 'DATA_QUALITY', '缺少标的元数据，不能买入')
    case 'MISSING_ADV':
      return violation('liquidity', 'DATA_QUALITY', '缺少 20 日成交额，无法判断流动性')
    case 'LOW_LIQUIDITY':
      return violation('liquidity', 'DATA_QUALITY', '20 日日均成交额不足 ¥5,000 万')
    default:
      return null
  }
}

export function evaluateRisk(input: EvaluateRiskInput): RiskEvaluation {
  const { checkpoint, policy, gate, ledger, proposal, market } = input
  const risk = policy.risk
  const violations: RiskViolation[] = []
  const nav = ledger.navCents && ledger.navCents > 0 ? ledger.navCents : null
  const singleStockCap = nav ? bpOf(nav, risk.maxSingleStockBp) : null
  const industryCap = nav ? bpOf(nav, risk.maxIndustryBp) : null
  const maxLossCap = nav ? bpOf(nav, risk.maxLossPerTradeBp) : null
  const cashBuffer = nav ? bpOf(nav, risk.minCashBufferBp) : null
  const remainingCash = ledger.cashCents - proposal.grossCents - proposal.feesCents

  if (gate.dataQuality === 'fail') {
    violations.push(violation('data_quality', 'DATA_QUALITY', '关键数据质量不通过，暂停交易'))
  }
  if (gate.killSwitch && (proposal.side === 'buy' || gate.blocksSells)) {
    const reason = (gate.killReason === 'LEDGER_MISMATCH' || gate.killReason === 'DATA_QUALITY'
      || gate.killReason === 'RISK_DRAWDOWN'
      ? gate.killReason
      : 'RISK_DRAWDOWN') as PaperReasonCode
    violations.push(violation('kill_switch', reason,
      gate.killReason === 'LEDGER_MISMATCH' ? '账本不一致，账户已停牌核查' : '账户处于暂停状态，禁止成交'))
  }

  if (proposal.side === 'sell') {
    const held = ledger.positions.find((p) => p.symbolCode === proposal.symbolCode)
    if (market.status?.isSuspended) {
      violations.push(violation('suspended', 'SUSPENDED', '停牌中，卖不出'))
    }
    if (!held || !proposal.board) {
      violations.push(violation('available_shares', 'DATA_QUALITY', '没有可卖持仓或缺少板别信息'))
    } else {
      const check = validateSellQuantity({
        qty: proposal.qty,
        availableQty: held.availableQty,
        totalQty: held.totalQty,
        board: proposal.board,
      })
      if (!check.ok) {
        const issue = (check as { ok: false; reason: 'QTY_INVALID' | 'RISK_T1' | 'ODD_LOT' }).reason
        if (issue === 'RISK_T1') {
          violations.push(violation('available_shares', 'RISK_T1', '今天买的股票明天才能卖，可卖数量不足'))
        } else if (issue === 'ODD_LOT') {
          violations.push(violation('available_shares', 'ODD_LOT', '零股必须一次卖完'))
        } else {
          violations.push(violation('available_shares', 'DATA_QUALITY', '卖出数量非法'))
        }
      }
    }
    return {
      ok: violations.length === 0,
      violations,
      budget: {
        singleStockCents: singleStockCap,
        industryCents: industryCap,
        maxLossCents: maxLossCap,
        cashBufferCents: cashBuffer,
        remainingCashCents: remainingCash,
      },
    }
  }

  // 以下为买入路径；现金缓冲为 0 也是合法政策，不能用 falsy 判断
  if (nav === null || singleStockCap === null || industryCap === null
    || maxLossCap === null || cashBuffer === null) {
    violations.push(violation('single_stock_cap', 'DATA_QUALITY', '缺少账户净值，无法核对仓位上限'))
    return {
      ok: false,
      violations,
      budget: {
        singleStockCents: null,
        industryCents: null,
        maxLossCents: null,
        cashBufferCents: null,
        remainingCashCents: remainingCash,
      },
    }
  }
  if (ledger.missingPriceSymbols?.length) {
    violations.push(violation('single_stock_cap', 'DATA_QUALITY',
      `持仓缺价无法估值：${ledger.missingPriceSymbols.join(', ')}`))
  }

  const excluded = exclusionViolation(buyExclusionReason(market.meta, market.status, {
    listedTradingDays: market.listedTradingDays,
    adv20Cents: market.adv20Cents,
    risk,
  }))
  if (excluded) violations.push(excluded)

  if (!proposal.board) {
    violations.push(violation('excluded', 'DATA_QUALITY', `无法识别板块: ${proposal.symbolCode}`))
  } else {
    const lotRule = lotRuleFor(proposal.board)
    if (!Number.isSafeInteger(proposal.qty) || proposal.qty < lotRule.minQty
      || sizeBuyQuantity(proposal.qty, proposal.board) !== proposal.qty) {
      violations.push(violation('lot_feasibility', 'DATA_QUALITY', '买入数量不是可买手数的整数倍'))
    }
    const oneLotCents = lotRule.minQty * proposal.priceCents
    if (oneLotCents > singleStockCap) {
      violations.push(violation('lot_feasibility', 'RISK_POSITION_CAP',
        `一手约 ¥${(oneLotCents / 100).toFixed(0)}，超过单票上限 ¥${(singleStockCap / 100).toFixed(0)}，只能观察`,
        singleStockCap, oneLotCents))
    }
  }

  const current = ledger.positions.find((p) => p.symbolCode === proposal.symbolCode)
  const currentValue = current?.marketValueCents ?? 0
  const nextValue = currentValue + proposal.grossCents
  if (nextValue > singleStockCap) {
    violations.push(violation('single_stock_cap', 'RISK_POSITION_CAP',
      `买入后该股约占净值 ${(nextValue / nav * 100).toFixed(1)}%，超过 ${(risk.maxSingleStockBp / 100).toFixed(0)}% 上限`,
      singleStockCap, nextValue))
  }

  const industryValue = ledger.positions
    .filter((p) => p.industryCode && p.industryCode === proposal.industryCode)
    .reduce((sum, p) => sum + p.marketValueCents, 0)
  if (industryValue + proposal.grossCents > industryCap) {
    violations.push(violation('industry_cap', 'RISK_INDUSTRY_CAP',
      `买入后该行业约占净值 ${((industryValue + proposal.grossCents) / nav * 100).toFixed(1)}%，超过 ${(risk.maxIndustryBp / 100).toFixed(0)}% 上限`,
      industryCap, industryValue + proposal.grossCents))
  }

  if (proposal.isNewPosition && ledger.positions.filter((p) => p.totalQty > 0).length >= risk.maxPositions) {
    violations.push(violation('max_positions', 'RISK_POSITION_CAP',
      `持仓已达 ${risk.maxPositions} 只上限，不能再开新仓`))
  }
  if (proposal.isNewPosition && ledger.dailyNewPositions >= risk.maxNewPositionsPerDay) {
    violations.push(violation('new_positions_per_day', 'RISK_POSITION_CAP',
      `今天已开过 ${risk.maxNewPositionsPerDay} 个新仓，明天再考虑`))
  }
  if (checkpoint === 'confirm' && ledger.dailyOrders >= risk.maxOrdersPerDay) {
    violations.push(violation('orders_per_day', 'RISK_POSITION_CAP',
      `今天委托数已达 ${risk.maxOrdersPerDay} 笔上限`))
  }
  if (remainingCash < cashBuffer) {
    violations.push(violation('cash_buffer', 'RISK_CASH',
      `成交后现金仅剩 ¥${(remainingCash / 100).toFixed(0)}，低于净值 ${(risk.minCashBufferBp / 100).toFixed(0)}% 的现金缓冲`,
      cashBuffer, remainingCash))
  }
  if (proposal.maxLossCents != null && proposal.maxLossCents > maxLossCap) {
    violations.push(violation('max_loss_per_trade', 'RISK_GAP',
      `按参考价算最大亏损 ¥${(proposal.maxLossCents / 100).toFixed(0)}，超过单笔上限 ¥${(maxLossCap / 100).toFixed(0)}`,
      maxLossCap, proposal.maxLossCents))
  }
  if (market.adv20Cents != null && !positionWithinAdv(nextValue, market.adv20Cents, risk)) {
    violations.push(violation('position_adv', 'RISK_POSITION_CAP',
      '该股持仓会超过 20 日成交额的 5%，流动性不足'))
  }
  if (ledger.dailyLossBp != null && ledger.dailyLossBp >= risk.maxDailyLossBp) {
    violations.push(violation('daily_loss', 'RISK_DAILY_LOSS', '今天亏损已达上限，暂停买入'))
  }
  if (ledger.drawdownBp != null && ledger.drawdownBp >= risk.maxDrawdownBp) {
    violations.push(violation('drawdown', 'RISK_DRAWDOWN', '组合回撤触发暂停，禁止新买入'))
  }
  if (proposal.confidenceScore != null && proposal.confidenceScore < risk.minConfidenceForBuy) {
    violations.push(violation('confidence_gate', 'DATA_QUALITY',
      `证据分 ${proposal.confidenceScore} 低于买入门槛 ${risk.minConfidenceForBuy}`))
  }

  return {
    ok: violations.length === 0,
    violations,
    budget: {
      singleStockCents: singleStockCap,
      industryCents: industryCap,
      maxLossCents: maxLossCap,
      cashBufferCents: cashBuffer,
      remainingCashCents: remainingCash,
    },
  }
}
