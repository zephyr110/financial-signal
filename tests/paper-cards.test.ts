import { describe, it, expect } from 'vitest'
import {
  buildDecisionCard,
  computeConfidence,
  evaluateMarketGate,
  sizePositionCents,
  validateDecisionCardDraft,
  volumeStrength,
  type CardCandidateFeatures,
  type DecisionCardDraft,
} from '../lib/paper/cards'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'
import type { CardEvidence } from '../lib/paper/cards'
import type { MarketStatus, SymbolMeta } from '../lib/paper/types'

/**
 * 决策卡规则引擎：市场闸门、证据门槛与证据分、波动率仓位、§6.4 硬约束。
 * 确定性引擎产出全部数字；LLM 只改写 ≤80 字结论，不能改评分/仓位/止损。
 */

const NAV = 50_000_000
const D1 = '2026-11-24'
const policy = DEFAULT_PAPER_POLICY

function meta(overrides: Partial<SymbolMeta> = {}): SymbolMeta {
  return {
    symbolCode: '600000.SH',
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
    symbolCode: '600000.SH',
    tradeDate: D1,
    isSuspended: false,
    isSt: false,
    source: 'test',
    ...overrides,
  }
}

const evidence: CardEvidence[] = [
  { kind: 'policy', text: '金融支持政策落地' },
  { kind: 'industry', text: '银行板块资金净流入' },
  { kind: 'price', text: '收盘站上 20 日均线' },
  { kind: 'volume', text: '量比 1.2' },
  { kind: 'counter', text: '估值分位偏高' },
]

function features(overrides: Partial<CardCandidateFeatures> = {}): CardCandidateFeatures {
  return {
    symbolCode: '600000.SH',
    name: '浦发银行',
    industryCode: '801780',
    industryName: '银行',
    horizon: 'swing',
    board: 'main_sh',
    meta: meta(),
    status: status(),
    lastCloseCents: 10_000,
    ma20Cents: 9_800,
    ma60Cents: 9_500,
    atr20Cents: 250,
    volumeRatio5d20d: 1.2,
    adv20Cents: 50_000_000_000,
    listedTradingDays: 500,
    policyEventStrength: 0.8,
    industryStrength: 0.7,
    counterEvidenceStrength: 0,
    evidence,
    invalidation: '收盘跌破 95.00 元或行业资金转为净流出',
    isHeld: false,
    heldQty: 0,
    ...overrides,
  }
}

const gateOpen = { riskOff: false, reasons: [] }
const gateClosed = { riskOff: true, reasons: ['上涨家数占比 30% 低于 40%'] }

function build(overrides: Partial<CardCandidateFeatures> = {}, navCents: number | null = NAV) {
  return buildDecisionCard({
    policy,
    tradeDate: D1,
    reviewDate: '2026-11-27',
    navCents,
    marketGate: gateOpen,
    features: features(overrides),
  })
}

describe('市场闸门', () => {
  it('趋势、宽度、成交额都达标时开闸', () => {
    const result = evaluateMarketGate({
      indexAboveMa20: true,
      indexAboveMa60: true,
      breadthUpPct: 0.6,
      turnoverRatio: 1.2,
    }, policy)
    expect(result.riskOff).toBe(false)
    expect(result.reasons).toEqual([])
  })

  it('指数跌破均线或宽度/成交额不足时关闸', () => {
    const below = evaluateMarketGate({
      indexAboveMa20: false,
      indexAboveMa60: false,
      breadthUpPct: 0.6,
      turnoverRatio: 1.2,
    }, policy)
    expect(below.riskOff).toBe(true)
    expect(below.reasons[0]).toContain('均线')

    const narrow = evaluateMarketGate({
      indexAboveMa20: true,
      indexAboveMa60: true,
      breadthUpPct: 0.3,
      turnoverRatio: 1.2,
    }, policy)
    expect(narrow.riskOff).toBe(true)

    const thin = evaluateMarketGate({
      indexAboveMa20: true,
      indexAboveMa60: true,
      breadthUpPct: 0.6,
      turnoverRatio: 0.5,
    }, policy)
    expect(thin.riskOff).toBe(true)
  })

  it('缺数据时按 risk-off 处理', () => {
    const result = evaluateMarketGate({
      indexAboveMa20: null,
      indexAboveMa60: null,
      breadthUpPct: null,
      turnoverRatio: null,
    }, policy)
    expect(result.riskOff).toBe(true)
    expect(result.reasons).toHaveLength(3)
  })
})

