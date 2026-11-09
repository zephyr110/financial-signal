import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Database } from 'lucide-react'
import type { DataQualityItem, SourceHealth } from '@/lib/cockpit/types'
import { briefQualityHint, formatTime, sourceHealthHint } from '@/lib/cockpit/format'
import AppShell from '@/components/app-shell'
import { BriefQualityList, DemoBanner, Disclosure, SourceHealthRail } from './bits'


/**
 * 收盘手记页面容器：共用 AppShell / 侧栏 / 顶栏 / 移动底栏，
 * 这里只保留驾驶舱的页头、来源状态与页脚。
 */
export function CockpitShell({
  title,
  eyebrow,
  subtitle,
  asOf,
  isDemo,
  actions,
  headerAction,
  sourceHealth = [],
  dataQuality,
  children,
}: {
  title: string
  eyebrow?: string
  subtitle?: ReactNode
  asOf?: string
  isDemo?: boolean
  actions?: ReactNode
  headerAction?: ReactNode
  sourceHealth?: SourceHealth[]
  /** 简报生成时冻结的数据质量快照；只有 /today 传。 */
  dataQuality?: DataQualityItem[]
  children: ReactNode
}) {
  const sourceHint = [briefQualityHint(dataQuality ?? []), sourceHealthHint(sourceHealth)]
    .filter(Boolean)
    .join(' · ')
  // /today 多一份简报期快照，标题里点出来，否则用户不知道收起的内容还有它。
  const sourceTitle = dataQuality?.length ? '数据源与简报质量' : '数据源状态'

  return (
    <AppShell title={title} actions={actions}>
      <div className="mx-auto w-full max-w-[960px] px-4 pb-10 sm:px-6 sm:pb-14">
        <main className="min-w-0" id="ck-main">
          <header className="flex flex-wrap items-start justify-between gap-3 pb-5 pt-6 sm:pt-7">
            <div className="min-w-0">
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
            </div>
            {headerAction && <div className="shrink-0">{headerAction}</div>}
          </header>

          <div className="ck-root">
            {isDemo && <DemoBanner />}
            {children}
            <footer className="mt-8 border-t pt-3">
              <Disclosure
                className="ck-source-status"
                title={sourceTitle}
                hint={sourceHint}
                headingLevel={2}
                summaryLabel={`${sourceTitle}，${sourceHint}`}
                icon={<Database className="size-3.5" />}
              >
                <SourceHealthRail sources={sourceHealth} />
                {dataQuality && <BriefQualityList items={dataQuality} />}
                <Link className="ck-rail-link" href="/tasks">
                  查看任务中心
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Disclosure>
              <div className="mt-3 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                <span>收盘手记 · 个人研究记录，不构成投资建议。</span>
                <span>数据先于判断。</span>
              </div>
            </footer>
          </div>
        </main>
      </div>
    </AppShell>
  )
}
