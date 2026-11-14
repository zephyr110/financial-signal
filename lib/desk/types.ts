import type { SourceHealth } from '../cockpit/types'

export type DeskStance = 'bullish' | 'neutral' | 'bearish'
export type DeskConfidence = 'low' | 'medium' | 'high'
export type DeskSeverity = 'info' | 'watch' | 'important' | 'critical'
export type DeskJudgmentKind = 'market' | 'industry'

export interface DeskEvidence {
  id: string
  kind: string
  label: string
  value?: string
  sourceId?: string
  sourceName?: string
  documentId?: string
  asOf?: string
  freshnessSeconds?: number
}

export interface IndustryDailyView {
  tradeDate: string
  industry: string
  members: number
  upCount: number
  downCount: number
  flatCount: number
  limitUpCount: number
  limitDownCount: number
  avgPct: number
  medianPct: number
  breadth: number
  turnover: number
  turnoverChangePct: number | null
  momentum5d: number | null
  momentum20d: number | null
  leaderCode?: string
  leaderName?: string
  leaderPct?: number
  sourceId: string
  isDemo: boolean
}

export interface JudgmentEvaluation {
  horizonDays: number
  evalDate: string
  hit: boolean
  returnPct: number | null
  benchmarkPct: number | null
}

export interface JudgmentView {
  id: string
  tradeDate: string
  kind: DeskJudgmentKind
  industry?: string
  stance: DeskStance
  confidence: DeskConfidence
  score: number
  headline: string
  summary: string
  drivers: string[]
  risks: string[]
  reviewAt?: string
  status: 'open' | 'expired' | 'superseded'
  version: number
  sourceId?: string
  evidence: DeskEvidence[]
  evaluations: JudgmentEvaluation[]
  computedAt: string
  isDemo: boolean
}

export interface AlertView {
  id: string
  tradeDate: string
  severity: DeskSeverity
  category: string
  industry?: string
  symbolCode?: string
  title: string
  summary: string
  whyNow: string
  evidence: DeskEvidence[]
  judgmentId?: string
  status: 'open' | 'acknowledged' | 'expired'
  triggeredAt: string
  acknowledgedAt?: string
  isDemo: boolean
}

export interface OverseasQuoteView {
  symbol: string
  tradeTime: string
  price: number
  previousClose?: number
  changePct?: number
  sourceId: string
  delayMinutes?: number
  fetchedAt: string
}

export interface DeskSnapshot {
  tradeDate: string | null
  asOf: string
  market: JudgmentView | null
  industries: JudgmentView[]
  alerts: AlertView[]
  overseas: OverseasQuoteView[]
  dataQuality: SourceHealth[]
  isDemo: boolean
  generatedAt: string
}

export interface DeskStatus {
  tradeDate: string | null
  hasSnapshot: boolean
  stale: boolean
  staleSeconds: number | null
  openAlerts: number
  judgments: number
  industries: number
  lastComputedAt: string | null
  sourceHealth: SourceHealth[]
  isDemo: boolean
}

export type InvestigationStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type InvestigationFeedback = 'useful' | 'wrong' | 'incomplete'

export interface InvestigationStepView {
  stepNo: number
  kind: string
  tool?: string
  digest: string
  refs: string[]
  ok: boolean
  durationMs?: number
  tokens: number
  createdAt: string
}

export interface InvestigationView {
  id: string
  alertId?: string
  judgmentId?: string
  status: InvestigationStatus
  triggerReason: string
  question: string
  progress: number
  stepsUsed: number
  tokensUsed: number
  costMicros: number
  conclusion?: string
  confidence?: DeskConfidence
  evidenceStrength?: 'thin' | 'moderate' | 'strong'
  feedback?: InvestigationFeedback
  errorMessage?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  steps: InvestigationStepView[]
}

export interface InvestigationBudget {
  maxSteps: number
  timeoutMs: number
}

export interface DeskRefreshResult {
  tradeDate: string
  industries: number
  judgments: number
  alerts: number
  events: number
  evaluations: number
  overseas: number
  warnings: string[]
  isDemo: boolean
}
