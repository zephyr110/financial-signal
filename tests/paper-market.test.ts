import { describe, it, expect } from 'vitest'
import {
  averageDailyTurnoverCents,
  boardLabel,
  buyExclusionReason,
  calcDividendTax,
  calcFees,
  cashInLieuCents,
  corporateActionShares,
  dividendTaxBp,
  lotRuleFor,
  positionWithinAdv,
  priceLimitBpFor,
  resolveBoard,
  resolveTradePrice,
  sizeBuyQuantity,
  theoreticalLimitPrices,
  validateSellQuantity,
} from '../lib/paper/market'
import { DEFAULT_PAPER_POLICY, policyHash, stableStringify, validatePaperPolicy } from '../lib/paper/policy'
import type { DailyBar, MarketStatus, SymbolMeta } from '../lib/paper/types'

function meta(overrides: Partial<SymbolMeta> = {}): SymbolMeta {
  return {
    symbolCode: '600519.SH',
    name: '贵州茅台',
    exchange: 'SH',
    board: 'main_sh',
    industryCode: '801120',
    industryName: '食品饮料',
    isSt: false,
    lotSize: 100,
    limitPctBp: 1_000,
    noPriceLimit: false,
    listDate: '2001-08-27',
    delistDate: null,
    sourceId: 'test',
    validFrom: '2026-01-01',
    validTo: null,
    ...overrides,
  }
}

function status(overrides: Partial<MarketStatus> = {}): MarketStatus {
  return {
    symbolCode: '600519.SH',
    tradeDate: '2026-11-24',
    isSuspended: false,
    isSt: false,
    source: 'test',
    ...overrides,
  }
}

describe('A 股板别与手数', () => {
  it('按代码段识别板别，未知代码不猜', () => {
    expect(resolveBoard('600519.SH')).toBe('main_sh')
    expect(resolveBoard('601318.SH')).toBe('main_sh')
    expect(resolveBoard('603288.SH')).toBe('main_sh')
    expect(resolveBoard('605499.SH')).toBe('main_sh')
    expect(resolveBoard('688981.SH')).toBe('star')
    expect(resolveBoard('689009.SH')).toBe('star')
    expect(resolveBoard('000001.SZ')).toBe('main_sz')
    expect(resolveBoard('002594.SZ')).toBe('main_sz')
    expect(resolveBoard('300750.SZ')).toBe('chinext')
    expect(resolveBoard('301269.SZ')).toBe('chinext')
    expect(resolveBoard('830799.BJ')).toBe('bse')
    expect(resolveBoard('900901.SH')).toBeNull()
    expect(resolveBoard('200596.SZ')).toBeNull()
    expect(resolveBoard('600519')).toBeNull()
    expect(boardLabel('chinext')).toBe('创业板')
  })

  it('买入股数按手数向下取整，科创板 200 股起', () => {
    expect(sizeBuyQuantity(150, 'main_sh')).toBe(100)
    expect(sizeBuyQuantity(99, 'main_sz')).toBe(0)
    expect(sizeBuyQuantity(150, 'chinext')).toBe(100)
    expect(sizeBuyQuantity(199, 'star')).toBe(0)
    expect(sizeBuyQuantity(200, 'star')).toBe(200)
    expect(sizeBuyQuantity(250, 'star')).toBe(250)
    expect(lotRuleFor('star').minQty).toBe(200)
    expect(lotRuleFor('main_sh').step).toBe(100)
  })

  it('卖出零股只能一次清仓', () => {
    expect(validateSellQuantity({ qty: 100, availableQty: 100, totalQty: 100, board: 'main_sh' })).toEqual({ ok: true })
    expect(validateSellQuantity({ qty: 35, availableQty: 100, totalQty: 100, board: 'main_sh' }))
      .toEqual({ ok: false, reason: 'ODD_LOT' })
    expect(validateSellQuantity({ qty: 35, availableQty: 35, totalQty: 35, board: 'main_sh' })).toEqual({ ok: true })
    expect(validateSellQuantity({ qty: 150, availableQty: 100, totalQty: 150, board: 'main_sh' }))
      .toEqual({ ok: false, reason: 'RISK_T1' })
    expect(validateSellQuantity({ qty: 0, availableQty: 100, totalQty: 100, board: 'main_sh' }))
      .toEqual({ ok: false, reason: 'QTY_INVALID' })
  })
})

