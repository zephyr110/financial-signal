import { describe, it, expect } from 'vitest'
import {
  aggregateCash,
  allocateSellToLots,
  derivePositions,
  PaperLedgerError,
  reconcileLedger,
  type LedgerCashEntry,
  type LedgerLot,
  type LedgerLotClose,
  type LedgerReservation,
} from '../lib/paper/ledger'
import { calcFees } from '../lib/paper/market'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

const accountId = 'paper-e1'

function cashEntry(
  id: string,
  kind: LedgerCashEntry['kind'],
  amountCents: number,
  tradeDate = '2026-03-02',
): LedgerCashEntry {
  return {
    id,
    accountId,
    kind,
    amountCents,
    balanceAfterCents: 0,
    refType: 'test',
    refId: id,
    tradeDate,
  }
}

function lot(id: string, openDate: string, qty: number, cost: number): LedgerLot {
  return {
    id,
    accountId,
    symbolCode: '600519.SH',
    openFillId: `fill-${id}`,
    openDate,
    qtyOpened: qty,
    costTotalCents: cost,
  }
}

describe('FIFO 平仓分配', () => {
  it('跨批次按比例分摊，成本精确归零', () => {
    const lots = [lot('L1', '2026-01-01', 100, 100_000), lot('L2', '2026-02-01', 200, 300_000)]
    const closes = allocateSellToLots({
      accountId,
      symbolCode: '600519.SH',
      sellQty: 150,
      grossProceedsCents: 240_000,
      tradeDate: '2026-03-01',
      sellFillId: 'fill-sell-1',
      lots,
      closes: [],
      closeIdPrefix: 'close-1',
      pendingDividendGrossByLot: { L1: 1_000, L2: 2_000 },
      dividendTax: DEFAULT_PAPER_POLICY.dividendTax,
    })

    expect(closes).toHaveLength(2)
    expect(closes[0]).toMatchObject({
      lotId: 'L1', qty: 100, costCents: 100_000, proceedsCents: 160_000,
      realizedPnlCents: 60_000, holdingDays: 59, dividendTaxCents: 100,
    })
    expect(closes[1]).toMatchObject({
      lotId: 'L2', qty: 50, costCents: 75_000, proceedsCents: 80_000,
      realizedPnlCents: 5_000, holdingDays: 28, dividendTaxCents: 100,
    })
    expect(closes.reduce((s, c) => s + c.costCents, 0)).toBe(175_000)
    expect(closes.reduce((s, c) => s + c.proceedsCents, 0)).toBe(240_000)
    expect(closes.reduce((s, c) => s + c.realizedPnlCents, 0)).toBe(65_000)
  })

  it('不足批次可卖时拒绝，而不是卖出空气', () => {
    expect(() => allocateSellToLots({
      accountId,
      symbolCode: '600519.SH',
      sellQty: 150,
      grossProceedsCents: 240_000,
      tradeDate: '2026-03-01',
      sellFillId: 'fill-sell-1',
      lots: [lot('L1', '2026-01-01', 100, 100_000)],
      closes: [],
      closeIdPrefix: 'close-1',
      dividendTax: DEFAULT_PAPER_POLICY.dividendTax,
    })).toThrow(PaperLedgerError)
  })
})

