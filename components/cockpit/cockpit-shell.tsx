import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowUpRight } from 'lucide-react'
import type { SourceHealth } from '@/lib/cockpit/types'
import { formatTime } from '@/lib/cockpit/format'
import AppShell from '@/components/app-shell'
import { DemoBanner, SourceHealthRail } from './bits'


/**
 * 收盘手记页面容器：与旧工作台共用 AppShell / 侧栏 / 顶栏 / 移动底栏，
 * 这里只保留驾驶舱的页头、来源栏与页脚。
 */
export function CockpitShell({
  title,
  eyebrow,
  subtitle,
  asOf,
  isDemo,
  actions,
  sourceHealth = [],
  children,
}: {
  title: string
  eyebrow?: string
  subtitle?: ReactNode
  asOf?: string
  isDemo?: boolean
  actions?: ReactNode
  sourceHealth?: SourceHealth[]
  children: ReactNode
}) {
  return (
    <AppShell title={title} actions={actions}>
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-10 sm:px-6 sm:pb-14">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_280px] lg:gap-8 xl:gap-10">
          <main className="min-w-0" id="ck-main">
            <header className="pb-5 pt-6 sm:pt-7">
              <h1 className="sr-only">{title}</h1>
              {(eyebrow || asOf) && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {eyebrow && <span>{eyebrow}</span>}
                  {eyebrow && asOf && <span aria-hidden="true">·</span>}
                  {asOf && <span>更新 {formatTime(asOf)}</span>}
                </div>
              )}
              {subtitle && (
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">{subtitle}</p>
              )}
            </header>

            <div className="ck-root">
              {isDemo && <DemoBanner />}
              {children}
              <footer className="mt-8 flex flex-wrap justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
                <span>收盘手记 · 个人研究记录，不构成投资建议。</span>
                <span>数据先于判断。</span>
              </footer>
            </div>
          </main>

          <aside className="ck-root ck-rail lg:pt-7" aria-label="辅助信息">
            <section className="ck-rail-card">
              <h2 className="ck-rail-title">数据源状态</h2>
              <SourceHealthRail sources={sourceHealth} />
              <Link className="ck-rail-link" href="/tasks">
                查看任务中心
                <ArrowUpRight aria-hidden="true" />
              </Link>
            </section>
          </aside>
        </div>
      </div>
    </AppShell>
  )
}
