import { describe, it, expect } from 'vitest'
import {
  evaluatePaperStageGate,
  type PaperGateFacts,
} from '../lib/paper/gates'
import type { PaperMetricsReport } from '../lib/paper/metrics'

/**
 * 阶段门纯判定：二值否决不进加权；缺证据是阻塞不是失败；
 * L2→L3 必须全收益基准 + 已校准，样本不足绩效项记 0。
 */

function l1Facts(overrides: Partial<PaperGateFacts> = {}): PaperGateFacts {
  return {
    gate: 'L1_TO_L2',
    sample: { validDays: 120, triggeredCards: 30, lastCardMature60: true },
    expectedTradingDays: 120,
    reconciliation: { total: 120, passed: 120, failed: 0 },
    lookahead: { status: 'pass' },
    incidents: { total: 0, unresolved: 0 },
    cards: { total: 10, complete: 10, policyDrift: false },
    execution: { fills: 10, explainable: 10, duplicateFills: 0, crashReplay: true },
    risk: { killSwitchActive: false },
    metrics: null,
    manual: { behavior: true, ux: true, compliance: true, crash_replay: true },
    ...overrides,
  }
}

function l2Metrics(overrides: {
  calibrated?: boolean
  basis?: PaperMetricsReport['benchmark']['basis']
  sharpe?: number
} = {}): PaperMetricsReport {
  return {
    benchmark: { code: 'H00300', basis: overrides.basis ?? 'total_return_index' },
    calibration: {
      status: overrides.calibrated === false ? 'uncalibrated' : 'calibrated',
      brier: overrides.calibrated === false ? null : 0.18,
    },
    accounts: { user: { maxDrawdownBp: 500, sharpe: overrides.sharpe ?? 1.1 } },
    excessBp: { user: 200 },
    execution: { executionRateBp: 9_500 },
  } as unknown as PaperMetricsReport
}

function l2Facts(overrides: Partial<PaperGateFacts> = {}): PaperGateFacts {
  return l1Facts({
    gate: 'L2_TO_L3',
    sample: { validDays: 250, triggeredCards: 100, lastCardMature60: true },
    expectedTradingDays: 250,
    reconciliation: { total: 250, passed: 250, failed: 0 },
    cards: { total: 100, complete: 100, policyDrift: false },
    execution: { fills: 50, explainable: 50, duplicateFills: 0, crashReplay: true },
    metrics: l2Metrics(),
    ...overrides,
  })
}

describe('阶段门判定', () => {
  it('L1 全部达标时通过，总分为 100', () => {
    const report = evaluatePaperStageGate(l1Facts())
    expect(report.decision).toBe('pass')
    expect(report.totalWeight).toBe(100)
    expect(report.totalRatioBp).toBe(10_000)
    expect(report.dimsBelow60).toEqual([])
    expect(report.vetoes.every((v) => v.status === 'pass')).toBe(true)
  })

  it('前视审计未执行是阻塞，不是失败', () => {
    const report = evaluatePaperStageGate(l1Facts({ lookahead: { status: 'not_run' } }))
    expect(report.decision).toBe('blocked')
    expect(report.blockedBy.join('')).toContain('前视审计')
    expect(report.failedCriteria).not.toContain('二值否决：前视审计')
  })

  it('对账不平衡直接二值否决', () => {
    const report = evaluatePaperStageGate(l1Facts({
      reconciliation: { total: 120, passed: 119, failed: 1 },
    }))
    expect(report.decision).toBe('fail')
    expect(report.vetoes.find((v) => v.key === 'reconciliation')?.status).toBe('fail')
    expect(report.failedCriteria.join('')).toContain('二值否决：对账平衡')
  })

  it('样本不足时即使其余全绿也不通过', () => {
    const report = evaluatePaperStageGate(l1Facts({
      sample: { validDays: 48, triggeredCards: 5, lastCardMature60: false },
      expectedTradingDays: 48,
    }))
    expect(report.decision).toBe('fail')
    expect(report.failedCriteria.join('')).toContain('样本门槛未达')
  })

  it('L2 已校准且绩效达标时通过', () => {
    const report = evaluatePaperStageGate(l2Facts())
    expect(report.decision).toBe('pass')
    expect(report.totalWeight).toBe(100)
    expect(report.totalRatioBp).toBe(10_000)
  })

  it('未校准不能进 L3，Brier 也为空', () => {
    const report = evaluatePaperStageGate(l2Facts({ metrics: l2Metrics({ calibrated: false }) }))
    expect(report.decision).toBe('fail')
    const calibration = report.dimensions.find((d) => d.key === 'calibration')
    expect(calibration?.ratioBp).toBe(0)
    expect(report.notes.join('')).toContain('校准未完成')
  })

  it('价格指数基准不能支撑绩效门', () => {
    const report = evaluatePaperStageGate(l2Facts({ metrics: l2Metrics({ basis: 'price_index' }) }))
    expect(report.decision).toBe('fail')
    const performance = report.dimensions.find((d) => d.key === 'performance')
    expect(performance?.ratioBp).toBe(0)
    expect(report.notes.join('')).toContain('价格指数')
  })

  it('夏普不足 0.5 时绩效项记 0', () => {
    const report = evaluatePaperStageGate(l2Facts({ metrics: l2Metrics({ sharpe: 0.4 }) }))
    expect(report.decision).toBe('fail')
    expect(report.failedCriteria.join('')).toContain('夏普')
  })
})
