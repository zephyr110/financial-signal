import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, SourceRef, WatchlistItem } from '@/lib/cockpit/types'
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

function uniqueSources(items: WatchlistItem[]): SourceRef[] {
  const sources = items.map((item) => item.source).filter((source): source is SourceRef => Boolean(source))
  return sources.filter((source, index, all) => all.findIndex((item) => item.id === source.id) === index)
}

export default function WatchlistPage({ items, sourceHealth, loadError }: WatchlistProps) {
  const isDemo = items.some((item) => item.source?.id.startsWith('demo-'))
  const sources = uniqueSources(items)

  return (
    <>
      <Head>
        <title>自选 · 收盘手记</title>
        <meta name="description" content="个人自选标的与论点状态" />
      </Head>
      <CockpitShell
        title="自选"
        eyebrow="WATCHLIST · 观察名单"
        subtitle="只放需要持续验证的标的。价格是事实，论点状态是仍需检验的解释。"
        isDemo={isDemo}
        sourceHealth={sourceHealth}
      >
        {loadError && <div className="ck-error-banner">{loadError}</div>}

        <Disclosure title="添加观察对象" hint="代码先入库，行情接入后补齐">
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
              {sources.length > 0 && (
                <p className="ck-list-source">
                  <span>行情来源</span>
                  {sources.map((source) => <SourceChip source={source} key={source.id} />)}
                </p>
              )}
              <div className="ck-card ck-list-stack">
                {items.map((item) => (
                  <article className="ck-watch-row" key={item.code}>
                    <Link
                      className="ck-watch-main"
                      href={`/stock/${encodeURIComponent(item.code)}`}
                    >
                      <div className="ck-watch-code">
                        <span>{item.code}</span>
                        <span className="ck-watch-name">{item.name}</span>
                      </div>
                      <div className="ck-watch-meta">
                        {item.thesisStatus && <ThesisTag status={item.thesisStatus} />}
                        {item.nextEvent && <span>下一事件：{item.nextEvent}</span>}
                        {item.price === null && <span>行情待入库</span>}
                      </div>
                      {item.note && <p className="ck-watch-note">{item.note}</p>}
                    </Link>
                    <Link
                      className="ck-watch-side"
                      href={`/stock/${encodeURIComponent(item.code)}`}
                      aria-label={`查看 ${item.name} 证据`}
                    >
                      <p className={`ck-watch-price${item.price === null ? ' is-pending' : ''}`}>
                        {item.price === null ? '待入库' : formatPrice(item.price)}
                      </p>
                      {item.price !== null && <DeltaValue value={item.changePct} />}
                      {item.sparkline.length > 1 && (
                        <div className="ck-watch-spark">
                          <Sparkline
                            values={item.sparkline}
                            label={`${item.name}近 ${item.sparkline.length} 个交易日走势`}
                          />
                        </div>
                      )}
                    </Link>
                    <div className="ck-watch-wide">
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
