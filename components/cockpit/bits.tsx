import type { ReactNode } from 'react'
import type {
  Confidence,
  DataQualityItem,
  HealthStatus,
  SourceHealth,
  SourceRef,
  ThesisStatus,
} from '@/lib/cockpit/types'
import {
  formatSignedPct,
  formatTime,
  thesisStatusLabel,
  tierLabel,
} from '@/lib/cockpit/format'

type HealthLike = SourceHealth | DataQualityItem

const STATUS_TEXT: Record<HealthStatus, string> = {
  ok: '正常',
  stale: '滞后',
  error: '异常',
  demo: '示例',
  inactive: '未接入',
}

// 有问题的源排前面，未接入的官方源排最后；否则停用项会长期占据首屏。
const STATUS_ORDER: Record<HealthStatus, number> = {
  error: 0,
  demo: 1,
  stale: 2,
  ok: 3,
  inactive: 4,
}

function sortByStatus<T extends { status: HealthStatus }>(items: T[]): T[] {
  return [...items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
}

const THESIS_CLASS: Record<ThesisStatus, string> = {
  active: 'ck-tag-active',
  strengthened: 'ck-tag-strengthened',
  weakened: 'ck-tag-weakened',
  broken: 'ck-tag-broken',
  review_due: 'ck-tag-review_due',
}

export function SourceChip({ source }: { source?: SourceRef }) {
  if (!source) return null
  const demo = source.id.startsWith('demo-') || source.name.includes('示例')
  const content = (
    <>
      <span className="ck-chip-dot" aria-hidden="true" />
      <span className="ck-chip-tier">{tierLabel(source.tier).slice(0, 2)}</span>
      <span className="ck-chip-name">{source.name}</span>
    </>
  )
  const title = `${tierLabel(source.tier)} · ${source.name} · 截至 ${source.asOf || '未知'}`
  const className = `ck-chip ck-tier-${source.tier}${demo ? ' ck-chip-demo' : ''}`
  if (source.url && !demo) {
    return (
      <a className={className} href={source.url} target="_blank" rel="noreferrer" title={title}>
        {content}
      </a>
    )
  }
  return <span className={className} title={title}>{content}</span>
}

export function ConfidencePill({ confidence }: { confidence: Confidence }) {
  const score = Number.isFinite(confidence.score) ? confidence.score : 0
  const active = score > 0.75 ? 3 : score >= 0.55 ? 2 : 1
  const tone = confidence.label === '低' ? 'low' : confidence.label === '高' ? 'high' : 'mid'
  return (
    <span
      className={`ck-confidence ck-confidence-${tone}`}
      aria-label={`置信度${confidence.label}，${Math.round(score * 100)} 分，满分 100 分`}
    >
      <span className="ck-confidence-track" aria-hidden="true">
        {[1, 2, 3].map((n) => (
          <span key={n} className={`ck-confidence-seg${n <= active ? ' is-on' : ''}`} />
        ))}
      </span>
      <span className="ck-confidence-label">置信度 {confidence.label}</span>
      <span className="ck-confidence-score">{Math.round(score * 100)}</span>
    </span>
  )
}

export function DeltaValue({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className="ck-delta ck-flat" aria-label="无涨跌数据">—</span>
  }
  const tone = value > 0.00001 ? 'ck-up' : value < -0.00001 ? 'ck-down' : 'ck-flat'
  const icon = value > 0.00001 ? '▲' : value < -0.00001 ? '▼' : '—'
  return (
    <span className={`ck-delta ${tone}`} aria-label={`涨跌幅 ${formatSignedPct(value)}`}>
      <span className="ck-delta-icon" aria-hidden="true">{icon}</span>
      {formatSignedPct(value)}
    </span>
  )
}

export function Sparkline({
  values,
  label,
  className = '',
  strokeWidth = 1.6,
}: {
  values: number[]
  label: string
  className?: string
  strokeWidth?: number
}) {
  const clean = values.filter((v) => Number.isFinite(v))
  if (clean.length < 2) {
    return <span className={`ck-spark ck-flat ${className}`} aria-label={label} />
  }
  const min = Math.min(...clean)
  const max = Math.max(...clean)
  const range = max - min || 1
  const h = 30
  const points = clean.map((value, index) => {
    const x = (index / (clean.length - 1)) * 100
    const y = h - 3 - ((value - min) / range) * (h - 6)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const line = `M ${points.join(' L ')}`
  const area = `${line} L 100,${h} L 0,${h} Z`
  const dir = clean[clean.length - 1] - clean[0]
  const tone = dir > 0.00001 ? 'ck-up' : dir < -0.00001 ? 'ck-down' : 'ck-flat'
  return (
    <svg
      className={`ck-spark ${tone} ${className}`}
      viewBox={`0 0 100 ${h}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path className="ck-spark-area" d={area} />
      <path className="ck-spark-line" d={line} strokeWidth={strokeWidth} />
    </svg>
  )
}

export function DemoBanner({ children }: { children?: ReactNode }) {
  return (
    <div className="ck-demo-banner" role="note">
      <span className="ck-demo-tag">示例</span>
      <span className="ck-demo-copy">
        {children || '界面演示数据，不是真实行情、政策或公告；接入真实来源后所有结论会重新计算。'}
      </span>
    </div>
  )
}

export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  className = '',
  headingLevel,
  id,
  summaryLabel,
  children,
}: {
  title: string
  hint?: ReactNode
  defaultOpen?: boolean
  className?: string
  headingLevel?: 2 | 3
  id?: string
  summaryLabel?: string
  children: ReactNode
}) {
  // 标题保留为真实 heading，键盘 H 导航才找得到；h2/h3 放在 summary 内是合法结构。
  const titleNode = headingLevel === 2
    ? <h2 className="ck-disclosure-title" id={id}>{title}</h2>
    : headingLevel === 3
      ? <h3 className="ck-disclosure-title" id={id}>{title}</h3>
      : <span className="ck-disclosure-title" id={id}>{title}</span>
  return (
    <details className={`ck-disclosure ${className}`.trim()} open={defaultOpen || undefined}>
      <summary aria-label={summaryLabel}>
        {titleNode}
        {hint && <span className="ck-disclosure-hint">{hint}</span>}
      </summary>
      <div className="ck-disclosure-body">{children}</div>
    </details>
  )
}

export function ThesisTag({ status }: { status?: ThesisStatus | string }) {
  if (!status) return null
  const key = (status in THESIS_CLASS ? status : 'active') as ThesisStatus
  return <span className={`ck-tag ${THESIS_CLASS[key]}`}>{thesisStatusLabel(status)}</span>
}

export function SectionHeader({
  title,
  detail,
  action,
  id,
}: {
  title: string
  detail?: string
  action?: ReactNode
  id?: string
}) {
  return (
    <div className="ck-section-head">
      <div className="ck-section-head-main">
        <h2 className="ck-section-title" id={id}>{title}</h2>
        {detail && <p className="ck-section-detail">{detail}</p>}
      </div>
      {action && <div className="ck-section-action">{action}</div>}
    </div>
  )
}

export function EmptyState({
  title,
  children,
  actions,
}: {
  title: string
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="ck-empty">
      <p className="ck-empty-title">{title}</p>
      {children && <p className="ck-empty-text">{children}</p>}
      {actions && <div className="ck-empty-actions">{actions}</div>}
    </div>
  )
}

function healthMeta(item: HealthLike): { last?: string; message?: string } {
  const last = (item as SourceHealth).lastSuccessAt || (item as DataQualityItem).asOf
  return { last, message: item.message }
}

export function SourceHealthRail({ sources }: { sources: SourceHealth[] }) {
  if (sources.length === 0) {
    return <p className="ck-rail-note">暂无数据源状态。</p>
  }
  const sorted = sortByStatus(sources)
  return (
    <ul className="ck-rail-list">
      {sorted.slice(0, 7).map((source) => (
        <li className="ck-rail-row" key={source.id}>
          <span className={`ck-status-dot ck-status-${source.status}`} aria-hidden="true" />
          <div className="ck-rail-row-main">
            <span className="ck-rail-row-title">
              {source.name} <span className="ck-chip-tier">T{source.tier}</span>
            </span>
            <span className="ck-rail-row-meta">
              {STATUS_TEXT[source.status]}
              {healthMeta(source).last ? ` · ${formatTime(healthMeta(source).last!)}` : ''}
              {healthMeta(source).message ? ` · ${healthMeta(source).message}` : ''}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function DataQualityPanel({ items }: { items: DataQualityItem[] }) {
  const sorted = sortByStatus(items)
  return (
    <div className="ck-card ck-quality-list">
      {sorted.length === 0 ? (
        <p className="ck-rail-note" style={{ padding: '12px 13px' }}>暂无数据源状态。</p>
      ) : (
        sorted.map((item) => (
          <div className="ck-quality-row" key={item.id}>
            <span className={`ck-status-dot ck-status-${item.status}`} aria-hidden="true" />
            <div className="ck-quality-body">
              <div className="ck-quality-head">
                <span className="ck-quality-name">{item.name}</span>
                <span className="ck-quality-status">
                  {tierLabel(item.tier).slice(0, 2)} · {STATUS_TEXT[item.status]}
                </span>
              </div>
              {(item.message || item.asOf) && (
                <p className="ck-quality-message">
                  {item.message || `更新于 ${formatTime(item.asOf)}`}
                </p>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
