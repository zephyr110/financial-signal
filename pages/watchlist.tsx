import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, WatchlistItem } from '@/lib/cockpit/types'
import { formatPrice } from '@/lib/cockpit/format'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getSourceHealth, getWatchlist } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import {
  DeltaValue,
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

export default function WatchlistPage({ items, sourceHealth, loadError }: WatchlistProps) {
  const isDemo = items.some((item) => item.source?.id.startsWith('demo-'))
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
        <section className="ck-section" aria-labelledby="watchlist-title">
          <SectionHeader
            id="watchlist-title"
            title={`${items.length} 个观察对象`}
            detail="按最新收盘价与论点状态展示；点击进入个股证据页。"
          />
          {items.length === 0 ? (
            <EmptyState
              title="观察名单还是空的"
              actions={<Link className="ck-button ck-button-primary" href="/tasks">去任务中心</Link>}
            >
              自选来自本地数据库。先完成行情入库，再从个股证据页加入观察名单。
            </EmptyState>
          ) : (
            <div className="ck-card ck-list-stack">
              {items.map((item) => (
                <article className="ck-watch-row" key={item.code}>
                  <div className="ck-watch-main">
                    <div className="ck-watch-code">
                      <span>{item.code}</span>
                      <span className="ck-watch-name">{item.name}</span>
                    </div>
                    <div className="ck-watch-meta">
                      {item.thesisStatus && <ThesisTag status={item.thesisStatus} />}
                      {item.nextEvent && <span>下一事件：{item.nextEvent}</span>}
                    </div>
                  </div>
                  <div className="ck-watch-side">
                    <p className="ck-watch-price">{formatPrice(item.price)}</p>
                    <DeltaValue value={item.changePct} />
                    <div className="ck-watch-spark">
                      <Sparkline
                        values={item.sparkline}
                        label={`${item.name}近 ${item.sparkline.length} 个交易日走势`}
                      />
                    </div>
                  </div>
                  <div className="ck-watch-wide">
                    <SourceChip source={item.source} />
                    <Link className="ck-link" href={`/stock/${encodeURIComponent(item.code)}`}>
                      查看证据 →
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </CockpitShell>
    </>
  )
}
