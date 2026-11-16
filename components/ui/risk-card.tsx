import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export type RiskTone = 'info' | 'warn' | 'critical'

const TONE: Record<RiskTone, { root: string; icon: string; label: string }> = {
  info: { root: 'border-border bg-muted/45', icon: 'text-muted-foreground', label: '提示' },
  warn: { root: 'border-chart-5/35 bg-chart-5/10', icon: 'text-chart-5', label: '注意' },
  critical: { root: 'border-destructive/35 bg-destructive/10', icon: 'text-destructive', label: '严重' },
}

/** 风险预警统一外观：高亮底色 + 警告图标；级别另有文字标签，不靠颜色单独传达。 */
export function RiskCard({
  tone = 'warn',
  title,
  meta,
  children,
  action,
  showLevel = true,
  className,
}: {
  tone?: RiskTone
  title?: ReactNode
  meta?: ReactNode
  children?: ReactNode
  action?: ReactNode
  showLevel?: boolean
  className?: string
}) {
  const t = TONE[tone]
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5', t.root, className)} role="note">
      <TriangleAlert className={cn('mt-0.5 size-4 shrink-0', t.icon)} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {showLevel && (
            <span className={cn('text-[10px] font-semibold tracking-wide', t.icon)}>{t.label}</span>
          )}
          {title && <p className="text-[13px] font-semibold leading-5 text-foreground">{title}</p>}
          {meta}
        </div>
        {children && <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{children}</div>}
        {action && <div className="mt-1.5">{action}</div>}
      </div>
    </div>
  )
}
