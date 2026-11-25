import { useEffect, useMemo, useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, WatchlistItem } from '@/lib/cockpit/types'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getSourceHealth, getWatchlist } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { sortWatchlistItems, type WatchlistSort } from '@/lib/cockpit/watchlist-sort'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { WatchlistEditor } from '@/components/cockpit/watchlist-editor'
import { WatchlistRow } from '@/components/cockpit/watchlist-row'
import { Disclosure, EmptyState, SectionHeader } from '@/components/cockpit/bits'
import { Button } from '@/components/ui/button'
import { http } from '@/lib/http/client'

const SORT_OPTIONS: Array<{ value: WatchlistSort; label: string; ariaLabel: string }> = [
  { value: 'default', label: '默认', ariaLabel: '按默认顺序排列' },
  { value: 'change-desc', label: '涨幅榜', ariaLabel: '按涨跌幅从高到低排序' },
  { value: 'change-asc', label: '跌幅榜', ariaLabel: '按涨跌幅从低到高排序' },
]

interface WatchlistProps {
  items: WatchlistItem[]
  sourceHealth: SourceHealth[]
  loadError?: string
}

/** 补库开始后轮询；任务结束（成功或失败）时重新取服务端数据。 */
function BackfillRefresh({ active }: { active: boolean }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const json = await http.get<{ data?: WatchlistItem[] }>('/api/cockpit/watchlist')
          const waiting = (json.data || []).some((item) =>
            item.price === null && (item.backfill === 'queued' || item.backfill === 'running'))
          if (!waiting) await router.replace(router.asPath)
        } catch {
          // 网络抖动交给下一次轮询。
        }
      })()
    }, 5000)
    return () => clearInterval(timer)
  }, [active, router])
  return null
}

/** 从个股页带 #watch-<code> 返回时，滚动到对应自选卡片并短暂高亮。 */
function FocusWatchRow() {
  const router = useRouter()
  useEffect(() => {
    const hash = window.location.hash
    if (!hash.startsWith('#watch-')) return
    const target = document.getElementById(hash.slice(1))
    if (!target) return
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    target.classList.add('is-focus-target')
    const timer = setTimeout(() => target.classList.remove('is-focus-target'), 2400)
    return () => {
      clearTimeout(timer)
      target.classList.remove('is-focus-target')
    }
  }, [router.asPath])
  return null
}

export const getServerSideProps: GetServerSideProps<WatchlistProps> = async () => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [items, sourceHealth] = await Promise.all([getWatchlist(), getSourceHealth()])
    return { props: serializable({ items, sourceHealth }) }
  } catch (err) {
    console.error('[watchlist]', err instanceof Error ? err.message : err)
    return {
      props: {
        items: [],
        sourceHealth: [],
        loadError: '自选数据暂时不可用，请稍后刷新。',
      },
    }
  }
}

export default function WatchlistPage({ items, sourceHealth, loadError }: WatchlistProps) {
  const [sort, setSort] = useState<WatchlistSort>('default')
  const sortedItems = useMemo(() => sortWatchlistItems(items, sort), [items, sort])
  const isDemo = items.some((item) => item.source?.id.startsWith('demo-'))
  const backfillActive = items.some((item) =>
    item.price === null && (item.backfill === 'queued' || item.backfill === 'running'))

  return (
    <>
      <Head>
        <title>自选 · 财经信号</title>
        <meta name="description" content="个人自选标的与论点状态" />
      </Head>
      <CockpitShell
        title="自选"
        eyebrow="自选个股"
        subtitle="只放需要持续验证的个股。价格是事实，论点状态是仍需检验的解释。"
        isDemo={isDemo}
        sourceHealth={sourceHealth}
      >
        <BackfillRefresh active={backfillActive} />
        <FocusWatchRow />
        {loadError && <div className="ck-error-banner">{loadError}</div>}

        <Disclosure title="添加自选个股" hint="加入后自动排队补齐行情" headingLevel={2}>
          <WatchlistEditor />
        </Disclosure>

        <section className="ck-section" aria-labelledby="watchlist-title">
          <SectionHeader
            id="watchlist-title"
            title={`${items.length} 只自选个股`}
            detail="按最新收盘价与论点状态展示；点击整行展开证据，或进入完整个股页。"
            actionClassName="ck-section-action-plain"
            action={items.length > 1 ? (
              <div className="ck-watch-sort" role="group" aria-label="自选个股排序">
                <span className="ck-watch-sort-label">排序</span>
                {SORT_OPTIONS.map((option) => (
                  <Button
                    key={option.value}
                    type="button"
                    size="xs"
                    variant={sort === option.value ? 'secondary' : 'ghost'}
                    aria-pressed={sort === option.value}
                    aria-label={option.ariaLabel}
                    onClick={() => setSort(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            ) : undefined}
          />
          {items.length === 0 ? (
            <EmptyState title="还没有自选个股">
              展开上方“添加自选个股”登记代码。加入后不会自动生成价格或结论，需等行情与公告入库。
            </EmptyState>
          ) : (
            <div className="ck-card ck-list-stack">
              {sortedItems.map((item) => (
                <WatchlistRow item={item} key={item.code} />
              ))}
            </div>
          )}
        </section>
      </CockpitShell>
    </>
  )
}
