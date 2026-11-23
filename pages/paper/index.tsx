import { useCallback } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import type { GetServerSideProps } from 'next'
import type { SourceHealth } from '@/lib/cockpit/types'
import { getSourceHealth } from '@/lib/cockpit/repo'
import { serializable } from '@/lib/cockpit/page-data'
import { buildPaperSummary, type PaperSummary } from '@/lib/paper/summary'
import { CockpitShell } from '@/components/cockpit/cockpit-shell'
import { PaperSetup } from '@/components/paper/paper-setup'
import { PaperOverview } from '@/components/paper/paper-overview'

interface PaperPageProps {
  summary: PaperSummary | null
  sourceHealth: SourceHealth[]
  loadError?: string
}

export const getServerSideProps: GetServerSideProps<PaperPageProps> = async () => {
  let sourceHealth: SourceHealth[] = []
  try {
    sourceHealth = await getSourceHealth()
  } catch {
    // 来源状态只作页脚参考，失败不该挡住模拟盘本体。
  }
  try {
    const summary = await buildPaperSummary()
    return { props: serializable({ summary, sourceHealth }) }
  } catch (err) {
    console.error('[paper]', err instanceof Error ? err.message : err)
    return {
      props: {
        summary: null,
        sourceHealth,
        loadError: '模拟盘数据暂时不可用，请稍后刷新。',
      },
    }
  }
}

export default function PaperPage({ summary, sourceHealth, loadError }: PaperPageProps) {
  const router = useRouter()
  const refresh = useCallback(async () => {
    await router.replace(router.asPath)
  }, [router])

  return (
    <>
      <Head>
        <title>模拟盘 · 财经信号</title>
        <meta name="description" content="纸面实验：每日决策卡、委托、成交与净值对账" />
      </Head>
      <CockpitShell
        title="模拟盘"
        eyebrow="纸面实验"
        subtitle="虚拟资金按固定规则执行，用真实行情逐日对账。这里回答今天要不要动，不放预测和荐股。"
        asOf={summary?.generatedAt}
        sourceHealth={sourceHealth}
      >
        {loadError && <div className="ck-error-banner">{loadError}</div>}
        {!summary ? (
          !loadError && <div className="ck-error-banner">模拟盘数据为空，请稍后刷新。</div>
        ) : summary.setupRequired || !summary.experiment ? (
          <PaperSetup onChanged={refresh} />
        ) : (
          <PaperOverview summary={summary} onChanged={refresh} />
        )}
      </CockpitShell>
    </>
  )
}
