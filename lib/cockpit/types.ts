/** 驾驶舱领域类型。金额一律整数分；行情价格是元；日期 YYYY-MM-DD。 */

export type SourceTier = 0 | 1 | 2 | 3
export type EvidenceKind = 'fact' | 'inference' | 'counter' | 'conclusion'
export type ConfidenceLabel = '低' | '中' | '高'
export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
export type TaskType =
  | 'daily_brief'
  | 'thesis_review'
  | 'ask'
  | 'weekly_review'
  | 'symbol_deep_dive'
  | 'market_ingest'
  | 'daily_close'
export type ThesisStatus = 'active' | 'strengthened' | 'weakened' | 'broken' | 'review_due'
export type HealthStatus = 'ok' | 'stale' | 'error' | 'demo' | 'inactive'

export interface SourceRef {
  id: string
  name: string
  tier: SourceTier
  asOf: string
  url?: string
}

export interface EvidenceItem {
  id: string
  kind: EvidenceKind
  label: string
  detail?: string
  value?: string
  source?: SourceRef
}

export interface ConfidenceInputs {
  completeness: number
  freshness: number
  agreement: number
  sourceQuality: number
}

export interface Confidence {
  score: number
  label: ConfidenceLabel
  inputs: ConfidenceInputs
}

export interface MarketIndex {
  code: string
  name: string
  close: number
  changePct: number
  sparkline: number[]
  source: SourceRef
}

export interface Breadth {
  up: number
  flat: number
  down: number
  limitUp: number
  limitDown: number
  /** false 表示本次未取到涨跌停统计；UI 必须显示“—”，不能把缺失画成 0。 */
  limitUpDownAvailable?: boolean
  source: SourceRef
}

export interface Turnover {
  value: number
  /** null 表示前一开市日成交额不可用，不能当成 0% 持平。 */
  changePct: number | null
  source: SourceRef
}

export interface PersonalImpact {
  code: string
  name: string
  headline: string
  detail: string
  thesisStatus?: ThesisStatus
  evidence: EvidenceItem[]
}

export interface DocumentSummary {
  id: string
  title: string
  issuer?: string
  documentNo?: string
  subjectCode?: string
  publishedAt: string
  effectiveAt?: string
  status?: string
  url?: string
  source: SourceRef
}

export interface DataQualityItem {
  id: string
  name: string
  tier: SourceTier
  status: HealthStatus
  asOf?: string
  message?: string
}

export interface TodayPayload {
  tradeDate: string
  issueNo: number
  session: 'post'
  hero: {
    claim: string
    confidence: Confidence
    evidence: EvidenceItem[]
  }
  indices: MarketIndex[]
  breadth: Breadth
  turnover: Turnover
  impacts: PersonalImpact[]
  documents: DocumentSummary[]
  tomorrow: string[]
  dataQuality: DataQualityItem[]
  isDemo: boolean
  generatedAt: string
  /** 可选的模型叙述层；数字、来源与置信度仍以服务端事实包为准。 */
  narrative?: {
    text: string
    model: string
    promptVersion: string
  }
}

export interface WatchlistItem {
  code: string
  name: string
  price: number | null
  changePct: number | null
  sparkline: number[]
  note?: string
  thesisStatus?: ThesisStatus
  nextEvent?: string
  source?: SourceRef
}

export interface PositionInput {
  code: string
  shares: number
  avgCostCents: number
}

export interface PositionView {
  code: string
  name: string
  shares: number
  avgCost: number
  price: number | null
  marketValue: number
  pnl: number
  pnlPct: number | null
  weight: number
  industry: string
  source?: SourceRef
}

export interface PortfolioRisk {
  level: 'info' | 'warn' | 'critical'
  title: string
  detail: string
}

export interface PortfolioView {
  totalValue: number
  totalPnl: number
  totalPnlPct: number | null
  positions: PositionView[]
  exposure: Array<{ industry: string; weight: number }>
  concentration: number
  risks: PortfolioRisk[]
  isDemo: boolean
}

export interface ThesisView {
  id: string
  code: string
  name: string
  title: string
  claim: string
  horizon: string
  status: ThesisStatus
  confidence: ConfidenceLabel
  invalidation: string[]
  supportCount: number
  opposeCount: number
  lastReviewedAt?: string
}

export interface StockDetail {
  code: string
  name: string
  exchange: string
  industry: string
  price: number | null
  changePct: number | null
  asOf: string
  bars: Array<{ date: string; close: number }>
  evidence: EvidenceItem[]
  documents: DocumentSummary[]
  thesis?: ThesisView
  isDemo: boolean
}

export interface SourceHealth {
  id: string
  name: string
  tier: SourceTier
  status: HealthStatus
  lastSuccessAt?: string
  message?: string
}

export interface TaskRecord {
  id: string
  type: TaskType | string
  status: TaskStatus
  progress: number
  step?: string
  params: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  createdAt: string
  startedAt?: string
  finishedAt?: string
  attempts: number
  costMicros: number
}

export interface TaskEvent {
  seq: number
  type: string
  payload: Record<string, unknown> | null
  createdAt: string
}

export type NotificationSeverity = 'info' | 'warn' | 'critical'

export interface NotificationRecord {
  id: string
  kind: string
  severity: NotificationSeverity
  title: string
  body?: string
  deepLink?: string
  readAt?: string
  createdAt: string
}

export interface JournalEntry {
  id: number
  entryDate: string
  code?: string
  action: string
  reason: string
  outcomeNote?: string
  createdAt: string
}

export interface FactRef {
  factId: string
  value: number | string
  unit: string
  asOf: string
  sourceId: string
  sourceUrl?: string
  tier: SourceTier
  formula?: string
  inputs?: string[]
}

export interface FactPack {
  tradeDate: string
  asOf: string
  indices: MarketIndex[]
  breadth: Breadth
  turnover: Turnover
  stocks: Array<{
    code: string
    name: string
    price: number
    changePct: number
    sparkline: number[]
    source: SourceRef
  }>
  documents: DocumentSummary[]
  positions: PositionInput[]
  theses: Array<{
    id: string
    code: string
    title: string
    status: ThesisStatus
    confidence: ConfidenceLabel
    invalidation: string[]
  }>
  facts: Record<string, FactRef>
  dataQuality: DataQualityItem[]
  isDemo: boolean
}

export interface ValidationIssue {
  code: string
  message: string
  severity: 'warn' | 'fail'
}

export interface ValidationResult {
  ok: boolean
  issues: ValidationIssue[]
}

export interface ApiMeta {
  asOf: string
  sourceHealth: SourceHealth[]
}
