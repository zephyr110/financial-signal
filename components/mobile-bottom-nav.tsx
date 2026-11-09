import Link from 'next/link'
import { useRouter } from 'next/router'
import { MOBILE_ITEMS } from '@/lib/nav'
import { cn } from '@/lib/utils'

/** 手机端常驻五个主入口；新闻线索在“今日”页内切换。 */
export function MobileBottomNav() {
  const router = useRouter()
  return (
    <nav
      aria-label="主要导航"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/85 lg:hidden"
    >
      <div className="grid grid-cols-5">
        {MOBILE_ITEMS.map((item) => {
          const Icon = item.icon
          const active = item.match(router.pathname)
          // 只有 href 就是当前路径时才说“当前页”；子页面只标记所属分区。
          const current = router.pathname === item.href
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? (current ? 'page' : 'true') : undefined}
              className={cn(
                'relative flex min-h-14 flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors',
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {active && (
                <span className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-primary" aria-hidden="true" />
              )}
              <Icon className={cn('size-5', active && 'stroke-[2.2]')} aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
