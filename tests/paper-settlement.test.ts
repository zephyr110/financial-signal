import { describe, it, expect } from 'vitest'
import { planSettlement, type PlanSettlementInput } from '../lib/paper/settlement'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'
import type { LedgerLot } from '../lib/paper/ledger'
import type { DailyBar, MarketStatus, PriceLimit, SymbolMeta } from '../lib/paper/types'

const tradeDate = '2026-03-02'

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

function bar(openCents: number): DailyBar {
  return {
    symbolCode: '600519.SH',
    tradeDate,
    openCents,
    closeCents: openCents,
    prevCloseCents: 1_000,
    amountCents: 100_000_000,
  }
}

function limit(limitUpCents = 1_100, limitDownCents = 900): PriceLimit {
  return { symbolCode: '600519.SH', tradeDate, limitUpCents, limitDownCents, sourceId: 'test-limits' }
}

function status(overrides: Partial<MarketStatus> = {}): MarketStatus {
  return { symbolCode: '600519.SH', tradeDate, isSuspended: false, isSt: false, source: 'test', ...overrides }
}

function input(overrides: Partial<PlanSettlementInput> = {}): PlanSettlementInput {
  return {
    order: {
      id: 'o1',
      accountId: 'acc1',
      cardId: 'c1',
      cardVersion: 1,
      symbolCode: '600519.SH',
      side: 'buy',
      orderType: 'open_market',
      qty: 100,
      conditionOp: null,
      triggerPriceCents: null,
      targetTradeDate: tradeDate,
    },
    card: {
      id: 'c1',
      version: 1,
      status: 'confirmed',
      symbolCode: '600519.SH',
      stopPriceCents: 950,
      maxLossCents: 100_000,
    },
    meta: meta(),
    board: 'main_sh',
    market: { bar: bar(1_000), limit: limit(), status: status() },
    isTradingDay: true,
    dataQuality: 'pass',
    risk: { killSwitch: false, killSwitchReason: null, blocksSells: false },
    navCents: 10_000_000,
    position: { totalQty: 0, availableQty: 0, frozenQty: 0 },
    lots: [],
    closes: [],
    reservedCashCents: 200_000,
    reservedShareQty: 0,
    cashLedgerBeforeCents: 1_000_000,
    policy: DEFAULT_PAPER_POLICY,
    settledAt: '2026-03-02T16:20:05+08:00',
    ...overrides,
  }
}

function lot(id: string, openDate: string, qtyOpened: number, costTotalCents: number): LedgerLot {
  return {
    id,
    accountId: 'acc1',
    symbolCode: '600519.SH',
    openFillId: `fill-${id}`,
    openDate,
    qtyOpened,
    costTotalCents,
  }
}

