import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import type { JournalEntry, SourceHealth, ThesisView } from '@/lib/cockpit/types'
import { todayShanghai } from '@/lib/cockpit/format'
import { normalizeCode } from '@/lib/cockpit/codes'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getJournal, getSourceHealth, getTheses } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { ThesisCard } from '@/components/cockpit/thesis-card'
import { ThesisActions, ThesisComposer } from '@/components/cockpit/thesis-editor'
import { JournalComposer } from '@/components/cockpit/journal-composer'
import { Badge } from '@/components/ui/badge'
import { Disclosure, EmptyState, SectionHeader, SectionLink } from '@/components/cockpit/bits'

const ACTION_LABEL: Record<string, string> = {
  watch: '继续观察',
  buy: '记录买入',
  sell: '记录卖出',
  hold: '继续持有',
  avoid: '选择回避',
  review: '复盘旧决定',
}

// 旧日志里可能存的是 600519 这类写法，展示时归一化，避免链到不存在的个股页。
function JournalCode({ code }: { code: string }) {
  const normalized = normalizeCode(code)
  if (!normalized) return <span className="ck-journal-code">{code}</span>
  return (
    <Link className="ck-journal-code" href={`/stock/${encodeURIComponent(normalized)}`}>
      {code}
    </Link>
  )
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
  // 空列表时表单已就地展开；这里决定是否再给入口，三处共用同一判定
  const showJournalForm = journal.length > 0
  const showThesisForm = theses.length > 0 && !editing
  return (
    <>
      <Head>
        <title>研究笔记 · 财经信号</title>
        <meta name="description" content="投资论点、失效条件与个人研究日志" />
      </Head>
      <CockpitShell
        title="研究笔记"
        eyebrow="论点与日志"
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
              headingLevel={2}
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
            action={<SectionLink href="/tasks">派发复核</SectionLink>}
          />
          {theses.length === 0 ? (
            <div className="space-y-3">
              <EmptyState title="还没有研究论点">
                研究笔记不会自动生成：行情与公告只提供事实，第一条论点需要你亲手写下。填好主张与至少一条失效条件即可开始。
              </EmptyState>
              <ThesisComposer />
            </div>
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
            <div className="space-y-3">
              <EmptyState title="还没有研究日志">
                研究日志只记录你写下的决定，系统不会代写。写下第一条决定，并保留当时看到的反证。
              </EmptyState>
              <JournalComposer today={today} theses={theses} />
            </div>
          ) : (
            <div className="ck-card ck-journal-list">
              {journal.map((entry) => (
                <article className="ck-journal-item" key={entry.id}>
                  <div className="ck-journal-head">
                    <span className="ck-journal-date">{entry.entryDate}</span>
                    <Badge variant="outline" className="ck-journal-tag">
                      {ACTION_LABEL[entry.action] || entry.action}
                    </Badge>
                    {entry.code && <JournalCode code={entry.code} />}
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

        {/* 空列表时表单已就地展开，这里不再重复放一份折叠入口。 */}
        {(showJournalForm || showThesisForm) && (
          <section className="ck-section" aria-label="记录与登记">
            {showJournalForm && (
              <Disclosure title="记录今天的决定" hint="保留当时的事实与反证" headingLevel={2}>
                <JournalComposer today={today} theses={theses} />
              </Disclosure>
            )}
            {showThesisForm && (
              <Disclosure
                title="登记研究论点"
                hint="主张、时限与失效条件缺一不可"
                headingLevel={2}
              >
                <ThesisComposer />
              </Disclosure>
            )}
          </section>
        )}
      </CockpitShell>
    </>
  )
}
