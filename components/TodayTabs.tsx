import Link from 'next/link'
import { FileText, Newspaper } from 'lucide-react'
import { cn } from '@/lib/utils'

const VIEWS = [
  { href: '/today', label: '收盘简报', icon: FileText, key: 'brief' },
  { href: '/', label: '新闻线索', icon: Newspaper, key: 'news' },
] as const

export type TodayView = (typeof VIEWS)[number]['key']

/** 今日模块的两个视图共用同一入口，用路由切换，不再拆成两套产品。 */
export function TodayTabs({ active }: { active: TodayView }) {
  return (
    <nav
      aria-label="今日视图"
      className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5"
    >
      {VIEWS.map((view) => {
        const Icon = view.icon
        const current = view.key === active
        return (
          <Link
            key={view.href}
            href={view.href}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              current
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {view.label}
          </Link>
        )
      })}
    </nav>
  )
}
