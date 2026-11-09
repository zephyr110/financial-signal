import { useEffect, useRef, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, Minus } from 'lucide-react'
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
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'

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

export function SourceChip({ source, link = true }: { source?: SourceRef; link?: boolean }) {
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
  // 列表行本身已是链接，芯片改用 span，避免嵌套 a。
  if (link && source.url && !demo) {
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
    return (
      <span className="ck-delta ck-flat">
        <Minus className="ck-delta-icon" aria-hidden="true" />
        <span className="sr-only">无涨跌数据</span>
      </span>
    )
  }
  const up = value > 0.00001
  const down = value < -0.00001
  const tone = up ? 'ck-up' : down ? 'ck-down' : 'ck-flat'
  const Icon = up ? ArrowUp : down ? ArrowDown : Minus
  return (
    <span className={`ck-delta ${tone}`}>
      <Icon className="ck-delta-icon" aria-hidden="true" />
      <span className="sr-only">涨跌幅：</span>
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
    <Alert variant="default" className="ck-demo-banner" role="note">
      <span className="ck-demo-tag">示例</span>
      <AlertDescription className="ck-demo-copy">
        {children || '界面演示数据，不是真实行情、政策或公告；接入真实来源后所有结论会重新计算。'}
      </AlertDescription>
    </Alert>
  )
}

const CLOSE_EVENT = 'ck:disclosure-close'

/** 表单提交成功后收起所在的 Collapsible，并把焦点还给触发按钮。 */
export function closeDisclosure(node: HTMLElement | null) {
  const root = node?.closest<HTMLElement>('[data-ck-disclosure]')
  if (!root) return
  root.dispatchEvent(new CustomEvent(CLOSE_EVENT))
  root.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')?.focus()
}

export function Disclosure({
  title,
  hint,
  defaultOpen = false,
  className = '',
  headingLevel,
  id,
  summaryLabel,
  icon,
  children,
}: {
  title: string
  hint?: ReactNode
  defaultOpen?: boolean
  className?: string
  headingLevel?: 2 | 3
  id?: string
  summaryLabel?: string
  icon?: ReactNode
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const close = () => setOpen(false)
    root.addEventListener(CLOSE_EVENT, close)
    return () => root.removeEventListener(CLOSE_EVENT, close)
  }, [])

  // 标题保持为独立 heading，触发按钮绝对铺满头部；否则 h2 会失去精确的可访问名称。
  const titleNode = headingLevel === 2
    ? <h2 className="ck-disclosure-title" id={id}>{title}</h2>
    : headingLevel === 3
      ? <h3 className="ck-disclosure-title" id={id}>{title}</h3>
      : <span className="ck-disclosure-title" id={id}>{title}</span>

  return (
    <div
      className={`ck-disclosure${open ? ' is-open' : ''} ${className}`.trim()}
      data-ck-disclosure
      ref={rootRef}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="ck-disclosure-head">
          {icon && (
            <span className="ck-disclosure-leading" aria-hidden="true">
              {icon}
            </span>
          )}
          {titleNode}
          {hint && <span className="ck-disclosure-hint">{hint}</span>}
          <ChevronDown className="ck-disclosure-icon" aria-hidden="true" />
          <CollapsibleTrigger
            className="ck-disclosure-trigger"
            aria-label={summaryLabel || title}
          />
        </div>
        <CollapsibleContent keepMounted>
          <div className="ck-disclosure-body">{children}</div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export function ThesisTag({ status }: { status?: ThesisStatus | string }) {
  if (!status) return null
  const key = (status in THESIS_CLASS ? status : 'active') as ThesisStatus
  return (
    <Badge variant="outline" className={THESIS_CLASS[key]}>
      {thesisStatusLabel(status)}
    </Badge>
  )
}

export function SectionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1">
      {children}
      <ArrowRight className="size-3.5" aria-hidden="true" />
    </Link>
  )
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

function healthMeta(item: SourceHealth): { last?: string; message?: string } {
  return { last: item.lastSuccessAt, message: item.message }
}

/** 与状态同义的说明不重复；示例库把“尚未接入”写成长句，也算同义。 */
function sourceMessage(status: HealthStatus, message?: string): string {
  if (!message) return ''
  if (message === STATUS_TEXT[status]) return ''
  if (status === 'inactive' && message.includes('尚未接入')) return ''
  return message
}

export function SourceHealthRail({ sources }: { sources: SourceHealth[] }) {
  if (sources.length === 0) {
    return <p className="ck-rail-note">暂无数据源状态。</p>
  }
  const sorted = sortByStatus(sources)
  return (
    <ul className="ck-rail-list">
      {sorted.map((source) => {
        const meta = healthMeta(source)
        const detail = sourceMessage(source.status, meta.message)
        return (
          <li className="ck-rail-row" key={source.id}>
            <span className={`ck-status-dot ck-status-${source.status}`} aria-hidden="true" />
            <div className="ck-rail-row-main">
              <span className="ck-rail-row-title">
                {source.name} <span className="ck-chip-tier">T{source.tier}</span>
              </span>
              <span className="ck-rail-row-meta">
                {STATUS_TEXT[source.status]}
                {meta.last ? ` · ${formatTime(meta.last)}` : ''}
                {detail ? ` · ${detail}` : ''}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** 简报生成时冻结的质量快照；与页脚的实时 sourceHealth 分开看。 */
export function BriefQualityList({ items }: { items: DataQualityItem[] }) {
  if (items.length === 0) return null
  return (
    <div className="ck-quality-snapshot">
      <h3 className="ck-quality-title">本期简报数据质量</h3>
      <p className="ck-quality-note">生成简报时的来源快照，不随后续同步变化。</p>
      <ul className="ck-rail-list">
        {sortByStatus(items).map((item) => {
          const detail = sourceMessage(item.status, item.message)
          return (
            <li className="ck-rail-row" key={item.id}>
              <span className={`ck-status-dot ck-status-${item.status}`} aria-hidden="true" />
              <div className="ck-rail-row-main">
                <span className="ck-rail-row-title">
                  {item.name} <span className="ck-chip-tier">T{item.tier}</span>
                </span>
                <span className="ck-rail-row-meta">
                  {STATUS_TEXT[item.status]}
                  {item.asOf ? ` · ${formatTime(item.asOf)}` : ''}
                  {detail ? ` · ${detail}` : ''}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
