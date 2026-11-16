import { useEffect } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, WatchlistItem } from '@/lib/cockpit/types'
import { formatPrice } from '@/lib/cockpit/format'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getSourceHealth, getWatchlist } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { WatchlistEditor, WatchlistRemove } from '@/components/cockpit/watchlist-editor'
import {
  DeltaValue,
  Disclosure,
  EmptyState,
  SectionHeader,
  SourceChip,
  Sparkline,
  ThesisTag,
} from '@/components/cockpit/bits'

interface WatchlistProps {
  items: WatchlistItem[]
  sourceHealth: SourceHealth[]
  loadError?: string
}

function backfillLabel(status: WatchlistItem['backfill']): string {
  if (status === 'queued' || status === 'running') return '行情自动补齐中'
  if (status === 'failed') return '上次补库失败，下次行情入库时重试'
  return '行情待入库'
}

/** 补库开始后轮询；任务结束（成功或失败）时重新取服务端数据。 */
function BackfillRefresh({ active }: { active: boolean }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      void (async () => {
        try {
          const res = await fetch('/api/cockpit/watchlist', { headers: { Accept: 'application/json' } })
          if (!res.ok) return
          const json = await res.json() as { data?: WatchlistItem[] }
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
        eyebrow="观察名单"
        subtitle="只放需要持续验证的标的。价格是事实，论点状态是仍需检验的解释。"
        isDemo={isDemo}
        sourceHealth={sourceHealth}
      >
        <BackfillRefresh active={backfillActive} />
        {loadError && <div className="ck-error-banner">{loadError}</div>}

        <Disclosure title="添加观察对象" hint="加入后自动排队补齐行情" headingLevel={2}>
          <WatchlistEditor />
        </Disclosure>

        <section className="ck-section" aria-labelledby="watchlist-title">
          <SectionHeader
            id="watchlist-title"
            title={`${items.length} 个观察对象`}
            detail="按最新收盘价与论点状态展示；点击进入个股证据页。"
          />
          {items.length === 0 ? (
            <EmptyState title="观察名单还是空的">
              展开上方“添加观察对象”，先登记一个股票代码。加入后不会自动生成价格或结论，必须等行情与公告入库。
            </EmptyState>
          ) : (
            <>
              <div className="ck-card ck-list-stack">
                {items.map((item) => (
                  <article className="ck-watch-row" key={item.code}>
                    <Link
                      className="ck-watch-main"
                      href={`/stock/${encodeURIComponent(item.code)}`}
                    >
                      <div className="ck-watch-copy">
                        <div className="ck-watch-code">
                          <span>{item.code}</span>
                          {/* 名称未入库时回退为代码，这里不再重复显示。 */}
                          {item.name !== item.code && (
                            <span className="ck-watch-name">{item.name}</span>
                          )}
                        </div>
                        <div className="ck-watch-meta">
                          {item.thesisStatus && <ThesisTag status={item.thesisStatus} />}
                          <SourceChip source={item.source} link={false} />
                          {item.nextEvent && <span>下一事件：{item.nextEvent}</span>}
                          {item.price === null && <span>{backfillLabel(item.backfill)}</span>}
                        </div>
                        {item.note && <p className="ck-watch-note">{item.note}</p>}
                      </div>
                      <div className="ck-watch-side">
                        <p className={`ck-watch-price${item.price === null ? ' is-pending' : ''}`}>
                          {item.price === null
                            ? (item.backfill === 'queued' || item.backfill === 'running' ? '补齐中' : '待入库')
                            : formatPrice(item.price)}
                        </p>
                        {item.price !== null && <DeltaValue value={item.changePct} />}
                        {item.sparkline.length > 1 && (
                          <div className="ck-watch-spark">
                            <Sparkline
                              values={item.sparkline}
                              changePct={item.changePct}
                              label={`${item.name}近 ${item.sparkline.length} 个交易日走势`}
                            />
                          </div>
                        )}
                        <span className="ck-sr-only">查看 {item.name} 证据</span>
                      </div>
                    </Link>
                    <div className="ck-watch-action">
                      <WatchlistRemove code={item.code} name={item.name} />
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </section>
      </CockpitShell>
    </>
  )
}
