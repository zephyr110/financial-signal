import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentAccuracyBucket,
  AgentDashboard,
  AgentDecisionView,
  AgentHorizonAccuracy,
  AgentRunDetail,
} from '@/lib/paper/agent-stats'
import { AgentDashboardView } from '@/components/paper/agent-dashboard'

vi.mock('next/router', () => ({
  useRouter: () => ({
    asPath: '/paper/agent',
    pathname: '/paper/agent',
    query: {},
    push: vi.fn(),
    replace: vi.fn(),
  }),
}))

const originalFetch = global.fetch
afterEach(() => {
  global.fetch = originalFetch
})

function bucket(overrides: Partial<AgentAccuracyBucket> = {}): AgentAccuracyBucket {
  return {
    key: 'buy',
    label: '买入',
    evaluated: 2,
    directionHitRate: 50,
    alphaHitRate: 50,
    avgReturnBp: 100,
    avgAlphaBp: 50,
    ...overrides,
  }
}

function horizon(horizonDays: 1 | 5 | 20, overrides: Partial<AgentHorizonAccuracy> = {}): AgentHorizonAccuracy {
  return {
    horizonDays,
    outcomes: 4,
    directional: 4,
    directionHitRate: 50,
    alphaEvaluated: 4,
    alphaHitRate: 50,
    invalidationRate: 25,
    avgReturnBp: 100,
    avgAlphaBp: 50,
    avgMfeBp: 300,
    avgMaeBp: -200,
    executed: { outcomes: 1, directionHitRate: 100, alphaHitRate: 100, avgReturnBp: 1_000, avgAlphaBp: 800 },
    byAction: [bucket()],
    byConviction: [bucket({ key: '70-84', label: '70-84' })],
    ...overrides,
  }
}

const decision: AgentDecisionView = {
  id: 'adec-arun-1-1',
  runId: 'arun-1',
  decidedForDate: '2026-11-25',
  symbolCode: '600000.SH',
  symbolName: '浦发银行',
  action: 'buy',
  actionLabel: '买入',
  conviction: 78,
  thesis: '站上 20 日均线且量能回升',
  evidence: ['收盘价高于 20 日均线', '量比 1.4'],
  counterEvidence: ['板块资金净流出'],
  invalidation: '收盘跌破 11.00',
  plannedQty: 8_300,
  plannedPriceCents: 1_200,
  stopPriceCents: 1_100,
  status: 'executed',
  statusReason: null,
  positionQtyBefore: 0,
  cardStatus: 'executed',
  orderStatus: 'filled',
  outcomes: [
    {
      horizonDays: 1,
      entryDate: '2026-11-25',
      evaluateDate: '2026-11-26',
      entryPriceCents: 1_000,
      endPriceCents: 1_100,
      returnBp: 1_000,
      benchmarkReturnBp: 200,
      alphaBp: 800,
      maxFavorableBp: 1_200,
      maxAdverseBp: -400,
      directionHit: true,
      alphaHit: true,
      invalidationHit: false,
      dataQuality: 'pass',
    },
  ],
}

function dashboard(overrides: Partial<AgentDashboard> = {}): AgentDashboard {
  return {
    generatedAt: '2026-11-25T09:35:00.000Z',
    experiment: {
      id: 'exp-1',
      name: '五十万实验',
      status: 'active',
      benchmarkCode: 'H00300',
      initialCashCents: 50_000_000,
      startedAt: '2026-06-01T00:00:00.000Z',
    },
    nav: {
      totalEquityCents: 52_000_000,
      cashCents: 20_000_000,
      marketValueCents: 32_000_000,
      positionCount: 2,
      returnBp: 400,
      benchmarkReturnBp: 100,
    },
    counts: { runs: 1, failedRuns: 0, decisions: 1, executed: 1, evaluated: 1 },
    runs: [{
      id: 'arun-1',
      barsDate: '2026-11-24',
      planTradeDate: '2026-11-25',
      status: 'planned',
      triggerSource: 'scheduled',
      model: 'deepseek-chat',
      marketView: '震荡偏强，量能温和放大',
      review: '上一期判断基本兑现',
      errorCode: null,
      errorMessage: null,
      decisions: 1,
      executed: 1,
      createdAt: '2026-11-24T09:35:00.000Z',
      completedAt: '2026-11-24T09:36:00.000Z',
    }],
    stats: [
      horizon(1, { directionHitRate: 40, alphaHitRate: 60, avgAlphaBp: 120 }),
      horizon(5, { directionHitRate: 62.5, alphaHitRate: 50, avgAlphaBp: 70 }),
      horizon(20, { outcomes: 0, directional: 0, directionHitRate: null, alphaEvaluated: 0, alphaHitRate: null }),
    ],
    recentDecisions: [decision],
    curve: [
      { date: '2026-11-21', totalEquityCents: 50_000_000, dailyReturnBp: 0, drawdownBp: 0 },
      { date: '2026-11-24', totalEquityCents: 52_000_000, dailyReturnBp: 400, drawdownBp: 0 },
    ],
    ...overrides,
  }
}

