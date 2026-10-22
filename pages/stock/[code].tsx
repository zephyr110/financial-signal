import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, StockDetail } from '@/lib/cockpit/types'
import { formatDateCn, formatPrice, formatTime } from '@/lib/cockpit/format'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getSourceHealth, getStockDetail } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { EvidenceSpine } from '@/components/cockpit/evidence-spine'
import { DocumentList } from '@/components/cockpit/document-list'
import { ThesisCard } from '@/components/cockpit/thesis-card'
import {
  DeltaValue,
  EmptyState,
  SectionHeader,
  Sparkline,
} from '@/components/cockpit/bits'

interface StockProps {
  code: string
  detail: StockDetail | null
  sourceHealth: SourceHealth[]
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<StockProps> = async (context) => {
  const raw = context.params?.code
  const code = Array.isArray(raw) ? raw[0] : raw || ''
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [detail, sourceHealth] = await Promise.all([getStockDetail(code), getSourceHealth()])
    return { props: serializable({ code, detail, sourceHealth }) }
  } catch (err) {
    console.error('[stock]', err instanceof Error ? err.message : err)
    return {
      props: {
        code,
        detail: null,
        sourceHealth: [],
        loadError: '个股数据暂时不可用，请稍后刷新。',
      },
    }
  }
}

export default function StockPage({ code, detail, sourceHealth, loadError }: StockProps) {
  if (!detail) {
    return (
      <>
        <Head>
          <title>个股证据 · 收盘手记</title>
        </Head>
        <CockpitShell
          title="个股证据"
          eyebrow={code || 'UNKNOWN SYMBOL'}
          subtitle="没有找到这个标的的行情或档案。"
          sourceHealth={sourceHealth}
        >
          {loadError && <div className="ck-error-banner">{loadError}</div>}
          <EmptyState
            title="这个标的还没有入库"
            actions={(
              <>
                <Link className="ck-button" href="/watchlist">返回自选</Link>
                <Link className="ck-button ck-button-primary" href="/tasks">运行个股深挖</Link>
              </>
            )}
          >
            个股页只展示已有行情与文档的标的。先在任务中心按代码读取证据，或完成行情入库。
          </EmptyState>
        </CockpitShell>
      </>
    )
  }

  const lastBar = detail.bars[detail.bars.length - 1]
  const closes = detail.bars.map((bar) => bar.close)
  const hasBars = closes.length > 0
  const low = hasBars ? Math.min(...closes) : null
  const high = hasBars ? Math.max(...closes) : null
  const recent = detail.bars.slice(-10).reverse()
  const source = detail.evidence.find((item) => item.source)?.source

  return (
    <>
      <Head>
        <title>{detail.name} · 收盘手记</title>
        <meta name="description" content={`${detail.name} ${detail.code} 个股证据与研究论点`} />
      </Head>
      <CockpitShell
        title={detail.name}
        eyebrow={`${detail.code} · ${detail.exchange}`}
        subtitle={`${detail.industry} · ${lastBar ? `行情截至 ${formatDateCn(lastBar.date)}` : '暂无行情日期'}${source ? ` · 来源 ${source.name}` : ''}`}
        asOf={detail.asOf}
        isDemo={detail.isDemo}
        sourceHealth={sourceHealth}
      >
        <article className="ck-card ck-stock-hero" aria-labelledby="stock-quote-title">
          {/* 页头已经是大号名称，卡片不再重复；保留读屏标题维持文章语义。 */}
          <h2 className="ck-sr-only" id="stock-quote-title">{detail.name}最新行情</h2>
          <div className="ck-stock-head">
            <div className="ck-stock-id">
              <span className="ck-stock-code">{detail.code}</span>
              <div className="ck-stock-meta">
                <span>{detail.exchange}</span>
                <span className="ck-sep">·</span>
                <span>{detail.industry}</span>
                {lastBar && (
                  <>
                    <span className="ck-sep">·</span>
                    <span>最近交易日 {lastBar.date}</span>
                  </>
                )}
              </div>
            </div>
            <div className="ck-stock-price">
              <strong>{formatPrice(detail.price)}</strong>
              <span><DeltaValue value={detail.changePct} /></span>
            </div>
          </div>
          <div className="ck-stock-chart">
            {hasBars ? (
              <>
                <Sparkline
                  values={closes}
                  label={`${detail.name}近 ${closes.length} 个交易日收盘价，区间 ${formatPrice(low)} 至 ${formatPrice(high)}`}
                  strokeWidth={1.8}
                />
                <div className="ck-chart-caption">
                  <span>近 {closes.length} 个交易日 · 收盘价</span>
                  <span>区间 {formatPrice(low)} — {formatPrice(high)}</span>
                </div>
                {recent.length > 1 && (
                  <details className="ck-price-table">
                    <summary>查看价格表（图表的数据视图）</summary>
                    <table>
                      <thead>
                        <tr><th>交易日</th><th>收盘价</th></tr>
                      </thead>
                      <tbody>
                        {recent.map((bar) => (
                          <tr key={bar.date}>
                            <td>{bar.date}</td>
                            <td>{formatPrice(bar.close)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </>
            ) : (
              <p className="ck-empty-text">已登记该标的，但还没有行情记录；价格、涨跌和走势图暂不展示。</p>
            )}
          </div>
        </article>

        <section className="ck-section" aria-labelledby="stock-evidence-title">
          <SectionHeader
            id="stock-evidence-title"
            title="证据链"
            detail="个股页只复述已入库事实与当前论点，不给出买卖动作。"
            action={<Link href="/research">研究页 →</Link>}
          />
          {detail.evidence.length > 0 ? (
            <div className="ck-card">
              <EvidenceSpine items={detail.evidence} />
            </div>
          ) : (
            <EmptyState title="还没有证据">完成行情与文档入库后，这里会按事实、推断、结论排列。</EmptyState>
          )}
        </section>

        <section className="ck-section" aria-labelledby="stock-thesis-title">
          <SectionHeader
            id="stock-thesis-title"
            title="当前论点"
            detail="没有失效条件的观点，不能算研究论点。"
          />
          {detail.thesis ? (
            <ThesisCard thesis={detail.thesis} />
          ) : (
            <EmptyState
              title="尚未建立可推翻的论点"
              actions={<Link className="ck-button" href="/research">去研究页</Link>}
            >
              先写下判断、支持证据与至少一条失效条件，再让价格变化参与复核。
            </EmptyState>
          )}
        </section>

        <section className="ck-section" aria-labelledby="stock-docs-title">
          <SectionHeader
            id="stock-docs-title"
            title="相关公告"
            detail="按发布时间倒序；原文链接优先于转述。"
          />
          <DocumentList
            documents={detail.documents}
            emptyText="当前没有与该标的关联的已入库公告。"
          />
        </section>

        <p className="ck-inline-meta" style={{ marginTop: 18 }}>
          数据更新于 {formatTime(detail.asOf)}
          {source && <> · <span>{source.name}</span></>}
        </p>
      </CockpitShell>
    </>
  )
}
