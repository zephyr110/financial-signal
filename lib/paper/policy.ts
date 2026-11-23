import crypto from 'node:crypto'
import type { PaperPolicy } from './types'

/**
 * 默认政策：费用与风控阈值锁定在这里，写入 paper_policy_versions 后带哈希。
 * 改任何数值都必须新建版本，历史成交不重算。
 */
export const DEFAULT_PAPER_POLICY: PaperPolicy = {
  version: 'paper-v2',
  fees: {
    commissionPpm: 250,        // 0.025%，最低 ¥5
    minCommissionCents: 500,
    stampTaxPpm: 500,          // 0.05%，仅卖出
    transferFeePpm: 10,        // 0.001%，双边
    slippagePpm: 500,          // 0.05%
  },
  dividendTax: {
    withinOneMonthBp: 2_000,
    withinOneYearBp: 1_000,
    overOneYearBp: 0,
    unknownBp: 1_000,
  },
  risk: {
    maxSingleStockBp: 2_000,
    maxIndustryBp: 4_000,
    maxPositions: 5,
    maxNewPositionsPerDay: 1,
    maxOrdersPerDay: 3,
    minCashBufferBp: 500,
    maxLossPerTradeBp: 200,
    maxDailyLossBp: 200,
    maxDrawdownBp: 1_000,
    minAdvCents: 5_000_000_000,   // ¥5,000 万
    maxPositionAdvBp: 500,
    minListedTradingDays: 60,
    minConfidenceForBuy: 50,
  },
  cardRules: {
    confidenceWeights: {
      policyEvent: 25,
      industry: 20,
      trend: 25,
      volume: 15,
      liquidity: 15,
    },
    counterPenaltyMax: 20,
    atrMultiple: 2,
    minEvidenceItems: 3,
    marketGate: {
      minBreadthPct: 40,
      minTurnoverPct: 80,
    },
  },
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v)
  }
  return value
}

deepFreeze(DEFAULT_PAPER_POLICY)

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = sortValue(source[key])
    }
    return out
  }
  return value
}

/** 键排序后的 JSON：同一政策对象在任何序列化顺序下哈希一致。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function policyHash(policy: PaperPolicy): string {
  return crypto.createHash('sha256').update(stableStringify(policy)).digest('hex')
}

/** 规则版本漂移检查：执行/结算前必须与委托携带的哈希一致。 */
export function policyMatches(policy: PaperPolicy, expectedHash: string): boolean {
  return policyHash(policy) === expectedHash
}

export function validatePaperPolicy(policy: PaperPolicy): void {
  const nonNegative = (value: number, name: string) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`政策 ${name} 必须是非负整数: ${value}`)
  }
  const positive = (value: number, name: string) => {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`政策 ${name} 必须是正整数: ${value}`)
  }
  if (!policy.version) throw new Error('政策缺少 version')
  for (const [k, v] of Object.entries(policy.fees)) nonNegative(v, `fees.${k}`)
  positive(policy.fees.minCommissionCents, 'fees.minCommissionCents')
  for (const [k, v] of Object.entries(policy.dividendTax)) nonNegative(v, `dividendTax.${k}`)
  positive(policy.risk.maxSingleStockBp, 'risk.maxSingleStockBp')
  positive(policy.risk.maxIndustryBp, 'risk.maxIndustryBp')
  positive(policy.risk.maxPositions, 'risk.maxPositions')
  positive(policy.risk.maxOrdersPerDay, 'risk.maxOrdersPerDay')
  positive(policy.risk.minAdvCents, 'risk.minAdvCents')
  nonNegative(policy.risk.minCashBufferBp, 'risk.minCashBufferBp')
  nonNegative(policy.risk.maxLossPerTradeBp, 'risk.maxLossPerTradeBp')
  nonNegative(policy.risk.maxDailyLossBp, 'risk.maxDailyLossBp')
  nonNegative(policy.risk.maxDrawdownBp, 'risk.maxDrawdownBp')

  if (!policy.cardRules) throw new Error('政策缺少 cardRules')
  const weights = policy.cardRules.confidenceWeights
  let weightSum = 0
  for (const [k, v] of Object.entries(weights)) {
    nonNegative(v, `cardRules.confidenceWeights.${k}`)
    weightSum += v
  }
  if (weightSum !== 100) throw new Error(`证据分权重合计必须为 100: ${weightSum}`)
  nonNegative(policy.cardRules.counterPenaltyMax, 'cardRules.counterPenaltyMax')
  positive(policy.cardRules.atrMultiple, 'cardRules.atrMultiple')
  positive(policy.cardRules.minEvidenceItems, 'cardRules.minEvidenceItems')
  const gate = policy.cardRules.marketGate
  if (!gate) throw new Error('政策缺少 cardRules.marketGate')
  if (!Number.isSafeInteger(gate.minBreadthPct) || gate.minBreadthPct < 0 || gate.minBreadthPct > 100) {
    throw new Error(`政策 cardRules.marketGate.minBreadthPct 必须在 0–100: ${gate.minBreadthPct}`)
  }
  positive(gate.minTurnoverPct, 'cardRules.marketGate.minTurnoverPct')
}
