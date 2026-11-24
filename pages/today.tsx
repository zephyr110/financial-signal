import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, TodayPayload } from '@/lib/cockpit/types'
import { formatDateCn, formatTime, todayShanghai } from '@/lib/cockpit/format'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { isChinaMarketOpen } from '@/lib/china-calendar'
import { getLatestMarketDate, getSourceHealth, getTodayPayload } from '@/lib/cockpit/repo'
import { todayBriefState, type TodayBriefState } from '@/lib/cockpit/today-state'
import { serializable } from '@/lib/cockpit/page-data'
import { stripToolProtocolFromAnswer } from '@/lib/agent/format'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { EvidenceSpine } from '@/components/cockpit/evidence-spine'
import { MarketPulse, MarketSnapshot } from '@/components/cockpit/market-pulse'
import { DocumentList } from '@/components/cockpit/document-list'
import { TodayTabs } from '@/components/TodayTabs'
import { buttonVariants } from '@/components/ui/button'
import {
  ConfidencePill,
  Disclosure,
  EmptyState,
  SectionHeader,
  SectionLink,
  SourceChip,
  ThesisTag,
} from '@/components/cockpit/bits'

interface TodayProps {
  payload: TodayPayload | null
  sourceHealth: SourceHealth[]
  briefState: TodayBriefState
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<TodayProps> = async () => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [payload, sourceHealth, latestMarketDate] = await Promise.all([
      getTodayPayload(),
      getSourceHealth(),
      getLatestMarketDate(),
    ])
    const today = todayShanghai()
    const marketOpen = payload && payload.tradeDate !== today
      ? await isChinaMarketOpen(today, { allowNetwork: false }).catch(() => null)
      : null
    const briefState = payload
      ? todayBriefState({ reportDate: payload.tradeDate, today, latestMarketDate, marketOpen })
      : 'current'
    return { props: serializable({ payload, sourceHealth, briefState }) }
  } catch (err) {
    console.error('[today]', err instanceof Error ? err.message : err)
    return {
      props: {
        payload: null,
        sourceHealth: [],
        briefState: 'current',
        loadError: '数据暂时不可用。请稍后刷新，或到任务中心重新生成收盘简报。',
      },
    }
  }
}

export default function TodayPage({ payload, sourceHealth, briefState, loadError }: TodayProps) {
  if (!payload) {
    return (
      <>
        <Head>
          <title>今日 · 财经信号</title>
          <meta name="description" content="个人收盘研究简报" />
        </Head>
        <CockpitShell
          title="今日"
          eyebrow="收盘简报"
          subtitle="收盘后先看事实，再判断原观点是否需要修正。"
          headerAction={<TodayTabs />}
          sourceHealth={sourceHealth}
        >
          {loadError && <div className="ck-error-banner">{loadError}</div>}
          <EmptyState
            title="今天还没有收盘简报"
            actions={(
              <>
                <Link className={buttonVariants({ size: 'sm' })} href="/tasks">生成今日简报</Link>
                <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href="/watchlist">先看自选</Link>
              </>
            )}
          >
            简报由收盘行情、政策与公告共同生成。数据源未就绪时会标注降级原因，不会用旧数据充当今日简报。
          </EmptyState>
        </CockpitShell>
      </>
    )
  }

  const { hero, indices, breadth, turnover, impacts, documents, tomorrow, dataQuality } = payload
  const reportDateCn = formatDateCn(payload.tradeDate)
  let notice: { title: string; detail: string; action: boolean } | null = null
  if (briefState === 'closed') {
    notice = { title: '今天休市', detail: `下方为最近交易日 ${reportDateCn} 的简报。`, action: false }
  } else if (briefState === 'pending-generate') {
    notice = {
      title: '今日简报尚未生成',
      detail: `今日行情已入库；生成后这里会换成今日简报。下方仍是 ${reportDateCn} 的简报。`,
      action: true,
    }
  } else if (briefState === 'pending-close') {
    notice = {
      title: '今日简报尚未生成',
      detail: `今日收盘行情尚未入库，约 16:15 完成后可生成。下方仍是 ${reportDateCn} 的简报。`,
      action: false,
    }
  } else if (briefState === 'unknown') {
    notice = { title: '今日简报尚未生成', detail: `下方为最近一期 ${reportDateCn} 的简报。`, action: true }
  }
  const confidenceInputs = [
    ['数据完整度', hero.confidence.inputs.completeness],
    ['时效性', hero.confidence.inputs.freshness],
    ['指标一致性', hero.confidence.inputs.agreement],
    ['来源质量', hero.confidence.inputs.sourceQuality],
  ] as const
  return (
    <>
      <Head>
        <title>今日 · 财经信号</title>
        <meta name="description" content={`${payload.tradeDate} 收盘简报，个人研究用途，不构成投资建议`} />
      </Head>
      <CockpitShell
        title="今日"
        eyebrow={formatDateCn(payload.tradeDate)}
        subtitle={`第 ${payload.issueNo} 期 · 生成于 ${formatTime(payload.generatedAt)}`}
        asOf={payload.generatedAt}
        isDemo={payload.isDemo}
        headerAction={<TodayTabs />}
        sourceHealth={sourceHealth}
        dataQuality={dataQuality}
      >
        {notice && (
          <aside
            className={`ck-brief-notice${briefState === 'closed' ? ' is-closed' : ''}`}
            aria-label="简报时效提示"
          >
            <div className="ck-brief-notice-main">
              <strong>{notice.title}</strong>
              <span>{notice.detail}</span>
            </div>
            {notice.action && (
              <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href="/tasks">
                去任务中心
              </Link>
            )}
          </aside>
        )}
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
              title="AI 叙述"
              headingLevel={3}
              summaryLabel="AI 叙述，不改写数字与来源"
            >
              <p className="ck-hero-narrative">{stripToolProtocolFromAnswer(payload.narrative.text)}</p>
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
            <p className="ck-confidence-note">四项由服务端按固定规则计算；缺数据、过期或来源冲突会压低分数，不由生成内容自评。</p>
          </Disclosure>

          <MarketPulse indices={indices} breadth={breadth} turnover={turnover} embedded />

          <div className="ck-hero-foot">
            <div className="ck-hero-actions">
              <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href="/research">核对论点</Link>
              <Link className={buttonVariants({ size: 'sm' })} href="/tasks">派发任务</Link>
            </div>
          </div>
        </article>

        <section className="ck-section" aria-labelledby="impact-title">
          <SectionHeader
            id="impact-title"
            title="对你的影响"
            detail="仅统计已录入的持仓与自选，描述影响，不给出买卖建议。"
            action={<SectionLink href="/portfolio">持仓详情</SectionLink>}
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
            action={<SectionLink href="/">看新闻线索</SectionLink>}
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

      </CockpitShell>
    </>
  )
}
