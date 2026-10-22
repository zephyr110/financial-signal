import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import type { SourceHealth, TaskRecord, TodayPayload } from '@/lib/cockpit/types'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { getSourceHealth, getTodayPayload } from '@/lib/cockpit/repo'
import { listTasks } from '@/lib/cockpit/tasks'
import { serializable } from '@/lib/cockpit/page-data'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { TaskCenter } from '@/components/cockpit/task-center'

interface TasksProps {
  tasks: TaskRecord[]
  latest: TodayPayload | null
  sourceHealth: SourceHealth[]
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<TasksProps> = async () => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [tasks, latest, sourceHealth] = await Promise.all([
      listTasks(50),
      getTodayPayload(),
      getSourceHealth(),
    ])
    return { props: serializable({ tasks, latest, sourceHealth }) }
  } catch (err) {
    console.error('[tasks]', err instanceof Error ? err.message : err)
    return {
      props: {
        tasks: [],
        latest: null,
        sourceHealth: [],
        loadError: '任务队列暂时不可用，请稍后刷新。',
      },
    }
  }
}

export default function TasksPage({ tasks, latest, sourceHealth, loadError }: TasksProps) {
  const isDemo = latest?.isDemo || sourceHealth.some((source) => source.status === 'demo')
  return (
    <>
      <Head>
        <title>任务 · 收盘手记</title>
        <meta name="description" content="收盘手记的后台任务队列" />
      </Head>
      <CockpitShell
        title="任务"
        eyebrow="TASK QUEUE · 串行队列"
        subtitle="简报、复核、提问与个股深挖串行执行，失败会重试一次，结果写入研究记录。"
        isDemo={isDemo}
        sourceHealth={sourceHealth}
      >
        {loadError && <div className="ck-error-banner">{loadError}</div>}
        <TaskCenter initialTasks={tasks} />
      </CockpitShell>
    </>
  )
}