describe('证据分', () => {
  it('全满分为 100，反证按上限扣分', () => {
    const full = computeConfidence({
      policyEvent: 1, industry: 1, trend: 1, volume: 1, liquidity: 1, counterEvidence: 0,
    }, policy)
    expect(full.score).toBe(100)

    const countered = computeConfidence({
      policyEvent: 1, industry: 1, trend: 1, volume: 1, liquidity: 1, counterEvidence: 1,
    }, policy)
    expect(countered.counterPenalty).toBe(20)
    expect(countered.score).toBe(80)
  })

  it('中间档按权重加权后四舍五入', () => {
    const result = computeConfidence({
      policyEvent: 1, industry: 0.5, trend: 1, volume: 0.75, liquidity: 1, counterEvidence: 0.5,
    }, policy)
    // 25 + 10 + 25 + 11.25 + 15 = 86.25 -> 86；反证扣 10
    expect(result.score).toBe(76)
  })

  it('量比是分档强度，不做平滑拟合', () => {
    expect(volumeStrength(2)).toBe(1)
    expect(volumeStrength(1.5)).toBe(1)
    expect(volumeStrength(1.0)).toBe(0.75)
    expect(volumeStrength(0.8)).toBe(0.4)
    expect(volumeStrength(0.5)).toBe(0.1)
    expect(volumeStrength(null)).toBe(0)
  })
})

describe('波动率仓位', () => {
  it('单笔风险预算与单票上限取小，再按整手收敛', () => {
    const sized = sizePositionCents({
      policy,
      navCents: NAV,
      referencePriceCents: 10_000,
      stopPriceCents: 9_500,
      board: 'main_sh',
    })
    // 单笔预算 2% × 500,000 元 = 10,000 元 / 每股风险 5 元 = 2000 股；单票上限 10 万 → 1000 股
    expect(sized.qty).toBe(1000)
    expect(sized.grossCents).toBe(10_000_000)
    expect(sized.feesCents).toBe(2_600)
    expect(sized.maxLossCents).toBe(502_600)
  })

  it('风险预算买不起一手时返回 0', () => {
    const sized = sizePositionCents({
      policy,
      navCents: 1_000_000,
      referencePriceCents: 200_000,
      stopPriceCents: 199_000,
      board: 'main_sh',
    })
    expect(sized.qty).toBe(0)
  })
})

