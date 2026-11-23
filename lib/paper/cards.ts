import { calcFees, lotRuleFor, sizeBuyQuantity } from './market'
import { floorDiv } from './money'
import { evaluateRisk } from './risk'
import type {
  DataQuality,
  MarketStatus,
  PaperBoard,
  PaperHorizon,
  PaperPolicy,
  SymbolMeta,
} from './types'

/**
 * 决策卡规则引擎（确定性）：市场闸门 → 证据门槛 → 证据分 → 波动率仓位 → 触发/止损/证伪。
 * 同一输入 + 同一政策版本必然得到同一张卡；LLM 只负责把结论改写成 ≤80 字人话，
 * 不改评分/仓位/触发价/止损价。
 */

export type EvidenceKind = 'policy' | 'industry' | 'price' | 'volume' | 'risk' | 'counter'

export interface CardEvidence {
  kind: EvidenceKind
  text: string
  /** 可复核的原始数值（价格分、量比等），供 UI 展开。 */
  value?: number | null
}

export type CardStance = 'observe' | 'candidate' | 'caution' | 'avoid'
export type CardIntent = 'none' | 'buy' | 'add' | 'reduce' | 'exit'

export interface MarketGateInput {
  indexAboveMa20: boolean | null
  indexAboveMa60: boolean | null
  /** 上涨家数占比，0–1。 */
  breadthUpPct: number | null
  /** 当日成交额 / 20 日均值，1 表示持平。 */
  turnoverRatio: number | null
}

export interface MarketGateResult {
  riskOff: boolean
  reasons: string[]
}

export function evaluateMarketGate(input: MarketGateInput, policy: PaperPolicy): MarketGateResult {
  const reasons: string[] = []
  if (input.indexAboveMa20 === null || input.indexAboveMa60 === null) {
    reasons.push('缺少指数趋势数据')
  } else if (!input.indexAboveMa20 && !input.indexAboveMa60) {
    reasons.push('指数在 20/60 日均线下方')
  }
  if (input.breadthUpPct === null) {
    reasons.push('缺少市场宽度数据')
  } else if (input.breadthUpPct * 100 < policy.cardRules.marketGate.minBreadthPct) {
    reasons.push(`上涨家数占比 ${(input.breadthUpPct * 100).toFixed(0)}% 低于 ${policy.cardRules.marketGate.minBreadthPct}%`)
  }
  if (input.turnoverRatio === null) {
    reasons.push('缺少成交额数据')
  } else if (input.turnoverRatio * 100 < policy.cardRules.marketGate.minTurnoverPct) {
    reasons.push(`成交额只有 20 日均值的 ${(input.turnoverRatio * 100).toFixed(0)}%`)
  }
  return { riskOff: reasons.length > 0, reasons }
}

export interface ConfidenceInputs {
  policyEvent: number
  industry: number
  trend: number
  volume: number
  liquidity: number
  counterEvidence: number
}