describe('16:20 买入结算', () => {
  it('按官方开盘价+滑点成交，现金流水余额连续，开新批次', () => {
    const decision = planSettlement(input())

    expect(decision.outcome).toBe('fill')
    expect(decision.nextOrderStatus).toBe('filled')
    expect(decision.nextCardStatus).toBe('executed')
    expect(decision.fill).toMatchObject({
      qty: 100,
      priceCents: 1_001,
      grossCents: 100_100,
      commissionCents: 500,
      transferFeeCents: 2,
      totalFeesCents: 502,
      tradeTime: '09:25',
      priceBasis: 'official_daily_open',
      priceSourceId: 'test-limits',
    })
    expect(decision.cashEntries).toMatchObject([
      { kind: 'buy', amountCents: -100_100, balanceAfterCents: 899_900 },
      { kind: 'fee', amountCents: -502, balanceAfterCents: 899_398 },
    ])
    expect(decision.lot).toMatchObject({
      symbolCode: '600519.SH',
      openDate: tradeDate,
      qtyOpened: 100,
      costTotalCents: 100_100,
    })
  })

  it('开盘涨停不模拟排队，直接拒绝', () => {
    const decision = planSettlement(input({ market: { bar: bar(1_100), limit: limit(), status: status() } }))
    expect(decision).toMatchObject({
      outcome: 'reject',
      nextOrderStatus: 'rejected',
      nextCardStatus: 'expired',
      reasonCode: 'LIMIT_UP',
    })
    expect(decision.fill).toBeUndefined()
  })

  it('条件单开盘未触发，卡片转为未触发', () => {
    const decision = planSettlement(input({
      order: {
        ...input().order,
        orderType: 'open_price_condition',
        conditionOp: 'lte',
        triggerPriceCents: 995,
      },
    }))
    expect(decision).toMatchObject({
      outcome: 'trigger_not_met',
      nextOrderStatus: 'trigger_not_met',
      nextCardStatus: 'not_triggered',
      reasonCode: 'TRIGGER_NOT_MET',
    })
  })

  it('冻结现金不足不成交', () => {
    const decision = planSettlement(input({ reservedCashCents: 100_000 }))
    expect(decision).toMatchObject({ outcome: 'reject', reasonCode: 'RISK_CASH' })
  })

  it('按开盘价重算的最大亏损超过净值 2% 时拒绝', () => {
    const decision = planSettlement(input({
      navCents: 500_000,
      order: { ...input().order, qty: 1_000 },
      card: { ...input().card!, stopPriceCents: 990, maxLossCents: 50_000 },
      reservedCashCents: 2_000_000,
      cashLedgerBeforeCents: 5_000_000,
    }))
    expect(decision).toMatchObject({ outcome: 'reject', nextOrderStatus: 'rejected', reasonCode: 'RISK_GAP' })
    expect(decision.detail).toMatch(/最大亏损/)
  })

  it('买入卡缺少数字止损价时拒绝', () => {
    const decision = planSettlement(input({ card: { ...input().card!, stopPriceCents: null } }))
    expect(decision).toMatchObject({ outcome: 'reject', reasonCode: 'DATA_QUALITY' })
  })
})

describe('16:20 卖出结算', () => {
  const lots = [
    lot('L1', '2026-01-01', 100, 100_000),
    lot('L2', '2026-02-01', 100, 100_000),
  ]
  const sellInput = (overrides: Partial<PlanSettlementInput> = {}) => input({
    order: {
      id: 'o-sell',
      accountId: 'acc1',
      cardId: null,
      cardVersion: null,
      symbolCode: '600519.SH',
      side: 'sell',
      orderType: 'open_market',
      qty: 200,
      conditionOp: null,
      triggerPriceCents: null,
      targetTradeDate: tradeDate,
    },
    card: null,
    position: { totalQty: 200, availableQty: 0, frozenQty: 200 },
    lots,
    reservedCashCents: 0,
    reservedShareQty: 200,
    pendingDividendGrossByLot: { L1: 1_000, L2: 2_000 },
    ...overrides,
  })

  it('FIFO 平仓、印花税与红利税各记一笔，余额连续', () => {
    const decision = planSettlement(sellInput())

    expect(decision.outcome).toBe('fill')
    expect(decision.nextCardStatus).toBeNull()
    expect(decision.fill?.priceCents).toBe(999)
    expect(decision.fill?.grossCents).toBe(199_800)
    expect(decision.fill?.totalFeesCents).toBe(602)

    expect(decision.lotCloses).toMatchObject([
      { lotId: 'L1', qty: 100, costCents: 100_000, proceedsCents: 99_900, realizedPnlCents: -100, holdingDays: 60, dividendTaxCents: 100 },
      { lotId: 'L2', qty: 100, costCents: 100_000, proceedsCents: 99_900, realizedPnlCents: -100, holdingDays: 29, dividendTaxCents: 400 },
    ])

    const entries = decision.cashEntries ?? []
    expect(entries.map((e) => e.kind)).toEqual(['sell', 'fee', 'tax', 'dividend_tax'])
    expect(entries[0]).toMatchObject({ amountCents: 199_800, balanceAfterCents: 1_199_800 })
    expect(entries[1]).toMatchObject({ amountCents: -502, balanceAfterCents: 1_199_298 })
    expect(entries[2]).toMatchObject({ amountCents: -100, balanceAfterCents: 1_199_198 })
    expect(entries[3]).toMatchObject({ amountCents: -500, balanceAfterCents: 1_198_698 })
  })

  it('零股必须一次清仓', () => {
    const decision = planSettlement(sellInput({
      order: { ...sellInput().order, qty: 50 },
      position: { totalQty: 100, availableQty: 0, frozenQty: 100 },
      lots: [lots[0]],
      reservedShareQty: 50,
    }))
    expect(decision).toMatchObject({ outcome: 'reject', reasonCode: 'ODD_LOT' })
  })

  it('股数冻结不足时拒绝，不靠可用数硬卖', () => {
    const decision = planSettlement(sellInput({
      order: { ...sellInput().order, qty: 100 },
      position: { totalQty: 200, availableQty: 150, frozenQty: 50 },
      reservedShareQty: 50,
    }))
    expect(decision).toMatchObject({ outcome: 'reject', reasonCode: 'DATA_QUALITY' })
    expect(decision.detail).toMatch(/股数冻结不足/)
  })

  it('kill switch 停止买入，但普通回撤允许减仓', () => {
    const kill = { killSwitch: true, killSwitchReason: 'RISK_DRAWDOWN' as const, blocksSells: false }
    expect(planSettlement(input({ risk: kill }))).toMatchObject({ outcome: 'reject', reasonCode: 'RISK_DRAWDOWN' })
    expect(planSettlement(sellInput({ risk: kill })).outcome).toBe('fill')

    const ledgerBroken = { killSwitch: true, killSwitchReason: 'RISK_DRAWDOWN' as const, blocksSells: true }
    expect(planSettlement(sellInput({ risk: ledgerBroken }))).toMatchObject({ outcome: 'reject', reasonCode: 'RISK_DRAWDOWN' })
  })
})

