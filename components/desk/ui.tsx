import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { AlertView, DeskConfidence, DeskStance, JudgmentView } from '@/lib/desk/types'

export function DeskPanel({
  icon,
  title,
  meta,
  action,
  children,
  className,
  contentClassName,
}: {
  icon: ReactNode
  title: string
  meta?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  return (
    <Card className={cn('flex min-h-[300px] flex-col gap-0 overflow-hidden py-0 xl:min-h-0', className)}>
      <CardHeader className="relative flex shrink-0 flex-row items-center justify-between gap-2 px-4 py-2.5 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/60 after:content-['']">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
          <h2 className="truncate text-[13px] font-semibold tracking-tight">{title}</h2>
          {meta && <span className="truncate text-[11px] text-muted-foreground">{meta}</span>}
        </div>
        {action}
      </CardHeader>
      {/* 窄屏由整页滚动，xl 固定四栏时面板才各自滚动，避免嵌套滚动陷阱 */}
      <CardContent className={cn('min-h-0 p-0 xl:flex-1 xl:overflow-y-auto', contentClassName)}>{children}</CardContent>
    </Card>
  )
}

export function stanceText(stance: DeskStance): string {
  return stance === 'bullish' ? '看多' : stance === 'bearish' ? '看空' : '中性'
}

export function StanceBadge({ stance }: { stance: DeskStance }) {
  const label = stanceText(stance)
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 px-1.5 text-[11px]',
        stance === 'bullish' && 'border-chart-3/40 bg-chart-3/10 text-chart-3',
        stance === 'bearish' && 'border-chart-2/40 bg-chart-2/10 text-chart-2',
        stance === 'neutral' && 'text-muted-foreground',
      )}
    >
      {label}
    </Badge>
  )
}

export function confidenceText(confidence: DeskConfidence): string {
  return confidence === 'high' ? '高置信' : confidence === 'medium' ? '中置信' : '低置信'
}

export function ConfidenceBadge({ confidence }: { confidence: DeskConfidence }) {
  return <Badge variant={confidence === 'high' ? 'secondary' : 'outline'} className="h-5 px-1.5 text-[11px]">{confidenceText(confidence)}</Badge>
}

export function SeverityBadge({ severity }: { severity: AlertView['severity'] }) {
  const label = { info: '提示', watch: '关注', important: '重要', critical: '关键' }[severity]
  return (
    <Badge
      variant="outline"
      className={cn(
        'h-5 px-1.5 text-[11px]',
        severity === 'critical' && 'border-destructive/40 bg-destructive/10 text-destructive',
        severity === 'important' && 'border-chart-5/50 bg-chart-5/10 text-chart-5',
        severity === 'watch' && 'border-chart-4/40 text-muted-foreground',
        severity === 'info' && 'text-muted-foreground',
      )}
    >
      {label}
    </Badge>
  )
}

export function JudgmentRow({ judgment, onSelect }: { judgment: JudgmentView; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="relative flex w-full items-start gap-3 px-4 py-3 text-left transition-colors duration-150 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/50 after:content-[''] last:after:hidden hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-semibold tracking-tight">{judgment.industry || '市场'}</span>
          {judgment.relation && (
            <Badge
              variant={judgment.relation === 'holding' ? 'secondary' : 'outline'}
              className="h-5 shrink-0 px-1.5 text-[10px]"
            >
              {judgment.relation === 'holding' ? '持仓' : '自选'}
            </Badge>
          )}
          <StanceBadge stance={judgment.stance} />
          <ConfidenceBadge confidence={judgment.confidence} />
        </div>
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{judgment.headline}</p>
      </div>
      <span className="shrink-0 pt-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{judgment.score.toFixed(1)}</span>
    </button>
  )
}

export function AlertRow({
  alert,
  onDeepDive,
  onAcknowledge,
  busy,
}: {
  alert: AlertView
  onDeepDive: () => void
  onAcknowledge: () => void
  busy?: boolean
}) {
  return (
    <div className="relative px-4 py-3 after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/50 after:content-[''] last:after:hidden">
      <div className="flex min-w-0 items-start gap-2">
        <SeverityBadge severity={alert.severity} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold leading-5 tracking-tight">{alert.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">{alert.whyNow}</p>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted-foreground">
          {alert.industry ? `${alert.industry} · ` : ''}证据 {alert.evidence.length} 条
        </span>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            className="rounded-md px-2 py-1 text-[11px] font-medium text-primary transition-colors duration-150 hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onClick={onDeepDive}
          >
            深挖
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
            onClick={onAcknowledge}
          >
            已读
          </button>
        </div>
      </div>
    </div>
  )
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-24 items-center justify-center px-4 py-6 text-center text-xs text-muted-foreground">{children}</div>
}
