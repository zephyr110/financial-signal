import { describe, it, expect } from 'vitest'
import { computePortfolio } from '../lib/cockpit/portfolio'

describe('computePortfolio', () => {
  it('用整数分计算市值、盈亏、权重和集中度', () => {
    const result = computePortfolio({
      positions: [
        { code: '600519.SH', shares: 100, avgCostCents: 150000 },
        { code: '300750.SZ', shares: 500, avgCostCents: 20000 },
      ],
      prices: { '600519.SH': 1600, '300750.SZ': 220 },
      names: { '600519.SH': '示例白酒', '300750.SZ': '示例电池' },
      industries: { '600519.SH': '食品饮料', '300750.SZ': '电力设备' },
      isDemo: true,
    })

    expect(result.totalValue).toBe(27_000_000)
    expect(result.totalPnl).toBe(2_000_000)
    expect(result.totalPnlPct).toBe(8)
    expect(result.positions[0].weight).toBe(59.26)
    expect(result.positions[1].weight).toBe(40.74)
    expect(result.concentration).toBe(100)
    expect(result.exposure.reduce((sum, e) => sum + e.weight, 0)).toBe(100)
    expect(result.risks.some((r) => r.title.includes('单票权重'))).toBe(true)
    expect(result.isDemo).toBe(true)
  })

  it('缺价不计入市值，并明确提示', () => {
    const result = computePortfolio({
      positions: [
        { code: 'A', shares: 10, avgCostCents: 1000 },
        { code: 'B', shares: 10, avgCostCents: 2000 },
      ],
      prices: { A: 12 },
    })
    expect(result.totalValue).toBe(12_000)
    expect(result.positions.find((p) => p.code === 'B')?.price).toBeNull()
    expect(result.risks.some((r) => r.title.includes('缺少最新价'))).toBe(true)
  })

  it('空持仓是引导而不是风险', () => {
    const result = computePortfolio({ positions: [], prices: {} })
    expect(result.totalValue).toBe(0)
    expect(result.positions).toHaveLength(0)
    expect(result.risks[0].level).toBe('info')
  })
})
