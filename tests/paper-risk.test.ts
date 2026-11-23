import { describe, it, expect } from 'vitest'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'
import { evaluateRisk, type EvaluateRiskInput, type RiskEvaluation } from '../lib/paper/risk'
import type { MarketStatus, SymbolMeta } from '../lib/paper/types'

/**
 * 风控纯函数：卡生成与确认共用的规则。
 * 单票 20%、行业 40%、最多 5 只、每日 1 新仓/3 笔、5% 现金缓冲、
 * 单笔最大亏损 2%、日亏 2%、回撤 10%、一手可行性、T+1、kill switch。
 */

const NAV = 50_000_000
const SYMBOL = '600000.SH'

function meta(overrides: Partial<SymbolMeta> = {}): SymbolMeta {
  return {
    symbolCode: SYMBOL,
    name: '浦发银行',
    exchange: 'SH',
    board: 'main_sh',
    industryCode: '801780',
    industryName: '银行',
    isSt: false,
    lotSize: 100,
    limitPctBp: 1000,
    noPriceLimit: false,
    listDate: '1999-11-10',
    delistDate: null,
    sourceId: 'test',
    validFrom: '2020-01-01',
    validTo: null,
    ...overrides,
  }
}

function status(overrides: Partial<MarketStatus> = {}): MarketStatus {
  return {
    symbolCode: SYMBOL,
    tradeDate: '2026-11-24',
    isSuspended: false,
    isSt: false,
    source: 'test',
    ...overrides,
  }
}

function build(overrides: {
  checkpoint?: 'card' | 'confirm'
  gate?: Partial<EvaluateRiskInput['gate']>
  ledger?: Partial<EvaluateRiskInput['ledger']>
  proposal?: Partial<EvaluateRiskInput['proposal']>
  market?: Partial<EvaluateRiskInput['market']>
} = {}): EvaluateRiskInput {
  return {
    checkpoint: overrides.checkpoint ?? 'confirm',
    policy: DEFAULT_PAPER_POLICY,
    gate: {
      killSwitch: false,
      killReason: null,
      blocksSells: false,
      dataQuality: 'pass',
      ...overrides.gate,
    },
    ledger: {
      navCents: NAV,
      cashCents: NAV,
      positions: [],
      dailyOrders: 0,
      dailyNewPositions: 0,
      dailyLossBp: null,
      drawdownBp: null,
      missingPriceSymbols: [],
      ...overrides.ledger,
    },
    proposal: {
      symbolCode: SYMBOL,
      industryCode: '801780',
      side: 'buy',
      qty: 100,
      priceCents: 10_000,
      grossCents: 1_000_000,
      feesCents: 260,
      stopPriceCents: 9_500,
      maxLossCents: 50_260,
      board: 'main_sh',
      lotSize: 100,
      isNewPosition: true,
      confidenceScore: 60,
      ...overrides.proposal,
    },
    market: {
      meta: meta(),
      status: status(),
      adv20Cents: 50_000_000_000,
      listedTradingDays: 500,
      ...overrides.market,
    },
  }
}

function rules(result: RiskEvaluation): string[] {
  return result.violations.map((v) => v.rule)
}

