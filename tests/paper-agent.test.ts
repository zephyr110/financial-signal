import { describe, expect, it } from 'vitest'
import {
  AgentOutputError,
  agentBias,
  computeAgentOutcomeMetrics,
  deriveAgentRunStatus,
  extractAgentJson,
  normalizeAgentPlan,
  type AgentSymbolSnapshot,
} from '../lib/paper/agent'
import { DEFAULT_PAPER_POLICY } from '../lib/paper/policy'

/**
 * Agent 输出的纯函数层：方向口径、JSON 收口、仓位/价格归一与事后命中。
 * 数据库与模型调用不在这里测；这里只锁住会直接改变正确率与下单量的规则。
 */

const NAV = 50_000_000
const policy = DEFAULT_PAPER_POLICY

function symbol(overrides: Partial<AgentSymbolSnapshot> = {}): AgentSymbolSnapshot {
  return {
    symbolCode: '600000.SH',
    name: '浦发银行',
    industryName: '银行',
    board: 'main_sh',
    lastCloseCents: 1_200,
    ma20Cents: 1_150,
    ma60Cents: 1_100,
    atr20Cents: 50,
    volumeRatio5d20d: 1.2,
    adv20Cents: 5_000_000_000,
    listedTradingDays: 500,
    isHeld: false,
    heldQty: 0,
    availableQty: 0,
    avgCostCents: null,
    unrealizedPnlBp: null,
    dataQuality: 'pass',
    isSt: false,
    isSuspended: false,
    delisted: false,
    ...overrides,
  }
}

function rawDecision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    symbol: '600000.SH',
    action: 'buy',
    conviction: 70,
    thesis: '站上均线且量能配合',
    evidence: ['收盘价高于 20 日均线', '量比放大'],
    counterEvidence: ['大盘缩量'],
    invalidation: '收盘跌破 11.00',
    plannedPriceCents: 1_200,
    stopPriceCents: 1_100,
    ...overrides,
  }
}

function plan(decisions: unknown[], extra: Record<string, unknown> = {}) {
  return { marketView: '震荡偏强', review: '', decisions, ...extra }
}

describe('agentBias', () => {
  it('买入/加仓看多，减仓/清仓/回避看空', () => {
    expect(agentBias('buy', 0)).toBe('bull')
    expect(agentBias('add', 100)).toBe('bull')
    expect(agentBias('reduce', 100)).toBe('bear')
    expect(agentBias('exit', 100)).toBe('bear')
    expect(agentBias('avoid', 0)).toBe('bear')
  })

  it('hold 只有持仓时才算看多，空仓观望不参与方向统计', () => {
    expect(agentBias('hold', 100)).toBe('bull')
    expect(agentBias('hold', 0)).toBeNull()
  })
})

describe('deriveAgentRunStatus', () => {
  it('没有交易或全部未执行都收口为 skipped，部分执行为 partial', () => {
    expect(deriveAgentRunStatus(0, 0, 0)).toBe('skipped')
    expect(deriveAgentRunStatus(3, 0, 3)).toBe('skipped')
    expect(deriveAgentRunStatus(3, 2, 1)).toBe('partial')
    expect(deriveAgentRunStatus(3, 2, 0)).toBe('partial')
    expect(deriveAgentRunStatus(3, 3, 0)).toBe('executed')
  })
})

