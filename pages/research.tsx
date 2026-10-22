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
import { ThesisActions, ThesisComposer } from '@/components/cockpit/thesis-editor'
import { JournalComposer } from '@/components/cockpit/journal-composer'
import { Disclosure, EmptyState, SectionHeader } from '@/components/cockpit/bits'

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
  editing?: ThesisView
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<ResearchProps> = async (context) => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [theses, journal, sourceHealth] = await Promise.all([
      getTheses(),
      getJournal(30),
      getSourceHealth(),
    ])
    const editId = typeof context.query.edit === 'string' ? context.query.edit : ''
    const editing = editId ? theses.find((thesis) => thesis.id === editId) : undefined
    return {
      props: serializable({
        theses,
        journal,
        sourceHealth,
        today: todayShanghai(),
        editing,
      }),
    }
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
  editing,
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
        subtitle="把观点写成可被推翻的句子。价格只负责检验，不负责说服。"
        isDemo={isDemo}
        sourceHealth={sourceHealth}
      >
        {loadError && <div className="ck-error-banner">{loadError}</div>}

        {editing && (
          <section className="ck-section" aria-label="修订论点">
            <Disclosure
              title={`修订：${editing.title}`}
              hint={editing.code}
              defaultOpen
            >
              <ThesisComposer initial={editing} key={editing.id} />
            </Disclosure>
          </section>
        )}

        <section aria-labelledby="theses-title">
          <SectionHeader
            id="theses-title"
            title={`${theses.length} 条研究论点`}
            detail="每条论点同时展示支持证据、反证与失效条件。"
            action={<Link href="/tasks">派发复核 →</Link>}
          />
          {theses.length === 0 ? (
            <EmptyState title="还没有研究论点">
              论点不是观点摘录，而是一个可被数据推翻的句子。展开下方“登记研究论点”，先写下主张和失效条件。
            </EmptyState>
          ) : (
            <div className="ck-thesis-grid">
              {theses.map((thesis) => (
                <ThesisCard
                  thesis={thesis}
                  key={thesis.id}
                  actions={<ThesisActions thesis={thesis} />}
                />
              ))}
            </div>
          )}
        </section>

        <section className="ck-section" aria-labelledby="journal-list-title">
          <SectionHeader
            id="journal-list-title"
            title="最近记录"
            detail={`${journal.length} 条 · 按录入时间倒序，只代表当时的判断。`}
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
                    {entry.code && (
                      <Link className="ck-journal-code" href={`/stock/${encodeURIComponent(entry.code)}`}>
                        {entry.code}
                      </Link>
                    )}
                  </div>
                  <p className="ck-journal-reason">{entry.reason}</p>
                  {entry.outcomeNote && (
                    <p className="ck-journal-outcome">复盘：{entry.outcomeNote}</p>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>

        <section className="ck-section" aria-label="记录与登记">
          <Disclosure title="记录今天的决定" hint="保留当时的事实与反证">
            <JournalComposer today={today} theses={theses} />
          </Disclosure>
          {!editing && (
            <Disclosure
              title="登记研究论点"
              hint="主张、时限与失效条件缺一不可"
            >
              <ThesisComposer />
            </Disclosure>
          )}
        </section>
      </CockpitShell>
    </>
  )
}
