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
import { MarketPulse, MarketSnapshot } from '@/components/cockpit/market-pulse'
import { DocumentList } from '@/components/cockpit/document-list'
import {
  ConfidencePill,
  DataQualityPanel,
  Disclosure,
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
          eyebrow="收盘简报"
          subtitle="收盘后先看今天的事实，再决定原来的判断是否需要改变。"
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
  const qualityIssues = dataQuality.filter(
    (item) => item.status === 'error' || item.status === 'stale',
  ).length
  const qualityHint = qualityIssues > 0
    ? `${qualityIssues} 项需注意`
    : `${dataQuality.length} 个来源`

  return (
    <>
      <Head>
        <title>今日收盘 · 收盘手记</title>
        <meta name="description" content={`${payload.tradeDate} 收盘简报，个人研究用途，不构成投资建议`} />
      </Head>
      <CockpitShell
        title="今日收盘"
        eyebrow={formatDateCn(payload.tradeDate)}
        subtitle={`第 ${payload.issueNo} 期 · 生成于 ${formatTime(payload.generatedAt)}`}
        asOf={payload.generatedAt}
        isDemo={payload.isDemo}
        sourceHealth={sourceHealth}
      >
        <article className="ck-card ck-hero-card" aria-labelledby="brief-claim">
          <div className="ck-hero-top">
            <span className="ck-hero-kicker">收盘判断</span>
            <div className="ck-hero-meta">
              <ConfidencePill confidence={hero.confidence} />
            </div>
          </div>
          <h2 className="ck-hero-claim" id="brief-claim">{hero.claim}</h2>

          <MarketSnapshot indices={indices} breadth={breadth} turnover={turnover} />

          <EvidenceSpine items={hero.evidence} />

          {payload.narrative && (
            <Disclosure
              className="ck-hero-extra"
              title="模型叙述"
              hint={payload.narrative.model}
              headingLevel={3}
              summaryLabel={`模型叙述，不改写数字与来源，模型 ${payload.narrative.model}`}
            >
              <p className="ck-hero-narrative">{payload.narrative.text}</p>
            </Disclosure>
          )}

          <Disclosure
            className="ck-hero-extra"
            title="置信度构成"
            hint={`${Math.round(hero.confidence.score * 100)} / 100`}
            headingLevel={3}
          >
            <div className="ck-confidence-breakdown">
              {confidenceInputs.map(([label, value]) => {
                const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
                return (
                  <div className="ck-confidence-item" key={label}>
                    <div className="ck-confidence-item-head">
                      <span>{label}</span>
                      <b>{pct}%</b>
                    </div>
                    <div className="ck-confidence-item-track">
                      <div className="ck-confidence-item-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
            <p className="ck-confidence-note">四项由服务端按固定规则计算；缺数据、过期或来源冲突会压低分数，不由模型自评。</p>
          </Disclosure>

          <div className="ck-hero-foot">
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

        <section className="ck-section ck-mobile-only" aria-labelledby="data-quality-title">
          <Disclosure
            title="数据质量"
            hint={qualityHint}
            id="data-quality-title"
            headingLevel={2}
          >
            <DataQualityPanel items={dataQuality} />
          </Disclosure>
        </section>
      </CockpitShell>
    </>
  )
}