describe('买入风控', () => {
  it('健康账户通过，并给出各项预算', () => {
    const result = evaluateRisk(build())
    expect(result.ok).toBe(true)
    expect(result.violations).toEqual([])
    expect(result.budget).toEqual({
      singleStockCents: 10_000_000,
      industryCents: 20_000_000,
      maxLossCents: 1_000_000,
      cashBufferCents: 2_500_000,
      remainingCashCents: NAV - 1_000_000 - 260,
    })
  })

  it('缺净值或缺价持仓时禁止买入', () => {
    expect(rules(evaluateRisk(build({ ledger: { navCents: null } })))).toContain('single_stock_cap')
    const missing = evaluateRisk(build({ ledger: { missingPriceSymbols: ['000001.SZ'] } }))
    expect(missing.ok).toBe(false)
    expect(missing.violations[0]?.reasonCode).toBe('DATA_QUALITY')
  })

  it('一手市值超过单票上限时只能观察', () => {
    const result = evaluateRisk(build({
      ledger: { cashCents: 100_000_000 },
      proposal: {
        qty: 100,
        priceCents: 200_000,
        grossCents: 20_000_000,
        feesCents: 5_000,
        maxLossCents: 5_000_000,
      },
    }))
    expect(rules(result)).toContain('lot_feasibility')
    expect(result.violations.find((v) => v.rule === 'lot_feasibility')?.reasonCode).toBe('RISK_POSITION_CAP')
  })

  it('单票与行业仓位不得超过净值上限', () => {
    const single = evaluateRisk(build({
      ledger: {
        positions: [{ symbolCode: SYMBOL, industryCode: '801780', marketValueCents: 9_500_000, totalQty: 950, availableQty: 950 }],
      },
      proposal: { isNewPosition: false },
    }))
    expect(single.ok).toBe(false)
    expect(rules(single)).toContain('single_stock_cap')

    const industry = evaluateRisk(build({
      ledger: {
        positions: [{ symbolCode: '000001.SZ', industryCode: '801780', marketValueCents: 19_500_000, totalQty: 1000, availableQty: 1000 }],
      },
    }))
    expect(rules(industry)).toContain('industry_cap')
    expect(industry.violations.find((v) => v.rule === 'industry_cap')?.reasonCode).toBe('RISK_INDUSTRY_CAP')
  })

  it('最多 5 只持仓、每天最多 1 个新仓', () => {
    const positions = ['000001.SZ', '000002.SZ', '000003.SZ', '000004.SZ', '000005.SZ']
      .map((symbolCode) => ({
        symbolCode,
        industryCode: null,
        marketValueCents: 1_000_000,
        totalQty: 100,
        availableQty: 100,
      }))
    expect(rules(evaluateRisk(build({ ledger: { positions } })))).toContain('max_positions')
    expect(rules(evaluateRisk(build({ ledger: { dailyNewPositions: 1 } })))).toContain('new_positions_per_day')
  })

  it('每日委托笔数上限只在确认时检查', () => {
    const card = evaluateRisk(build({ checkpoint: 'card', ledger: { dailyOrders: 3 } }))
    expect(card.ok).toBe(true)
    const confirm = evaluateRisk(build({ checkpoint: 'confirm', ledger: { dailyOrders: 3 } }))
    expect(rules(confirm)).toContain('orders_per_day')
  })

  it('现金缓冲、单笔亏损、日亏损与回撤', () => {
    expect(rules(evaluateRisk(build({ ledger: { cashCents: 3_000_000 } })))).toContain('cash_buffer')
    expect(rules(evaluateRisk(build({ proposal: { maxLossCents: 1_200_000 } })))).toContain('max_loss_per_trade')
    expect(rules(evaluateRisk(build({ ledger: { dailyLossBp: 250 } })))).toContain('daily_loss')
    expect(rules(evaluateRisk(build({ ledger: { drawdownBp: 1200 } })))).toContain('drawdown')
  })

  it('证据分低于 50 不得买入', () => {
    const result = evaluateRisk(build({ proposal: { confidenceScore: 45 } }))
    expect(rules(result)).toContain('confidence_gate')
    expect(result.ok).toBe(false)
  })

  it('ST、停牌、流动性不足与北交所均被排除', () => {
    expect(rules(evaluateRisk(build({ market: { meta: meta({ isSt: true }) } })))).toContain('excluded')
    const suspended = evaluateRisk(build({ market: { status: status({ isSuspended: true }) } }))
    expect(suspended.violations.find((v) => v.rule === 'suspended')?.reasonCode).toBe('SUSPENDED')
    expect(rules(evaluateRisk(build({ market: { adv20Cents: 1_000_000 } })))).toContain('liquidity')
    expect(rules(evaluateRisk(build({ market: { adv20Cents: null } })))).toContain('liquidity')
    expect(rules(evaluateRisk(build({ market: { meta: meta({ board: 'bse' }) } })))).toContain('excluded')
  })

  it('买入数量必须是整手', () => {
    const result = evaluateRisk(build({
      proposal: { qty: 150, grossCents: 1_500_000 },
    }))
    expect(rules(result)).toContain('lot_feasibility')
    expect(result.violations.find((v) => v.rule === 'lot_feasibility')?.reasonCode).toBe('DATA_QUALITY')
  })

  it('数据质量 fail 时全面暂停', () => {
    expect(rules(evaluateRisk(build({ gate: { dataQuality: 'fail' } })))).toContain('data_quality')
  })
})