describe('批次派生持仓与 T+1', () => {
  const lots = [lot('old', '2026-02-01', 100, 100_000), lot('today', '2026-03-02', 100, 100_000)]
  const reservation: LedgerReservation = {
    id: 'r1', accountId, orderId: 'o1', kind: 'shares', symbolCode: '600519.SH',
    amountCents: 0, qty: 30, status: 'held',
  }

  it('当日买入不可卖，冻结股数包含 T+1 锁定', () => {
    const positions = derivePositions({ lots, closes: [], reservations: [], tradeDate: '2026-03-02' })
    expect(positions[0]).toMatchObject({ totalQty: 200, availableQty: 100, frozenQty: 100 })
    expect(positions[0].availableQty + positions[0].frozenQty).toBe(positions[0].totalQty)
  })

  it('委托冻结从可卖中扣除，恒等式仍成立', () => {
    const positions = derivePositions({ lots, closes: [], reservations: [reservation], tradeDate: '2026-03-03' })
    expect(positions[0]).toMatchObject({ totalQty: 200, availableQty: 170, frozenQty: 30 })
  })

  it('冻结超过可卖时报错', () => {
    expect(() => derivePositions({
      lots: [lot('today', '2026-03-02', 100, 100_000)],
      closes: [],
      reservations: [reservation],
      tradeDate: '2026-03-02',
    })).toThrow(/FROZEN_EXCEEDS_SELLABLE|冻结股数超过可卖/)
  })
})

describe('四条恒等式对账', () => {
  const lots = [lot('L1', '2026-02-01', 100, 100_000)]
  const buyEntries = [
    cashEntry('e0', 'initial', 10_000_000, '2026-02-01'),
    cashEntry('e1', 'buy', -100_000, '2026-02-01'),
    cashEntry('e2', 'fee', -501, '2026-02-01'),
  ]

  it('买入后净值恒等；部分卖出、分红与红利税仍恒等', () => {
    const afterBuy = reconcileLedger({
      initialCashCents: 10_000_000,
      entries: buyEntries,
      lots,
      closes: [],
      reservations: [],
      tradeDate: '2026-03-01',
      pricesBySymbol: { '600519.SH': 1_100 },
    })
    expect(afterBuy.status).toBe('pass')
    expect(afterBuy.navCents).toBe(10_009_499)
    expect(afterBuy.checks.find((c) => c.name === 'identity2_pnl')?.pass).toBe(true)

    const closes = allocateSellToLots({
      accountId,
      symbolCode: '600519.SH',
      sellQty: 50,
      grossProceedsCents: 55_000,
      tradeDate: '2026-03-01',
      sellFillId: 'sell-1',
      lots,
      closes: [],
      closeIdPrefix: 'c1',
      dividendTax: DEFAULT_PAPER_POLICY.dividendTax,
    })
    const entries = [
      ...buyEntries,
      cashEntry('e3', 'sell', 55_000, '2026-03-01'),
      cashEntry('e4', 'fee', -501, '2026-03-01'),
      cashEntry('e5', 'tax', -28, '2026-03-01'),
      cashEntry('e6', 'dividend', 1_000, '2026-03-01'),
      cashEntry('e7', 'dividend_tax', -100, '2026-03-01'),
    ]
    const afterSell = reconcileLedger({
      initialCashCents: 10_000_000,
      entries,
      lots,
      closes,
      reservations: [],
      tradeDate: '2026-03-01',
      pricesBySymbol: { '600519.SH': 1_100 },
      accountCashCents: aggregateCash(entries).balanceCents,
      navCents: 10_009_870,
    })
    expect(afterSell.status).toBe('pass')
    expect(afterSell.realizedCents).toBe(5_000)
    expect(afterSell.unrealizedCents).toBe(5_000)
    expect(afterSell.taxesCents).toBe(128)
    expect(afterSell.dividendsCents).toBe(1_000)
    expect(afterSell.navCents).toBe(10_009_870)
  })

  it('缺价只降级为 missing_price，不按 0 记账', () => {
    const result = reconcileLedger({
      initialCashCents: 10_000_000,
      entries: buyEntries,
      lots,
      closes: [],
      reservations: [],
      tradeDate: '2026-03-01',
      pricesBySymbol: {},
    })
    expect(result.status).toBe('missing_price')
    expect(result.missingSymbols).toEqual(['600519.SH'])
    expect(result.marketValueCents).toBe(0)
  })

  it('物化持仓/净值不一致判 fail', () => {
    const result = reconcileLedger({
      initialCashCents: 10_000_000,
      entries: buyEntries,
      lots,
      closes: [],
      reservations: [],
      tradeDate: '2026-03-01',
      pricesBySymbol: { '600519.SH': 1_100 },
      navCents: 10_009_499 + 1,
      materializedPositions: [
        { symbolCode: '600519.SH', totalQty: 100, availableQty: 90, frozenQty: 10 },
      ],
    })
    expect(result.status).toBe('fail')
    const names = result.checks.filter((c) => !c.pass).map((c) => c.name)
    expect(names).toContain('materialized_nav')
    expect(names).toContain('position_match:600519.SH')
  })

  it('现金流水为负直接拒绝', () => {
    expect(() => aggregateCash([cashEntry('x', 'adjustment', -1)])).toThrow(/现金余额为负/)
  })
})

