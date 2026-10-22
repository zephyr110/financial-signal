import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { JournalEntry, SourceHealth, ThesisView } from '@/lib/cockpit/types'
import { todayShanghai } from '@/lib/cockpit/format'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getJournal, getSourceHealth, getTheses } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { ThesisCard } from '@/components/cockpit/thesis-card'
import { JournalComposer } from '@/components/cockpit/journal-composer'
import { EmptyState, SectionHeader } from '@/components/cockpit/bits'

const ACTION_LABEL: Record<string, string> = {
  watch: '继续观察',
  buy: '记录买入',
  sell: '记录卖出',
  hold: '继续持有',
  avoid: '选择回避',
  review: '复盘旧决定',
}

interface ResearchProps {
  theses: ThesisView[]
  journal: JournalEntry[]
  sourceHealth: SourceHealth[]
  today: string
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<ResearchProps> = async () => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [theses, journal, sourceHealth] = await Promise.all([
      getTheses(),
      getJournal(30),
      getSourceHealth(),
    ])
    return { props: serializable({ theses, journal, sourceHealth, today: todayShanghai() }) }
  } catch (err) {
    console.error('[research]', err instanceof Error ? err.message : err)
    return {
      props: {
        theses: [],
        journal: [],
        sourceHealth: [],
        today: todayShanghai(),
        loadError: '研究数据暂时不可用，请稍后刷新。',
      },
    }
  }
}

export default function ResearchPage({
  theses,
  journal,
  sourceHealth,
  today,
  loadError,
}: ResearchProps) {
  const isDemo = sourceHealth.some((source) => source.status === 'demo')
  return (
    <>
      <Head>
        <title>研究 · 收盘手记</title>
        <meta name="description" content="投资论点、失效条件与个人研究日志" />
      </Head>
      <CockpitShell
        title="研究"
        eyebrow="THESIS & JOURNAL · 论点与日志"
        subtitle="把观点写成可被推翻的句子，记录当时的事实与反证。价格只负责检验，不负责说服。"
        isDemo={isDemo}
        sourceHealth={sourceHealth}
      >
        {loadError && <div className="ck-error-banner">{loadError}</div>}

        <section aria-labelledby="theses-title">
          <SectionHeader
            id="theses-title"
            title={`${theses.length} 条研究论点`}
            detail="每条论点必须同时展示支持证据、反证与失效条件。"
            action={<Link href="/tasks">派发论点复核 →</Link>}
          />
          {theses.length === 0 ? (
            <EmptyState title="还没有研究论点">
              论点不是观点摘录，而是一个可被数据推翻的句子。先建立论点，再让它接受每日简报的检验。
            </EmptyState>
          ) : (
            <div className="ck-thesis-grid">
              {theses.map((thesis) => (
                <ThesisCard thesis={thesis} key={thesis.id} />
              ))}
            </div>
          )}
        </section>

        <section className="ck-section" aria-labelledby="journal-compose-title">
          <SectionHeader
            id="journal-compose-title"
            title="研究日志"
            detail="记录决定、理由和当时的证据；之后回看，而不是事后改写。"
          />
          <JournalComposer today={today} theses={theses} />
        </section>

        <section className="ck-section" aria-labelledby="journal-list-title">
          <SectionHeader
            id="journal-list-title"
            title="最近记录"
            detail="按录入时间倒序；日志只代表当时的判断。"
          />
          {journal.length === 0 ? (
            <EmptyState title="还没有研究日志">
              写下第一条决定，并保留当时看到的反证。之后的复盘从这里开始。
            </EmptyState>
          ) : (
            <div className="ck-card ck-journal-list">
              {journal.map((entry) => (
                <article className="ck-journal-item" key={entry.id}>
                  <div className="ck-journal-head">
                    <span className="ck-journal-date">{entry.entryDate}</span>
                    <span className="ck-tag">{ACTION_LABEL[entry.action] || entry.action}</span>
                    {entry.code && <span>{entry.code}</span>}
                  </div>
                  <p className="ck-journal-reason">{entry.reason}</p>
                  {entry.outcomeNote && (
                    <p className="ck-form-hint">复盘：{entry.outcomeNote}</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </CockpitShell>
    </>
  )
}