describe('卖出风控', () => {
  const held = (availableQty: number, totalQty: number) => [{
    symbolCode: SYMBOL,
    industryCode: '801780',
    marketValueCents: totalQty * 10_000,
    totalQty,
    availableQty,
  }]

  function sell(overrides: Parameters<typeof build>[0] = {}) {
    return build({
      ledger: { positions: held(100, 100), ...(overrides.ledger ?? {}) },
      proposal: {
        side: 'sell',
        qty: 100,
        grossCents: 1_000_000,
        feesCents: 510,
        stopPriceCents: null,
        maxLossCents: null,
        isNewPosition: false,
        confidenceScore: null,
        ...(overrides.proposal ?? {}),
      },
      gate: overrides.gate,
      market: overrides.market,
      checkpoint: overrides.checkpoint,
    })
  }

  it('T+1 当天买入不可卖，次日可卖', () => {
    const t1 = evaluateRisk(sell({ ledger: { positions: held(0, 100) } }))
    expect(t1.violations.find((v) => v.rule === 'available_shares')?.reasonCode).toBe('RISK_T1')
    expect(evaluateRisk(sell()).ok).toBe(true)
  })

  it('零股必须一次清仓', () => {
    const result = evaluateRisk(sell({ ledger: { positions: held(50, 150) }, proposal: { qty: 50 } }))
    expect(result.violations.find((v) => v.rule === 'available_shares')?.reasonCode).toBe('ODD_LOT')
  })

  it('停牌时卖不出', () => {
    const result = evaluateRisk(sell({ market: { status: status({ isSuspended: true }) } }))
    expect(result.violations.find((v) => v.rule === 'suspended')?.reasonCode).toBe('SUSPENDED')
  })
})

describe('kill switch', () => {
  it('买入一律拒绝，原因码沿用停牌原因', () => {
    const result = evaluateRisk(build({ gate: { killSwitch: true, killReason: 'LEDGER_MISMATCH' } }))
    expect(result.ok).toBe(false)
    expect(result.violations.find((v) => v.rule === 'kill_switch')?.reasonCode).toBe('LEDGER_MISMATCH')
  })

  it('账本不一致连卖出也要人工复核，其他停机原因允许减仓', () => {
    const positions = [{
      symbolCode: SYMBOL,
      industryCode: '801780',
      marketValueCents: 1_000_000,
      totalQty: 100,
      availableQty: 100,
    }]
    const sellInput = (blocksSells: boolean) => build({
      gate: { killSwitch: true, killReason: 'LEDGER_MISMATCH', blocksSells },
      ledger: { positions },
      proposal: {
        side: 'sell',
        qty: 100,
        grossCents: 1_000_000,
        feesCents: 510,
        stopPriceCents: null,
        maxLossCents: null,
        isNewPosition: false,
        confidenceScore: null,
      },
    })
    expect(rules(evaluateRisk(sellInput(true)))).toContain('kill_switch')
    const drawdownSell = evaluateRisk({
      ...sellInput(false),
      gate: { killSwitch: true, killReason: 'RISK_DRAWDOWN', blocksSells: false, dataQuality: 'pass' },
    })
    expect(drawdownSell.ok).toBe(true)
  })
})
