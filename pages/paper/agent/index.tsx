import Head from 'next/head'
import Link from 'next/link'
import type { GetServerSideProps } from 'next'
import { ArrowLeft } from 'lucide-react'
import type { SourceHealth } from '@/lib/cockpit/types'
import { getSourceHealth } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import {
  buildPaperAgentDashboard,
  type AgentDashboard,
} from '@/lib/paper/agent-stats'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { AgentDashboardView } from '@/components/paper/agent-dashboard'
import { buttonVariants } from '@/components/ui/button'

interface AgentPageProps {
  dashboard: AgentDashboard | null
  sourceHealth: SourceHealth[]
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<AgentPageProps> = async () => {
  let sourceHealth: SourceHealth[] = []
  try {
    sourceHealth = await getSourceHealth()
  } catch {
    // 来源状态只作页脚参考，失败不该挡住战绩本体。
  }
  try {
    const dashboard = await buildPaperAgentDashboard()
    return { props: serializable({ dashboard, sourceHealth }) }
  } catch (err) {
    console.error('[paper/agent]', err instanceof Error ? err.message : err)
    return {
      props: {
        dashboard: null,
        sourceHealth,
        loadError: '投资经理记录暂时不可用，请稍后刷新。',
      },
    }
  }
}

export default function PaperAgentPage({ dashboard, sourceHealth, loadError }: AgentPageProps) {
  return (
    <>
      <Head>
        <title>投资经理 · 财经信号</title>
        <meta name="description" content="模拟盘投资经理 agent：每日计划、决策依据、成交与事后正确率回溯" />
      </Head>
      <CockpitShell
        title="投资经理"
        eyebrow="模拟盘 · 决策审计"
        subtitle="每一个判断都留下当时的行情、证据、反证与证伪条件；事后按 T+1/5/20 对账，先看正确率，再看收益。"
        asOf={dashboard?.generatedAt}
        sourceHealth={sourceHealth}
        headerAction={
          <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} href="/paper">
            <ArrowLeft /> 返回模拟盘
          </Link>
        }
      >
        {loadError && <div className="ck-error-banner">{loadError}</div>}
        {!dashboard
          ? !loadError && <div className="ck-error-banner">投资经理记录为空，请稍后刷新。</div>
          : <AgentDashboardView dashboard={dashboard} />}
      </CockpitShell>
    </>
  )
}