describe('涨跌停与成交价', () => {
  it('主板 10%、ST 5%、创业板/科创板 20%、北交所 30%，四舍五入到分', () => {
    expect(priceLimitBpFor('main_sh', false)).toBe(1_000)
    expect(priceLimitBpFor('main_sh', true)).toBe(500)
    expect(priceLimitBpFor('chinext', true)).toBe(2_000)
    expect(priceLimitBpFor('star', false)).toBe(2_000)
    expect(priceLimitBpFor('bse', false)).toBe(3_000)
    expect(theoreticalLimitPrices(1_005, 'main_sh', false))
      .toEqual({ limitUpCents: 1_106, limitDownCents: 905 })
    expect(theoreticalLimitPrices(1_000, 'main_sh', true))
      .toEqual({ limitUpCents: 1_050, limitDownCents: 950 })
  })

  it('买入向上取整、卖出向下取整，并夹在涨跌停内', () => {
    const buy = resolveTradePrice({
      side: 'buy', openCents: 1_000, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
    })
    expect(buy).toEqual({ ok: true, priceCents: 1_001, slippageCents: 1 })

    const sell = resolveTradePrice({
      side: 'sell', openCents: 1_000, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
    })
    expect(sell).toEqual({ ok: true, priceCents: 999, slippageCents: 1 })

    const buyAtCap = resolveTradePrice({
      side: 'buy', openCents: 1_099, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
    })
    expect(buyAtCap).toEqual({ ok: true, priceCents: 1_100, slippageCents: 1 })

    expect(resolveTradePrice({
      side: 'buy', openCents: 1_100, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
    })).toEqual({ ok: false, reasonCode: 'LIMIT_UP' })

    expect(resolveTradePrice({
      side: 'sell', openCents: 900, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
    })).toEqual({ ok: false, reasonCode: 'LIMIT_DOWN' })
  })

  it('开盘条件单不满足即作废；买入条件价封顶成交价', () => {
    expect(resolveTradePrice({
      side: 'buy', openCents: 1_005, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
      condition: { op: 'lte', priceCents: 1_000 },
    })).toEqual({ ok: false, reasonCode: 'TRIGGER_NOT_MET' })

    const capped = resolveTradePrice({
      side: 'buy', openCents: 995, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
      condition: { op: 'lte', priceCents: 995 },
    })
    expect(capped).toEqual({ ok: true, priceCents: 995, slippageCents: 0 })

    const sellCapped = resolveTradePrice({
      side: 'sell', openCents: 1_005, slippagePpm: 500,
      limitUpCents: 1_100, limitDownCents: 900,
      condition: { op: 'gte', priceCents: 1_005 },
    })
    expect(sellCapped).toEqual({ ok: true, priceCents: 1_005, slippageCents: 0 })
  })
})

