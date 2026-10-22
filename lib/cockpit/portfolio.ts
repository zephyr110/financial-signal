import type { PortfolioRisk, PortfolioView, PositionInput, PositionView, SourceRef } from './types'

export interface PortfolioComputeInput {
  positions: PositionInput[]
  prices: Record<string, number>
  names?: Record<string, string>
  industries?: Record<string, string>
  sources?: Record<string, SourceRef>
  isDemo?: boolean
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 持仓计算只用整数分：避免 1.005 之类的浮点尾差进入展示与风险判断。 */
export function computePortfolio(input: PortfolioComputeInput): PortfolioView {
  const active = input.positions.filter((p) => p.shares > 0)
  const rows: PositionView[] = []
  const missingCodes: string[] = []
  let totalValue = 0
  let costBasis = 0
  let totalPnl = 0

  for (const p of active) {
    const rawPrice = input.prices[p.code]
    const price = Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : null
    const cost = p.avgCostCents * p.shares
    costBasis += cost
    if (price === null) {
      missingCodes.push(p.code)
      rows.push({
        code: p.code,
        name: input.names?.[p.code] || p.code,
        shares: p.shares,
        avgCost: p.avgCostCents / 100,
        price: null,
        marketValue: 0,
        pnl: 0,
        pnlPct: null,
        weight: 0,
        industry: input.industries?.[p.code] || '未分类',
        source: input.sources?.[p.code],
      })
      continue
    }
    const marketValue = Math.round(price * 100) * p.shares
    const pnl = marketValue - cost
    totalValue += marketValue
    totalPnl += pnl
    rows.push({
      code: p.code,
      name: input.names?.[p.code] || p.code,
      shares: p.shares,
      avgCost: p.avgCostCents / 100,
      price,
      marketValue,
      pnl,
      pnlPct: cost > 0 ? round2((pnl / cost) * 100) : null,
      weight: 0,
      industry: input.industries?.[p.code] || '未分类',
      source: input.sources?.[p.code],
    })
  }

  for (const row of rows) {
    row.weight = totalValue > 0 ? round2((row.marketValue / totalValue) * 100) : 0
  }
  rows.sort((a, b) => b.marketValue - a.marketValue)

  const byIndustry = new Map<string, number>()
  for (const row of rows) {
    if (row.marketValue <= 0) continue
    byIndustry.set(row.industry, (byIndustry.get(row.industry) || 0) + row.marketValue)
  }
  const exposure = [...byIndustry.entries()]
    .map(([industry, value]) => ({
      industry,
      weight: totalValue > 0 ? round2((value / totalValue) * 100) : 0,
    }))
    .sort((a, b) => b.weight - a.weight)

  const concentration = round2(rows.slice(0, 3).reduce((sum, row) => sum + row.weight, 0))
  const risks: PortfolioRisk[] = []

  if (rows.length === 0) {
    risks.push({ level: 'info', title: '尚未录入持仓', detail: '录入后可查看暴露、集中度与论点关联。' })
  }
  if (missingCodes.length > 0) {
    risks.push({
      level: 'warn',
      title: `${missingCodes.length} 只持仓缺少最新价`,
      detail: `${missingCodes.join('、')} 未计入市值与盈亏；请先补齐行情再判断仓位。`,
    })
  }
  const top = rows[0]
  if (top && top.weight > 40) {
    risks.push({
      level: 'warn',
      title: `${top.name} 单票权重 ${top.weight.toFixed(1)}%`,
      detail: '单一持仓超过 40%，个股事件会主导组合波动。这是风险提示，不是买卖建议。',
    })
  }
  const topIndustry = exposure[0]
  if (topIndustry && topIndustry.weight > 60 && exposure.length > 0) {
    risks.push({
      level: 'warn',
      title: `${topIndustry.industry} 暴露 ${topIndustry.weight.toFixed(1)}%`,
      detail: '行业集中度高，行业级政策或景气变化会同时影响多只持仓。',
    })
  }

  return {
    totalValue,
    totalPnl,
    totalPnlPct: costBasis > 0 ? round2((totalPnl / costBasis) * 100) : null,
    positions: rows,
    exposure,
    concentration,
    risks,
    isDemo: Boolean(input.isDemo),
  }
}
