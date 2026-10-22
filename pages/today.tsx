import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, TodayPayload } from '@/lib/cockpit/types'
import { formatDateCn, formatTime } from '@/lib/cockpit/format'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getSourceHealth, getTodayPayload } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { EvidenceSpine } from '@/components/cockpit/evidence-spine'
import { MarketPulse } from '@/components/cockpit/market-pulse'
import { DocumentList } from '@/components/cockpit/document-list'
import {
  ConfidencePill,
  DataQualityPanel,
  EmptyState,
  SectionHeader,
  SourceChip,
  ThesisTag,
} from '@/components/cockpit/bits'

interface TodayProps {
  payload: TodayPayload | null
  sourceHealth: SourceHealth[]
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<TodayProps> = async () => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [payload, sourceHealth] = await Promise.all([getTodayPayload(), getSourceHealth()])
    return { props: serializable({ payload, sourceHealth }) }
  } catch (err) {
    console.error('[today]', err instanceof Error ? err.message : err)
    return {
      props: {
        payload: null,
        sourceHealth: [],
        loadError: '数据暂时不可用。请稍后刷新，或到任务中心重新生成收盘简报。',
      },
    }
  }
}

export default function TodayPage({ payload, sourceHealth, loadError }: TodayProps) {
  if (!payload) {
    return (
      <>
        <Head>
          <title>今日收盘 · 收盘手记</title>
          <meta name="description" content="个人收盘研究简报" />
        </Head>
        <CockpitShell
          title="今日收盘"
          eyebrow="AFTERCLOSE · POST-CLOSE"
          subtitle="收盘后的第一个问题不是涨还是跌，而是今天的事实是否足以改变原来的判断。"
          sourceHealth={sourceHealth}
        >
          {loadError && <div className="ck-error-banner">{loadError}</div>}
          <EmptyState
            title="今天还没有收盘简报"
            actions={(
              <>
                <Link className="ck-button ck-button-primary" href="/tasks">派发收盘简报</Link>
                <Link className="ck-button" href="/watchlist">先看自选</Link>
              </>
            )}
          >
            简报由收盘行情、政策与公告共同生成。数据源未就绪时会明确降级，不会拿旧数据冒充今天。
          </EmptyState>
        </CockpitShell>
      </>
    )
  }

  const { hero, indices, breadth, turnover, impacts, documents, tomorrow, dataQuality } = payload
  const confidenceInputs = [
    ['数据完整度', hero.confidence.inputs.completeness],
    ['时效性', hero.confidence.inputs.freshness],
    ['指标一致性', hero.confidence.inputs.agreement],
    ['来源质量', hero.confidence.inputs.sourceQuality],
  ] as const

  const railExtra = (
    <>
      <section className="ck-rail-card">
        <h2 className="ck-rail-title">本期</h2>
        <p className="ck-rail-quote">第 {payload.issueNo} 期</p>
        <p className="ck-rail-quote-sub">
          {formatDateCn(payload.tradeDate)}
          <br />
          生成于 {formatTime(payload.generatedAt)}
        </p>
      </section>
      <section className="ck-rail-card">
        <h2 className="ck-rail-title">置信度构成</h2>
        <div className="ck-exposure-list" style={{ marginTop: 8 }}>
          {confidenceInputs.map(([label, value]) => {
            const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
            return (
              <div className="ck-exposure-row" key={label}>
                <div className="ck-exposure-head">
                  <span className="ck-exposure-name">{label}</span>
                  <span className="ck-exposure-value">{pct}%</span>
                </div>
                <div className="ck-exposure-track">
                  <div className="ck-exposure-fill" style={{ width: `${pct}%` }} />
                </div>
              </div>
            )
          })}
        </div>
        <p className="ck-rail-note">四项由服务端按固定规则计算；缺数据、过期或来源冲突会压低分数，不由模型自评。</p>
      </section>
    </>
  )

  return (
    <>
      <Head>
        <title>今日收盘 · 收盘手记</title>
        <meta name="description" content={`${payload.tradeDate} 收盘简报，个人研究用途，不构成投资建议`} />
      </Head>
      <CockpitShell
        title="今日收盘"
        eyebrow={formatDateCn(payload.tradeDate)}
        subtitle={`第 ${payload.issueNo} 期 · 收盘后简报 · 生成于 ${formatTime(payload.generatedAt)}`}
        asOf={payload.generatedAt}
        isDemo={payload.isDemo}
        sourceHealth={sourceHealth}
        railExtra={railExtra}
      >
        <article className="ck-card ck-hero-card" aria-labelledby="brief-claim">
          <div className="ck-hero-top">
            <span className="ck-hero-kicker">收盘判断 · POST-CLOSE</span>
            <div className="ck-hero-meta">
              <ConfidencePill confidence={hero.confidence} />
            </div>
          </div>
          <h2 className="ck-hero-claim" id="brief-claim">{hero.claim}</h2>
          <EvidenceSpine items={hero.evidence} />
          <div className="ck-hero-foot">
            <span className="ck-hero-confidence-note">
              先列事实，再给推断；反证与结论同等重要。
            </span>
            <div className="ck-hero-actions">
              <Link className="ck-button ck-button-small" href="/research">核对论点</Link>
              <Link className="ck-button ck-button-primary ck-button-small" href="/tasks">派发任务</Link>
            </div>
          </div>
        </article>

        <MarketPulse indices={indices} breadth={breadth} turnover={turnover} />

        <section className="ck-section" aria-labelledby="impact-title">
          <SectionHeader
            id="impact-title"
            title="对你的影响"
            detail="只统计已录入的持仓与自选；描述影响，不生成买卖动作。"
            action={<Link href="/portfolio">持仓详情 →</Link>}
          />
          {impacts.length === 0 ? (
            <EmptyState title="今天没有触及你的标的">
              指数与广度已经记录，但当前持仓和自选没有出现需要单独说明的变化。
            </EmptyState>
          ) : (
            <div className="ck-card ck-impact-list">
              {impacts.map((impact) => {
                const sourceEvidence = impact.evidence.find((item) => item.source)
                return (
                  <article className="ck-impact" key={impact.code}>
                    <div className="ck-impact-code">
                      <span>{impact.code}</span>
                      <span className="ck-impact-name">{impact.name}</span>
                    </div>
                    <div className="ck-impact-main">
                      <p className="ck-impact-headline">{impact.headline}</p>
                      <p className="ck-impact-detail">{impact.detail}</p>
                      <div className="ck-impact-meta">
                        {impact.thesisStatus && <ThesisTag status={impact.thesisStatus} />}
                        {sourceEvidence?.source && <SourceChip source={sourceEvidence.source} />}
                        <Link className="ck-link" href={`/stock/${encodeURIComponent(impact.code)}`}>
                          查看证据
                        </Link>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </section>

        <section className="ck-section" aria-labelledby="documents-title">
          <SectionHeader
            id="documents-title"
            title="政策与公告"
            detail="只列已入库、可回溯到原始来源的文档；聚合线索不进入结论。"
          />
          <DocumentList documents={documents} />
        </section>

        <section className="ck-section" aria-labelledby="tomorrow-title">
          <SectionHeader
            id="tomorrow-title"
            title="明日验证"
            detail="不是预测清单，而是明天开盘后需要逐项确认的条件。"
          />
          {tomorrow.length > 0 ? (
            <div className="ck-card ck-focus-list">
              <ol>
                {tomorrow.map((item, index) => (
                  <li className="ck-focus-item" key={item}>
                    <span className="ck-focus-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="ck-focus-text">{item}</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : (
            <EmptyState title="没有新的验证项">当前判断暂时不需要额外条件来确认或推翻。</EmptyState>
          )}
        </section>

        <section className="ck-section ck-mobile-only" aria-labelledby="quality-title">
          <SectionHeader
            id="quality-title"
            title="数据质量"
            detail="来源状态直接决定简报能否升级为结论。"
          />
          <DataQualityPanel items={dataQuality} />
        </section>
      </CockpitShell>
    </>
  )
}