describe('数据与状态门', () => {
  it('缺官方日线/涨跌停/停牌状态时作废该笔，不按 0 成交', () => {
    expect(planSettlement(input({ market: { bar: null, limit: limit(), status: status() } })))
      .toMatchObject({ outcome: 'expire', nextOrderStatus: 'expired', reasonCode: 'MISSING_PRICE' })
    expect(planSettlement(input({ market: { bar: bar(1_000), limit: null, status: status() } })))
      .toMatchObject({ outcome: 'expire', reasonCode: 'MISSING_PRICE' })
    expect(planSettlement(input({ market: { bar: bar(1_000), limit: limit(), status: null } })))
      .toMatchObject({ outcome: 'expire', reasonCode: 'MISSING_PRICE' })
  })

  it('非交易日、数据质量 fail、停牌都不得成交', () => {
    expect(planSettlement(input({ isTradingDay: false })))
      .toMatchObject({ outcome: 'expire', nextOrderStatus: 'expired' })
    expect(planSettlement(input({ dataQuality: 'fail' })))
      .toMatchObject({ outcome: 'expire', nextOrderStatus: 'expired' })
    expect(planSettlement(input({ market: { bar: bar(1_000), limit: limit(), status: status({ isSuspended: true }) } })))
      .toMatchObject({ outcome: 'reject', reasonCode: 'SUSPENDED' })
  })

  it('ST/退市不可买入，卖出不受限', () => {
    expect(planSettlement(input({ meta: meta({ isSt: true }) })))
      .toMatchObject({ outcome: 'reject', reasonCode: 'DATA_QUALITY' })
    expect(planSettlement(input({ meta: meta({ delistDate: '2026-01-01' }) })))
      .toMatchObject({ outcome: 'reject', reasonCode: 'DATA_QUALITY' })
  })

  it('卡片版本漂移或状态已失效时拒绝，且不改写卡片历史状态', () => {
    const versionDrift = planSettlement(input({
      order: { ...input().order, cardVersion: 2 },
    }))
    expect(versionDrift).toMatchObject({ outcome: 'reject', reasonCode: 'DATA_QUALITY', nextCardStatus: null })

    const invalidated = planSettlement(input({ card: { ...input().card!, status: 'invalidated' } }))
    expect(invalidated).toMatchObject({ outcome: 'reject', nextCardStatus: null })
  })

  it('账本自相矛盾（现金为负）标记 fatalLedger，交上层停牌', () => {
    const decision = planSettlement(input({
      reservedCashCents: 200_000,
      cashLedgerBeforeCents: 50_000,
    }))
    expect(decision).toMatchObject({ outcome: 'reject', fatalLedger: true })
  })
})