export interface ConfidenceResult {
  score: number
  inputs: ConfidenceInputs
  weights: PaperPolicy['cardRules']['confidenceWeights']
  counterPenalty: number
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** 量比 → 0–1 的证据强度（分档，不做平滑拟合，避免参数无法解释）。 */
export function volumeStrength(ratio: number | null): number {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return 0
  if (ratio >= 1.5) return 1
  if (ratio >= 1.0) return 0.75
  if (ratio >= 0.8) return 0.4
  return 0.1
}

export function trendStrength(
  lastCloseCents: number | null,
  ma20Cents: number | null,
  ma60Cents: number | null,
): number {
  if (!lastCloseCents || !ma20Cents || !ma60Cents) return 0
  let score = 0
  if (lastCloseCents >= ma20Cents) score += 0.5
  if (ma20Cents >= ma60Cents) score += 0.5
  return score
}

export function liquidityStrength(adv20Cents: number | null, policy: PaperPolicy): number {
  if (adv20Cents === null || adv20Cents <= 0) return 0
  return clamp01(adv20Cents / (policy.risk.minAdvCents * 2))
}

export function computeConfidence(inputs: ConfidenceInputs, policy: PaperPolicy): ConfidenceResult {
  const weights = policy.cardRules.confidenceWeights
  const clamped: ConfidenceInputs = {
    policyEvent: clamp01(inputs.policyEvent),
    industry: clamp01(inputs.industry),
    trend: clamp01(inputs.trend),
    volume: clamp01(inputs.volume),
    liquidity: clamp01(inputs.liquidity),
    counterEvidence: clamp01(inputs.counterEvidence),
  }
  const raw = weights.policyEvent * clamped.policyEvent
    + weights.industry * clamped.industry
    + weights.trend * clamped.trend
    + weights.volume * clamped.volume
    + weights.liquidity * clamped.liquidity
  const counterPenalty = Math.round(policy.cardRules.counterPenaltyMax * clamped.counterEvidence)
  const score = Math.min(100, Math.max(0, Math.round(raw) - counterPenalty))
  return { score, inputs: clamped, weights, counterPenalty }
}

export interface CardCandidateFeatures {
  symbolCode: string
  name: string
  industryCode: string | null
  industryName: string | null
  horizon: PaperHorizon
  board: PaperBoard | null
  meta: SymbolMeta | null
  status: MarketStatus | null
  lastCloseCents: number | null
  ma20Cents: number | null
  ma60Cents: number | null
  atr20Cents: number | null
  volumeRatio5d20d: number | null
  adv20Cents: number | null
  listedTradingDays: number | null
  policyEventStrength: number
  industryStrength: number
  counterEvidenceStrength: number
  evidence: CardEvidence[]
  invalidation: string | null
  isHeld: boolean
  heldQty: number
  /** 持仓证伪是否已触发（跌破止损/逻辑被否）；仅持仓扫描使用。 */
  invalidationHit?: boolean
  dataQuality?: DataQuality
}

export interface DecisionCardDraft {
  tradeDate: string
  symbolCode: string
  name: string
  stance: CardStance
  intent: CardIntent
  horizon: PaperHorizon
  thesis: string
  triggerBasis: 'prev_close' | 'event' | 'open_auction'
  triggerOp: 'lte' | 'gte' | null
  triggerPriceCents: number | null
  stopPriceCents: number | null
  maxLossCents: number | null
  maxPositionPctBp: number
  confidenceScore: number
  confidenceInputsJson: ConfidenceResult
  evidenceJson: CardEvidence[]
  counterEvidenceJson: CardEvidence[]
  invalidation: string
  reviewDate: string
  expiresAt: string
}

export interface BuildCardInput {
  policy: PaperPolicy
  tradeDate: string
  reviewDate: string
  navCents: number | null
  marketGate: MarketGateResult
  features: CardCandidateFeatures
}

export interface BuildCardResult {
  draft: DecisionCardDraft
  /** 不可执行/降级的原因；为空表示可执行。 */
  blocks: string[]
  executable: boolean
}

function yuan(cents: number): string {
  return (cents / 100).toFixed(2)
}

function countEvidence(evidence: CardEvidence[], kinds: EvidenceKind[]): number {
  return evidence.filter((e) => kinds.includes(e.kind)).length
}

function policyBp(policy: PaperPolicy, amountCents: number): number {
  return floorDiv(amountCents * policy.risk.maxLossPerTradeBp, 10_000)
}

/** 波动率仓位：单笔风险预算 ÷ 每股风险，再按整手与单票上限收敛。 */
export function sizePositionCents(input: {
  policy: PaperPolicy
  navCents: number
  referencePriceCents: number
  stopPriceCents: number
  board: PaperBoard
}): { qty: number; maxLossCents: number; grossCents: number; feesCents: number } {
  const { policy, navCents, referencePriceCents, stopPriceCents, board } = input
  const perShareRisk = Math.max(1, referencePriceCents - stopPriceCents)
  const riskBudget = policyBp(policy, navCents)
  const singleCap = floorDiv(navCents * policy.risk.maxSingleStockBp, 10_000)
  let qty = sizeBuyQuantity(floorDiv(riskBudget, perShareRisk), board)
  qty = Math.min(qty, sizeBuyQuantity(floorDiv(singleCap, referencePriceCents), board))

  let fees = calcFees('buy', Math.max(1, qty), referencePriceCents, referencePriceCents, policy.fees)
  let maxLoss = Math.max(0, perShareRisk * qty + fees.totalFeesCents)
  const lot = lotRuleFor(board).minQty
  while (qty > 0 && maxLoss > riskBudget) {
    qty -= lot
    if (qty <= 0) break
    fees = calcFees('buy', qty, referencePriceCents, referencePriceCents, policy.fees)
    maxLoss = Math.max(0, perShareRisk * qty + fees.totalFeesCents)
  }
  return {
    qty: Math.max(0, qty),
    maxLossCents: maxLoss,
    grossCents: qty * referencePriceCents,
    feesCents: qty > 0 ? fees.totalFeesCents : 0,
  }
}

export function buildDecisionCard(input: BuildCardInput): BuildCardResult {
  const { policy, tradeDate, reviewDate, navCents, marketGate, features } = input
  const blocks: string[] = []
  const evidence = features.evidence ?? []
  const counter = evidence.filter((e) => e.kind === 'counter')
  const confidence = computeConfidence({
    policyEvent: features.policyEventStrength,
    industry: features.industryStrength,
    trend: trendStrength(features.lastCloseCents, features.ma20Cents, features.ma60Cents),
    volume: volumeStrength(features.volumeRatio5d20d),
    liquidity: liquidityStrength(features.adv20Cents, policy),
    counterEvidence: features.counterEvidenceStrength,
  }, policy)

  const base = {
    tradeDate,
    symbolCode: features.symbolCode,
    name: features.name,
    horizon: features.horizon,
    reviewDate,
    expiresAt: `${tradeDate}T09:15:00+08:00`,
    confidenceScore: confidence.score,
    confidenceInputsJson: confidence,
    evidenceJson: evidence.filter((e) => e.kind !== 'counter'),
    counterEvidenceJson: counter,
    invalidation: features.invalidation ?? '数据质量 fail 或跌破止损价',
    maxPositionPctBp: 0,
    triggerOp: null,
    triggerPriceCents: null,
    stopPriceCents: null,
    maxLossCents: null,
    triggerBasis: 'open_auction' as const,
    thesis: '',
    stance: 'observe' as CardStance,
    intent: 'none' as CardIntent,
  }

  // 持仓扫描：证伪触发 → 谨慎/退出；否则观察持有。
  if (features.isHeld) {
    const exit = Boolean(features.invalidationHit)
      || features.meta?.delistDate != null
      || features.meta?.isSt === true
      || features.status?.isSt === true
      || features.status?.isSuspended === true
    const draft: DecisionCardDraft = {
      ...base,
      stance: exit ? 'caution' : 'observe',
      intent: exit ? 'exit' : 'none',
      triggerBasis: 'prev_close',
      thesis: exit ? '因为证伪条件或风险状态已触发，所以考虑退出。' : '因为尚无新信号，所以继续持有观察。',
      maxPositionPctBp: navCents && features.lastCloseCents
        ? Math.min(policy.risk.maxSingleStockBp,
          Math.round(features.heldQty * features.lastCloseCents * 10_000 / navCents))
        : 0,
    }
    return { draft, blocks, executable: false }
  }

  if (marketGate.riskOff) {
    blocks.push(...marketGate.reasons.map((r) => `市场闸门：${r}`))
  }
  if (features.dataQuality === 'fail') blocks.push('标的或市场数据质量不通过')
  if (!features.meta) blocks.push('缺少标的元数据')
  else {
    if (features.meta.isSt) blocks.push('ST 标的')
    if (features.meta.delistDate) blocks.push('退市标的')
    if (features.meta.board === 'bse') blocks.push('北交所暂不纳入')
  }
  if (features.status?.isSuspended) blocks.push('停牌中')
  if (features.listedTradingDays === null) blocks.push('缺少上市交易日数')
  else if (features.listedTradingDays < policy.risk.minListedTradingDays) {
    blocks.push(`上市不足 ${policy.risk.minListedTradingDays} 个交易日`)
  }
  if (features.adv20Cents === null) blocks.push('缺少 20 日成交额')
  else if (features.adv20Cents < policy.risk.minAdvCents) {
    blocks.push(`20 日日均成交额不足 ¥${(policy.risk.minAdvCents / 100 / 10_000).toFixed(0)} 万`)
  }

  const evidenceOk = evidence.length >= policy.cardRules.minEvidenceItems
    && countEvidence(evidence, ['policy', 'industry']) >= 1
    && countEvidence(evidence, ['price', 'volume']) >= 1
    && counter.length >= 1
  if (!evidenceOk) blocks.push('证据不足：需 ≥3 条，含政策/行业、价格/量能、反证各 ≥1')
  if (confidence.score < policy.risk.minConfidenceForBuy) {
    blocks.push(`证据分 ${confidence.score} 低于买入门槛 ${policy.risk.minConfidenceForBuy}`)
  }
  if (!features.lastCloseCents || !features.atr20Cents || !features.board) {
    blocks.push('缺少收盘价/ATR/板别，无法给出数字止损')
  }
  if (!features.invalidation) blocks.push('缺少证伪条件')

  if (blocks.length > 0 || !navCents || !features.lastCloseCents || !features.atr20Cents || !features.board) {
    return {
      draft: {
        ...base,
        stance: 'observe',
        intent: 'none',
        thesis: '因为条件未成熟，所以今天只看不动。',
      },
      blocks,
      executable: false,
    }
  }

  const stopPriceCents = Math.max(1, features.lastCloseCents - policy.cardRules.atrMultiple * features.atr20Cents)
  const triggerPriceCents = features.lastCloseCents
  const sized = sizePositionCents({
    policy,
    navCents,
    referencePriceCents: triggerPriceCents,
    stopPriceCents,
    board: features.board,
  })
  if (sized.qty <= 0) {
    return {
      draft: { ...base, stance: 'observe', intent: 'none', thesis: '因为风险预算买不起一手，所以今天只看不动。' },
      blocks: ['风险预算不足一手'],
      executable: false,
    }
  }

  // 卡生成阶段也跑一遍风控（第二处之外的卡级检查），避免出无法执行的买入卡。
  const risk = evaluateRisk({
    checkpoint: 'card',
    policy,
    gate: { killSwitch: false, killReason: null, blocksSells: false, dataQuality: features.dataQuality ?? 'pass' },
    ledger: {
      navCents,
      cashCents: navCents,
      positions: [],
      dailyOrders: 0,
      dailyNewPositions: 0,
      dailyLossBp: null,
      drawdownBp: null,
    },
    proposal: {
      symbolCode: features.symbolCode,
      industryCode: features.industryCode,
      side: 'buy',
      qty: sized.qty,
      priceCents: triggerPriceCents,
      grossCents: sized.grossCents,
      feesCents: sized.feesCents,
      stopPriceCents,
      maxLossCents: sized.maxLossCents,
      board: features.board,
      lotSize: features.meta?.lotSize ?? 100,
      isNewPosition: true,
      confidenceScore: confidence.score,
    },
    market: {
      meta: features.meta,
      status: features.status,
      adv20Cents: features.adv20Cents,
      listedTradingDays: features.listedTradingDays,
    },
  })
  if (!risk.ok) {
    return {
      draft: { ...base, stance: 'observe', intent: 'none', thesis: '因为风控不通过，所以今天只看不动。' },
      blocks: risk.violations.map((v) => v.message),
      executable: false,
    }
  }

  const maxPositionPctBp = Math.min(
    policy.risk.maxSingleStockBp,
    Math.round(sized.grossCents * 10_000 / navCents),
  )
  const draft: DecisionCardDraft = {
    ...base,
    stance: 'candidate',
    intent: 'buy',
    thesis: `因为行业强弱与量价配合，所以开盘不高于 ${yuan(triggerPriceCents)} 元再考虑。`,
    triggerBasis: 'open_auction',
    triggerOp: 'lte',
    triggerPriceCents,
    stopPriceCents,
    maxLossCents: sized.maxLossCents,
    maxPositionPctBp,
  }
  return { draft, blocks: [], executable: true }
}

export interface CardValidationIssue {
  field: string
  message: string
}

/** §6.4 硬约束：任何一条不满足都不能落库为可执行卡。 */
export function validateDecisionCardDraft(
  draft: DecisionCardDraft,
  policy: PaperPolicy,
): CardValidationIssue[] {
  const issues: CardValidationIssue[] = []
  const buyIntent = draft.intent === 'buy' || draft.intent === 'add'
  if (draft.stance !== 'observe' && !draft.invalidation.trim()) {
    issues.push({ field: 'invalidation', message: '缺少证伪条件' })
  }
  if (draft.stance === 'candidate' && draft.counterEvidenceJson.length < 1) {
    issues.push({ field: 'counter_evidence', message: '候选卡至少需要一条反证' })
  }
  if (draft.stance === 'candidate' && draft.evidenceJson.length + draft.counterEvidenceJson.length < policy.cardRules.minEvidenceItems) {
    issues.push({ field: 'evidence', message: `证据不足 ${policy.cardRules.minEvidenceItems} 条` })
  }
  if (buyIntent) {
    if (draft.stopPriceCents === null || draft.stopPriceCents <= 0) {
      issues.push({ field: 'stop_price', message: '买入卡必须带数字止损价' })
    }
    if (draft.maxLossCents === null || draft.maxLossCents < 0) {
      issues.push({ field: 'max_loss', message: '买入卡必须带最大亏损' })
    }
    if (draft.confidenceScore < policy.risk.minConfidenceForBuy) {
      issues.push({ field: 'confidence', message: '证据分低于买入门槛' })
    }
    if (draft.stance !== 'candidate') {
      issues.push({ field: 'stance', message: '只有候选立场可以给出买入意图' })
    }
  }
  if ((draft.intent === 'reduce' || draft.intent === 'exit') && draft.stance !== 'caution' && draft.stance !== 'avoid') {
    issues.push({ field: 'stance', message: '减仓/退出意图只能出现在谨慎或回避立场' })
  }
  if (draft.maxPositionPctBp > policy.risk.maxSingleStockBp) {
    issues.push({ field: 'max_position_pct', message: '单票仓位超过政策上限' })
  }
  if (draft.thesis.length > 80) {
    issues.push({ field: 'thesis', message: '一句话结论超过 80 字' })
  }
  if (draft.triggerBasis === 'open_auction' && draft.triggerOp !== null && draft.triggerPriceCents === null) {
    issues.push({ field: 'trigger', message: '开盘条件必须带触发价' })
  }
  return issues
}