describe('账本序列属性', () => {
  it('随机买卖序列下恒等式 2 始终成立', () => {
    let seed = 20261123
    const rand = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }

    const initialCashCents = 100_000_000
    const entries: LedgerCashEntry[] = [cashEntry('e0', 'initial', initialCashCents, '2026-01-05')]
    const lots: LedgerLot[] = []
    const closes: LedgerLotClose[] = []
    let cash = initialCashCents
    let tradeDate = '2026-01-05'
    let seq = 0

    const record = (kind: LedgerCashEntry['kind'], amount: number) => {
      cash += amount
      seq += 1
      entries.push(cashEntry(`e${seq}`, kind, amount, tradeDate))
    }

    const buyPrice = 1_000
    const buyQty = 1_000
    const buyFees = calcFees('buy', buyQty, buyPrice, buyPrice, DEFAULT_PAPER_POLICY.fees)
    record('buy', -buyFees.grossCents)
    record('fee', -(buyFees.commissionCents + buyFees.transferFeeCents))
    lots.push({
      id: 'L1', accountId, symbolCode: '600519.SH', openFillId: 'buy-1',
      openDate: tradeDate, qtyOpened: buyQty, costTotalCents: buyFees.grossCents,
    })

    let price = buyPrice
    let day = 6
    for (let i = 0; i < 40; i += 1) {
      price = Math.max(100, Math.round(price * (0.97 + rand() * 0.06)))
      day = Math.min(28, day + 1)
      tradeDate = `2026-01-${String(day).padStart(2, '0')}`
      const held = lots.reduce((s, l) => s + l.qtyOpened, 0)
        - closes.reduce((s, c) => s + c.qty, 0)
      if (held > 100 && rand() > 0.45) {
        const sellQty = 100 * (1 + Math.floor(rand() * 2))
        const qty = Math.min(held, sellQty)
        const fees = calcFees('sell', qty, price, price, DEFAULT_PAPER_POLICY.fees)
        const allocated = allocateSellToLots({
          accountId,
          symbolCode: '600519.SH',
          sellQty: qty,
          grossProceedsCents: fees.grossCents,
          tradeDate,
          sellFillId: `sell-${i}`,
          lots,
          closes,
          closeIdPrefix: `close-${i}`,
          dividendTax: DEFAULT_PAPER_POLICY.dividendTax,
        })
        closes.push(...allocated)
        record('sell', fees.grossCents)
        record('fee', -(fees.commissionCents + fees.transferFeeCents))
        record('tax', -fees.stampTaxCents)
      }

      const result = reconcileLedger({
        initialCashCents,
        entries,
        lots,
        closes,
        reservations: [],
        tradeDate,
        pricesBySymbol: { '600519.SH': price },
        accountCashCents: cash,
      })
      const identity2 = result.checks.find((c) => c.name === 'identity2_pnl')
      expect(identity2?.pass, `${tradeDate} 第 ${i} 步恒等式失败: ${JSON.stringify(identity2)}`).toBe(true)
      expect(result.status).toBe('pass')
    }
  })
})