describe('extractAgentJson', () => {
  it('剥掉代码块与前后解释文字', () => {
    expect(extractAgentJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
    expect(extractAgentJson('好的，如下：{"a":1}\n以上。')).toEqual({ a: 1 })
  })

  it('修复中文引号与尾逗号', () => {
    expect(extractAgentJson('{"a":“文本”}')).toEqual({ a: '文本' })
    expect(extractAgentJson('{"a":1,}')).toEqual({ a: 1 })
  })
})

describe('normalizeAgentPlan', () => {
  it('缺少 marketView 或 decisions 视为不可用输出', () => {
    expect(() => normalizeAgentPlan({ decisions: [] }, { symbols: [symbol()], policy, navCents: NAV }))
      .toThrow(AgentOutputError)
    expect(() => normalizeAgentPlan({ marketView: 'x' }, { symbols: [symbol()], policy, navCents: NAV }))
      .toThrow(AgentOutputError)
  })

  it('丢弃未知标的、重复标的与非法动作，并留下警告', () => {
    const result = normalizeAgentPlan(plan([
      rawDecision(),
      rawDecision({ conviction: 90 }),
      rawDecision({ symbol: '000001.SZ' }),
      rawDecision({ symbol: '600001.SH', action: 'all-in' }),
    ]), {
      symbols: [symbol(), symbol({ symbolCode: '600001.SH', name: '邯郸钢铁' })],
      policy,
      navCents: NAV,
    })

    expect(result.decisions).toHaveLength(1)
    expect(result.decisions[0]).toMatchObject({ symbolCode: '600000.SH', conviction: 70, status: 'planned' })
    expect(result.warnings.some((warning) => warning.includes('重复'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('未知标的'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('动作非法'))).toBe(true)
  })

  it('模型把价格写成“元”时按最近收盘价换算成分', () => {
    const result = normalizeAgentPlan(plan([
      rawDecision({ plannedPriceCents: 11.8, stopPriceCents: 11 }),
    ]), { symbols: [symbol()], policy, navCents: NAV })

    expect(result.decisions[0].plannedPriceCents).toBe(1_180)
    expect(result.decisions[0].stopPriceCents).toBe(1_100)
  })

  it('限价不超过收盘价 2%，缺失止损按 2 倍 ATR 回落', () => {
    const capped = normalizeAgentPlan(plan([
      rawDecision({ plannedPriceCents: 1_300, stopPriceCents: 1_290 }),
    ]), { symbols: [symbol()], policy, navCents: NAV }).decisions[0]
    expect(capped.plannedPriceCents).toBe(1_224)
    expect(capped.stopPriceCents).toBe(1_124)

    const fallback = normalizeAgentPlan(plan([
      rawDecision({ stopPriceCents: null }),
    ]), { symbols: [symbol()], policy, navCents: NAV }).decisions[0]
    expect(fallback.stopPriceCents).toBe(1_100)
  })

  it('仓位按单笔风险预算与单票上限收敛到整手', () => {
    const decision = normalizeAgentPlan(plan([rawDecision()]), {
      symbols: [symbol()], policy, navCents: NAV,
    }).decisions[0]

    expect(decision.plannedQty).toBe(8_300)
    expect(decision.plannedQty! % 100).toBe(0)
    expect(decision.maxLossCents).toBeLessThanOrEqual(NAV * policy.risk.maxLossPerTradeBp / 10_000)
    expect(decision.maxPositionPctBp).toBeLessThanOrEqual(policy.risk.maxSingleStockBp)
  })

  it('买入前的硬闸门直接跳过，但仍保留决策记录', () => {
    const lowConviction = normalizeAgentPlan(plan([rawDecision({ conviction: 49 })]), {
      symbols: [symbol()], policy, navCents: NAV,
    }).decisions[0]
    expect(lowConviction).toMatchObject({ status: 'skipped', statusReason: 'CONVICTION_BELOW_POLICY' })

    const st = normalizeAgentPlan(plan([rawDecision()]), {
      symbols: [symbol({ isSt: true })], policy, navCents: NAV,
    }).decisions[0]
    expect(st).toMatchObject({ status: 'skipped', statusReason: 'DATA_BLOCKED' })

    const badData = normalizeAgentPlan(plan([rawDecision()]), {
      symbols: [symbol({ dataQuality: 'fail' })], policy, navCents: NAV,
    }).decisions[0]
    expect(badData).toMatchObject({ status: 'skipped', statusReason: 'DATA_QUALITY' })

    const noAtr = normalizeAgentPlan(plan([rawDecision()]), {
      symbols: [symbol({ atr20Cents: null })], policy, navCents: NAV,
    }).decisions[0]
    expect(noAtr).toMatchObject({ status: 'skipped', statusReason: 'MISSING_PRICE_OR_ATR' })

    const riskOff = normalizeAgentPlan(plan([rawDecision()]), {
      symbols: [symbol()], policy, navCents: NAV, marketRiskOff: true,
    }).decisions[0]
    expect(riskOff).toMatchObject({ status: 'skipped', statusReason: 'MARKET_RISK_OFF' })
  })

  it('极低价格不生成 0 止损卡：低于 2 分直接跳过，边界价保住正止损', () => {
    const penny = normalizeAgentPlan(plan([rawDecision()]), {
      symbols: [symbol({ lastCloseCents: 1, atr20Cents: 1, ma20Cents: 1, ma60Cents: 1 })],
      policy,
      navCents: NAV,
    }).decisions[0]
    expect(penny).toMatchObject({ status: 'skipped', statusReason: 'MISSING_PRICE_OR_ATR' })

    const edge = normalizeAgentPlan(plan([
      rawDecision({ plannedPriceCents: 1, stopPriceCents: 1 }),
    ]), {
      symbols: [symbol({ lastCloseCents: 2, atr20Cents: 1, ma20Cents: 2, ma60Cents: 2 })],
      policy,
      navCents: NAV,
    }).decisions[0]
    expect(edge.status).toBe('planned')
    expect(edge.plannedPriceCents).toBe(2)
    expect(edge.stopPriceCents).toBeGreaterThan(0)
  })

  it('卖出只对持仓生效：清仓全卖、减仓按整手取整', () => {
    const held = symbol({ isHeld: true, heldQty: 1_000, availableQty: 1_000, avgCostCents: 1_000 })
    const exit = normalizeAgentPlan(plan([rawDecision({ action: 'exit', plannedPriceCents: null, stopPriceCents: null })]), {
      symbols: [held], policy, navCents: NAV,
    }).decisions[0]
    expect(exit).toMatchObject({ status: 'planned', plannedQty: 1_000 })

    const reduce = normalizeAgentPlan(plan([rawDecision({ action: 'reduce', reducePct: 25, plannedPriceCents: null, stopPriceCents: null })]), {
      symbols: [held], policy, navCents: NAV,
    }).decisions[0]
    expect(reduce).toMatchObject({ status: 'planned', plannedQty: 200 })

    // 小比例减仓落到不足一手时按最小一手卖，不能放大成清仓。
    const trim = normalizeAgentPlan(plan([rawDecision({ action: 'reduce', reducePct: 5, plannedPriceCents: null, stopPriceCents: null })]), {
      symbols: [held], policy, navCents: NAV,
    }).decisions[0]
    expect(trim).toMatchObject({ status: 'planned', plannedQty: 100 })

    // 零股持仓只能随清仓一次卖出。
    const odd = normalizeAgentPlan(plan([rawDecision({ action: 'reduce', reducePct: 50, plannedPriceCents: null, stopPriceCents: null })]), {
      symbols: [symbol({ isHeld: true, heldQty: 50, availableQty: 50, avgCostCents: 1_000 })],
      policy,
      navCents: NAV,
    }).decisions[0]
    expect(odd).toMatchObject({ status: 'planned', plannedQty: 50 })

    const notHeld = normalizeAgentPlan(plan([rawDecision({ action: 'exit' })]), {
      symbols: [symbol()], policy, navCents: NAV,
    }).decisions[0]
    expect(notHeld).toMatchObject({ status: 'skipped', statusReason: 'NOT_HELD' })
  })

  it('每天最多新开 1 仓，其余保留为 skipped', () => {
    const result = normalizeAgentPlan(plan([
      rawDecision({ symbol: '600000.SH', conviction: 80 }),
      rawDecision({ symbol: '000001.SZ', conviction: 60 }),
    ]), {
      symbols: [symbol(), symbol({ symbolCode: '000001.SZ', name: '平安银行', board: 'main_sz' })],
      policy,
      navCents: NAV,
    })

    expect(result.decisions.map((decision) => decision.status)).toEqual(['planned', 'skipped'])
    expect(result.decisions[1].statusReason).toBe('MAX_NEW_POSITIONS')
  })

  it('每日委托上限按置信度保留前三笔', () => {
    const codes = ['600000.SH', '600001.SH', '600002.SH', '600003.SH']
    const symbols = codes.map((code) => symbol({
      symbolCode: code, isHeld: true, heldQty: 500, availableQty: 500, avgCostCents: 1_000,
    }))
    const result = normalizeAgentPlan(plan(codes.map((code, index) => rawDecision({
      symbol: code,
      action: 'exit',
      conviction: 90 - index * 10,
      plannedPriceCents: null,
      stopPriceCents: null,
    }))), { symbols, policy, navCents: NAV })

    expect(result.decisions.filter((decision) => decision.status === 'planned')).toHaveLength(3)
    const skipped = result.decisions.find((decision) => decision.status === 'skipped')
    expect(skipped).toMatchObject({ symbolCode: '600003.SH', statusReason: 'MAX_DAILY_ORDERS' })
  })

  it('买入缺反证/缺证伪条件时补默认值，避免执行卡证据为空', () => {
    const decision = normalizeAgentPlan(plan([
      rawDecision({ counterEvidence: [], invalidation: '' }),
    ]), { symbols: [symbol()], policy, navCents: NAV }).decisions[0]

    expect(decision.counterEvidence).toHaveLength(1)
    expect(decision.invalidation).toContain('止损')
  })
})

describe('computeAgentOutcomeMetrics', () => {
  it('看多：上涨命中方向，跑赢基准命中 alpha，跌破止损记为证伪', () => {
    const metrics = computeAgentOutcomeMetrics({
      entryPriceCents: 1_000,
      endPriceCents: 1_100,
      maxPriceCents: 1_120,
      minPriceCents: 960,
      benchmarkReturnBp: 200,
      action: 'buy',
      positionQtyBefore: 0,
      stopPriceCents: 980,
    })

    expect(metrics).toMatchObject({
      returnBp: 1_000,
      benchmarkReturnBp: 200,
      alphaBp: 800,
      maxFavorableBp: 1_200,
      maxAdverseBp: -400,
      directionHit: true,
      alphaHit: true,
      invalidationHit: true,
    })
  })

  it('看空：下跌才算命中，反弹但跑输基准也算 alpha 命中', () => {
    const metrics = computeAgentOutcomeMetrics({
      entryPriceCents: 1_000,
      endPriceCents: 900,
      maxPriceCents: 1_010,
      minPriceCents: 890,
      benchmarkReturnBp: -100,
      action: 'avoid',
      positionQtyBefore: 0,
      stopPriceCents: null,
    })

    expect(metrics.directionHit).toBe(true)
    expect(metrics.alphaHit).toBe(true)
    expect(metrics.alphaBp).toBe(-900)
    expect(metrics.invalidationHit).toBeNull()
  })

  it('空仓 hold 没有方向主张；持仓 hold 按看多处理', () => {
    const flat = computeAgentOutcomeMetrics({
      entryPriceCents: 1_000, endPriceCents: 1_050, maxPriceCents: 1_060, minPriceCents: 990,
      benchmarkReturnBp: 0, action: 'hold', positionQtyBefore: 0, stopPriceCents: 950,
    })
    expect(flat.directionHit).toBeNull()
    expect(flat.alphaHit).toBeNull()
    expect(flat.invalidationHit).toBeNull()

    const held = computeAgentOutcomeMetrics({
      entryPriceCents: 1_000, endPriceCents: 1_050, maxPriceCents: 1_060, minPriceCents: 990,
      benchmarkReturnBp: 0, action: 'hold', positionQtyBefore: 1_000, stopPriceCents: 950,
    })
    expect(held.directionHit).toBe(true)
    expect(held.alphaHit).toBe(true)
    expect(held.invalidationHit).toBe(false)
  })

  it('零涨跌不算方向命中，避免持平被计入胜率', () => {
    const metrics = computeAgentOutcomeMetrics({
      entryPriceCents: 1_000, endPriceCents: 1_000, maxPriceCents: 1_010, minPriceCents: 990,
      benchmarkReturnBp: 0, action: 'buy', positionQtyBefore: 0, stopPriceCents: null,
    })
    expect(metrics.returnBp).toBe(0)
    expect(metrics.directionHit).toBe(false)
    expect(metrics.alphaHit).toBe(false)
  })
})