const detail: AgentRunDetail = {
  run: {
    id: 'arun-1',
    experimentId: 'exp-1',
    barsDate: '2026-11-24',
    planTradeDate: '2026-11-25',
    triggerSource: 'scheduled',
    status: 'planned',
    model: 'deepseek-chat',
    promptVersion: 'paper-agent-v1',
    inputJson: '{"market":{"gateRiskOff":false}}',
    rawResponse: '{"marketView":"震荡偏强"}',
    marketView: '震荡偏强，量能温和放大',
    review: '上一期判断基本兑现',
    usageJson: '{"total_tokens":100}',
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-11-24T09:35:00.000Z',
    completedAt: '2026-11-24T09:36:00.000Z',
  },
  attempts: [{ attemptNo: 1, rawResponse: '{}', errorMessage: null, usageJson: '{}', createdAt: '2026-11-24T09:35:30.000Z' }],
  decisions: [decision],
  events: [{ id: 1, decisionId: null, kind: 'planned', message: '计划已落库', payload: '{}', createdAt: '2026-11-24T09:36:00.000Z' }],
  cards: [],
  orders: [],
}

describe('AgentDashboardView', () => {
  it('默认看 T+5，可切到 T+1；战绩数字直接来自 horizons', () => {
    render(<AgentDashboardView dashboard={dashboard()} />)

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual(['T+1', 'T+5', 'T+20'])
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('62.5%')).toBeInTheDocument()

    fireEvent.click(tabs[0])
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('40.0%')).toBeInTheDocument()
    expect(screen.getByText('震荡偏强，量能温和放大')).toBeInTheDocument()
  })

  it('列出决策的证据、反证、证伪条件与 T+1 结果', () => {
    render(<AgentDashboardView dashboard={dashboard()} />)

    expect(screen.getByText('浦发银行')).toBeInTheDocument()
    expect(screen.getByText('站上 20 日均线且量能回升')).toBeInTheDocument()
    expect(screen.getByText('收盘价高于 20 日均线')).toBeInTheDocument()
    expect(screen.getByText('板块资金净流出')).toBeInTheDocument()
    expect(screen.getByText(/收盘跌破 11\.00/)).toBeInTheDocument()
    expect(screen.getByText('+10.00%')).toBeInTheDocument()
    expect(screen.getByText('α +8.00%')).toBeInTheDocument()
  })

  it('点开运行记录会拉取完整审计并渲染输入与事件', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: detail }),
    }) as unknown as Response)

    render(<AgentDashboardView dashboard={dashboard()} />)
    fireEvent.click(screen.getByRole('button', { name: /11\/24 收盘/ }))

    expect(global.fetch).toHaveBeenCalledWith('/api/paper/agent/runs/arun-1', expect.anything())
    expect(await screen.findByText(/运行 arun-1/)).toBeInTheDocument()
    expect(screen.getByText('计划已落库')).toBeInTheDocument()
    expect(screen.getByText('原始输入（行情/新闻/账户快照）')).toBeInTheDocument()
    expect(screen.getByText('{"market":{"gateRiskOff":false}}')).toBeInTheDocument()
  })

  it('没有实验时给出创建入口，而不是空表格', () => {
    render(<AgentDashboardView dashboard={dashboard({
      experiment: null,
      nav: null,
      counts: { runs: 0, failedRuns: 0, decisions: 0, executed: 0, evaluated: 0 },
      runs: [],
      recentDecisions: [],
      curve: [],
    })} />)

    expect(screen.getByText('模拟盘还没建实验')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: '去创建' })).toHaveAttribute('href', '/paper')
  })
})