describe('费用与红利税', () => {
  it('佣金最低 ¥5，卖出加印花税，过户费双边', () => {
    const buy = calcFees('buy', 100, 1_000, 1_000, DEFAULT_PAPER_POLICY.fees)
    expect(buy).toEqual({
      grossCents: 100_000,
      commissionCents: 500,
      stampTaxCents: 0,
      transferFeeCents: 1,
      totalFeesCents: 501,
      slippageCents: 0,
    })

    const sell = calcFees('sell', 100, 1_000, 1_000, DEFAULT_PAPER_POLICY.fees)
    expect(sell.stampTaxCents).toBe(50)
    expect(sell.totalFeesCents).toBe(551)

    const big = calcFees('buy', 10_000, 1_000, 1_000, DEFAULT_PAPER_POLICY.fees)
    expect(big.commissionCents).toBe(2_500)
    expect(big.transferFeeCents).toBe(100)
  })

  it('红利税按持有期分档，未知按 10% 保守预扣', () => {
    const p = DEFAULT_PAPER_POLICY.dividendTax
    expect(dividendTaxBp(10, p)).toBe(2_000)
    expect(dividendTaxBp(30, p)).toBe(2_000)
    expect(dividendTaxBp(31, p)).toBe(1_000)
    expect(dividendTaxBp(365, p)).toBe(1_000)
    expect(dividendTaxBp(366, p)).toBe(0)
    expect(dividendTaxBp(100, p, false)).toBe(1_000)
    expect(calcDividendTax(10_000, 10, p)).toBe(2_000)
    expect(calcDividendTax(10_000, 366, p)).toBe(0)
    expect(calcDividendTax(10_001, 31, p)).toBe(1_001)
  })

  it('送转股数与零股折现', () => {
    expect(corporateActionShares(100, 3)).toEqual({ whole: 130, remainder: 0, denominator: 10 })
    expect(corporateActionShares(105, 3)).toEqual({ whole: 136, remainder: 5, denominator: 10 })
    expect(cashInLieuCents(5, 10, 1_000)).toBe(500)
    expect(corporateActionShares(100, 0, 2, 1)).toEqual({ whole: 200, remainder: 0, denominator: 10 })
  })
})

describe('股票池与流动性', () => {
  const risk = DEFAULT_PAPER_POLICY.risk

  it('ADV 要求完整 20 个交易日', () => {
    const bars: DailyBar[] = Array.from({ length: 20 }, (_, i) => ({
      symbolCode: '600519.SH',
      tradeDate: `2026-11-${String(i + 1).padStart(2, '0')}`,
      openCents: 1_000,
      closeCents: 1_000,
      prevCloseCents: 1_000,
      amountCents: 1_000_000,
    }))
    expect(averageDailyTurnoverCents(bars)).toBe(1_000_000)
    expect(averageDailyTurnoverCents(bars.slice(0, 19))).toBeNull()
    expect(positionWithinAdv(1_000_000, 100_000_000, risk)).toBe(true)
    expect(positionWithinAdv(5_000_001, 100_000_000, risk)).toBe(false)
  })

  it('新开仓排除项可解释', () => {
    const base = { listedTradingDays: 200, adv20Cents: 10_000_000_000, risk }
    expect(buyExclusionReason(meta(), status(), base)).toBeNull()
    expect(buyExclusionReason(null, status(), base)).toBe('MISSING_META')
    expect(buyExclusionReason(meta({ board: 'bse' }), status(), base)).toBe('BSE')
    expect(buyExclusionReason(meta({ isSt: true }), status(), base)).toBe('ST')
    expect(buyExclusionReason(meta({ delistDate: '2026-01-01' }), status(), base)).toBe('DELISTED')
    expect(buyExclusionReason(meta(), status({ isSuspended: true }), base)).toBe('SUSPENDED')
    expect(buyExclusionReason(meta(), status(), { ...base, listedTradingDays: 59 })).toBe('NEW_STOCK')
    expect(buyExclusionReason(meta(), status(), { ...base, listedTradingDays: null })).toBe('MISSING_META')
    expect(buyExclusionReason(meta(), status(), { ...base, adv20Cents: null })).toBe('MISSING_ADV')
    expect(buyExclusionReason(meta(), status(), { ...base, adv20Cents: 1_000 })).toBe('LOW_LIQUIDITY')
  })
})

describe('政策版本', () => {
  it('键顺序不影响哈希', () => {
    const a = { foo: 1, bar: { b: 2, a: [3, { z: 1, y: 2 }] } }
    const b = { bar: { a: [3, { y: 2, z: 1 }], b: 2 }, foo: 1 }
    expect(stableStringify(a)).toBe(stableStringify(b))
    expect(policyHash(DEFAULT_PAPER_POLICY)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('默认政策通过校验，负值被拒绝', () => {
    expect(() => validatePaperPolicy(DEFAULT_PAPER_POLICY)).not.toThrow()
    const broken = { ...DEFAULT_PAPER_POLICY, fees: { ...DEFAULT_PAPER_POLICY.fees, commissionPpm: -1 } }
    expect(() => validatePaperPolicy(broken)).toThrow(/commissionPpm/)
  })
})