describe('决策卡构建', () => {
  it('证据充分时给出可执行的候选卡：触发价、止损、最大亏损、仓位上限齐全', () => {
    const result = build()
    expect(result.executable).toBe(true)
    expect(result.blocks).toEqual([])
    const draft = result.draft
    expect(draft.stance).toBe('candidate')
    expect(draft.intent).toBe('buy')
    expect(draft.triggerBasis).toBe('open_auction')
    expect(draft.triggerOp).toBe('lte')
    expect(draft.triggerPriceCents).toBe(10_000)
    expect(draft.stopPriceCents).toBe(9_500)
    expect(draft.maxLossCents).toBe(502_600)
    expect(draft.maxPositionPctBp).toBe(2_000)
    expect(draft.confidenceScore).toBeGreaterThanOrEqual(50)
    expect(draft.expiresAt).toBe(`${D1}T09:15:00+08:00`)
    expect(draft.thesis.length).toBeLessThanOrEqual(80)
    expect(validateDecisionCardDraft(draft, policy)).toEqual([])
  })

  it('缺反证时降级为观察，理由写清楚', () => {
    const result = build({ evidence: evidence.filter((e) => e.kind !== 'counter') })
    expect(result.executable).toBe(false)
    expect(result.draft.stance).toBe('observe')
    expect(result.draft.intent).toBe('none')
    expect(result.blocks.some((b) => b.includes('反证'))).toBe(true)
    expect(result.draft.thesis).toBe('因为条件未成熟，所以今天只看不动。')
  })

  it('证据分低于 50 不出买入卡', () => {
    const result = build({
      lastCloseCents: 9_000,
      policyEventStrength: 0.2,
      industryStrength: 0.2,
      volumeRatio5d20d: 0.5,
    })
    expect(result.draft.confidenceScore).toBeLessThan(50)
    expect(result.executable).toBe(false)
    expect(result.blocks.some((b) => b.includes('证据分'))).toBe(true)
  })

  it('市场闸门关闭、ST、停牌、流动性不足都会阻断', () => {
    const closed = buildDecisionCard({
      policy,
      tradeDate: D1,
      reviewDate: '2026-11-27',
      navCents: NAV,
      marketGate: gateClosed,
      features: features(),
    })
    expect(closed.executable).toBe(false)

    expect(build({ meta: meta({ isSt: true }) }).executable).toBe(false)
    expect(build({ status: status({ isSuspended: true }) }).executable).toBe(false)
    expect(build({ adv20Cents: 1_000_000 }).executable).toBe(false)
    expect(build({ listedTradingDays: 10 }).executable).toBe(false)
  })

  it('缺净值或缺 ATR 时不出可执行卡', () => {
    expect(build({}, null).executable).toBe(false)
    expect(build({ atr20Cents: null }).executable).toBe(false)
  })

  it('持仓证伪触发时给谨慎/退出卡，否则只观察', () => {
    const hold = build({ isHeld: true, heldQty: 1000 })
    expect(hold.executable).toBe(false)
    expect(hold.draft.stance).toBe('observe')
    expect(hold.draft.intent).toBe('none')

    const exit = build({ isHeld: true, heldQty: 1000, invalidationHit: true })
    expect(exit.draft.stance).toBe('caution')
    expect(exit.draft.intent).toBe('exit')
    expect(exit.draft.maxPositionPctBp).toBe(2_000)
  })
})

describe('§6.4 卡片硬约束', () => {
  function validDraft(): DecisionCardDraft {
    return build().draft
  }

  it('买入意图必须带止损、最大亏损与 ≥50 的证据分', () => {
    const base = validDraft()
    expect(validateDecisionCardDraft({ ...base, stopPriceCents: null }, policy)
      .some((i) => i.field === 'stop_price')).toBe(true)
    expect(validateDecisionCardDraft({ ...base, maxLossCents: null }, policy)
      .some((i) => i.field === 'max_loss')).toBe(true)
    expect(validateDecisionCardDraft({ ...base, confidenceScore: 40 }, policy)
      .some((i) => i.field === 'confidence')).toBe(true)
  })

  it('候选卡必须有反证与证伪条件', () => {
    const base = validDraft()
    expect(validateDecisionCardDraft({ ...base, counterEvidenceJson: [] }, policy)
      .some((i) => i.field === 'counter_evidence')).toBe(true)
    expect(validateDecisionCardDraft({ ...base, stance: 'avoid', intent: 'none', invalidation: '  ' }, policy)
      .some((i) => i.field === 'invalidation')).toBe(true)
  })

  it('单票仓位超过政策上限时卡无效，而不是截断后照发', () => {
    const issues = validateDecisionCardDraft({ ...validDraft(), maxPositionPctBp: 2_500 }, policy)
    expect(issues.some((i) => i.field === 'max_position_pct')).toBe(true)
  })

  it('一句话结论不得超过 80 字', () => {
    const issues = validateDecisionCardDraft({ ...validDraft(), thesis: '长'.repeat(81) }, policy)
    expect(issues.some((i) => i.field === 'thesis')).toBe(true)
  })

  it('减仓/退出意图只能出现在谨慎或回避立场', () => {
    const issues = validateDecisionCardDraft({
      ...validDraft(),
      stance: 'candidate',
      intent: 'exit',
    }, policy)
    expect(issues.some((i) => i.message.includes('减仓/退出'))).toBe(true)
  })
})
