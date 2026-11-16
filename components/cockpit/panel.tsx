import type { ReactNode } from 'react'
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

interface PanelProps {
  id: string
  title: string
  icon: ReactNode
  meta?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}

/**
 * 驾驶舱面板：标题区/工具区/内容区三段。xl 起面板各自滚动并固定滚动条槽位，
 * 窄屏交给整页滚动，避免嵌套滚动。
 */
export function Panel({ id, title, icon, meta, action, children, className, bodyClassName }: PanelProps) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className={cn('flex min-h-[280px] min-w-0 flex-col overflow-hidden rounded-xl border bg-card xl:min-h-0', className)}
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">{icon}</span>
          <h2 id={`${id}-title`} className="truncate text-[13px] font-semibold tracking-tight">{title}</h2>
          {meta && <span className="truncate text-[11px] text-muted-foreground">{meta}</span>}
        </div>
        {action && <div className="flex shrink-0 items-center gap-1">{action}</div>}
      </header>
      <div className={cn('min-h-0 flex-1 xl:overflow-y-auto xl:[scrollbar-gutter:stable]', bodyClassName)}>
        {children}
      </div>
    </section>
  )
}

export function PanelRefresh({ label, refreshing, onClick }: { label: string; refreshing: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground"
      aria-label={`刷新${label}`}
      title={`刷新${label}`}
      disabled={refreshing}
      onClick={onClick}
    >
      <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin motion-reduce:animate-none')} />
    </Button>
  )
}

export function PanelSkeleton({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label={`${label}加载中`}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn('h-4 rounded-md', index === 0 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  )
}

export function PanelError({ message, onRetry, retrying = false }: { message: string; onRetry?: () => void; retrying?: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
      <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
      <p className="text-xs leading-5 text-muted-foreground">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" disabled={retrying} onClick={onRetry}>
          {retrying ? <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" /> : <RefreshCw className="size-3.5" />}
          重试
        </Button>
      )}
    </div>
  )
}

export function PanelEmpty({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      {icon && <span className="text-muted-foreground [&_svg]:size-6" aria-hidden="true">{icon}</span>}
      <p className="text-[13px] font-medium">{title}</p>
      {children && <p className="max-w-xs text-xs leading-5 text-muted-foreground">{children}</p>}
      {action}
    </div>
  )
}
