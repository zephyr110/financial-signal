import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import type { GetServerSideProps } from 'next'
import { CloudSun, Gauge, Loader2, Radar, RefreshCw, ShieldAlert, TrendingUp } from 'lucide-react'
import AppShell from '@/components/app-shell'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InvestigationSheet, type InvestigationTarget } from '@/components/desk/investigation-sheet'
import { JudgmentSheet } from '@/components/desk/judgment-sheet'
import { SideRail } from '@/components/desk/side-rail'
import { deskApi } from '@/components/desk/api'
import { AlertRow, ConfidenceBadge, DeskPanel, EmptyHint, JudgmentRow, StanceBadge, confidenceText, stanceText } from '@/components/desk/ui'
import { ensureCockpitDemoSeed } from '@/lib/cockpit/demo'
import { serializable } from '@/lib/cockpit/page-data'
import { getDeskSnapshot, getDeskStatus } from '@/lib/desk/repo'
import type { DeskSnapshot, DeskStatus, JudgmentView, OverseasQuoteView } from '@/lib/desk/types'

interface DeskPageProps {
  snapshot: DeskSnapshot
  status: DeskStatus
}

export const getServerSideProps: GetServerSideProps<DeskPageProps> = async () => {
  try {
    if (process.env.COCKPIT_DEMO === '1') await ensureCockpitDemoSeed()
    const [snapshot, status] = await Promise.all([getDeskSnapshot(), getDeskStatus()])
    return { props: serializable({ snapshot, status }) }
  } catch (err) {
    console.error('[desk]', err instanceof Error ? err.message : err)
    return { props: serializable({ snapshot: emptySnapshot(), status: emptyStatus() }) }
  }
}

function emptySnapshot(): DeskSnapshot {
  return {
    tradeDate: null,
    asOf: new Date().toISOString(),
    market: null,
    industries: [],
    alerts: [],
    overseas: [],
    dataQuality: [],
    isDemo: false,
    generatedAt: new Date().toISOString(),
  }
}

function emptyStatus(): DeskStatus {
  return {
    tradeDate: null,
    hasSnapshot: false,
    stale: true,
    staleSeconds: null,
    openAlerts: 0,
    judgments: 0,
    industries: 0,
    lastComputedAt: null,
    sourceHealth: [],
    isDemo: false,
  }
}

const OVERSEAS_NAME: Record<string, string> = {
  _SPX: '标普500',
  _NDX: '纳斯达克100',
  _DJI: '道琼斯',
}

function freshness(iso?: string | null) {
  if (!iso) return '尚未更新'
  const diff = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (diff < 60) return '刚刚更新'
  if (diff < 3600) return `${Math.round(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.round(diff / 3600)} 小时前`
  return `${Math.round(diff / 86400)} 天前`
}

function pct(value?: number | null) {
  if (value == null) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function changeClass(value?: number | null) {
  if (value == null || value === 0) return 'text-muted-foreground'
  return value > 0 ? 'text-chart-3' : 'text-chart-2'
}

function OverseasRow({ quote }: { quote: OverseasQuoteView }) {
  return (
    <div className="relative flex items-center justify-between gap-2 px-4 py-2 text-xs after:pointer-events-none after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/50 after:content-[''] last:after:hidden">
      <div className="min-w-0">
        <p className="truncate font-medium">{OVERSEAS_NAME[quote.symbol] || quote.symbol}</p>
        {/* 相对时间随渲染时刻变化，SSR 与 hydration 必然不同 */}
        <p className="text-[10px] text-muted-foreground" suppressHydrationWarning>
          {quote.delayMinutes ? `延迟 ${quote.delayMinutes} 分钟 · ` : ''}{freshness(quote.fetchedAt)}
        </p>
      </div>
      <div className="shrink-0 text-right tabular-nums">
        <p>{quote.price.toFixed(2)}</p>
        <p className={changeClass(quote.changePct)}>{pct(quote.changePct)}</p>
      </div>
    </div>
  )
}

export default function DeskPage({ snapshot: initialSnapshot, status: initialStatus }: DeskPageProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const [status, setStatus] = useState(initialStatus)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [busyAlert, setBusyAlert] = useState('')
  const [judgmentTarget, setJudgmentTarget] = useState<JudgmentView | null>(null)
  const [investigationTarget, setInvestigationTarget] = useState<InvestigationTarget | null>(null)
  const refreshTimer = useRef<number | null>(null)
  const refreshingRef = useRef(false)

  useEffect(() => () => {
    if (refreshTimer.current) window.clearInterval(refreshTimer.current)
  }, [])

  const reload = useCallback(async () => {
    const [nextSnapshot, nextStatus] = await Promise.all([
      deskApi<DeskSnapshot>('/api/desk/snapshot'),
      deskApi<DeskStatus>('/api/desk/status'),
    ])
    setSnapshot(nextSnapshot)
    setStatus(nextStatus)
  }, [])

  // 驾驶舱常驻：页面可见时每分钟静默对齐一次快照
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (refreshingRef.current || document.visibilityState !== 'visible') return
      void reload().catch(() => {})
    }, 60_000)
    return () => window.clearInterval(timer)
  }, [reload])

  const stopRefreshing = () => {
    if (refreshTimer.current) window.clearInterval(refreshTimer.current)
    refreshTimer.current = null
    refreshingRef.current = false
    setRefreshing(false)
  }

  const refresh = async () => {
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    setError('')
    try {
      const { task } = await deskApi<{ task: { id: string; status: string; error: string | null } }>('/api/desk/refresh', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (task.status === 'succeeded') {
        await reload()
        stopRefreshing()
        return
      }
      if (task.status === 'failed' || task.status === 'canceled') {
        await reload().catch(() => {})
        setError(task.error || '刷新任务未能完成，请重试。')
        stopRefreshing()
        return
      }
      const startedAt = Date.now()
      refreshTimer.current = window.setInterval(async () => {
        try {
          // 按任务 id 轮询，失败/取消能立刻反馈，也不依赖 lastComputedAt 是否变化。
          const next = await deskApi<{ status: string; error: string | null }>(`/api/cockpit/tasks?id=${encodeURIComponent(task.id)}`)
          if (next.status === 'succeeded') {
            stopRefreshing()
            await reload()
            return
          }
          if (next.status === 'failed' || next.status === 'canceled') {
            stopRefreshing()
            await reload().catch(() => {})
            setError(next.error || '刷新任务未能完成，请重试。')
            return
          }
          if (Date.now() - startedAt > 120_000) {
            stopRefreshing()
            setError('刷新用时较长，已停止等待；数据可能稍后到达，页面会自动对齐。')
          }
        } catch {
          // 轮询抖动忽略，下一轮继续
        }
      }, 2500)
    } catch (err) {
      setError((err as Error).message)
      stopRefreshing()
    }
  }

  const acknowledge = async (alertId: string) => {
    setBusyAlert(alertId)
    setError('')
    try {
      await deskApi('/api/desk/alerts', { method: 'POST', body: JSON.stringify({ id: alertId }) })
      setSnapshot((prev) => ({
        ...prev,
        alerts: prev.alerts.filter((alert) => alert.id !== alertId),
      }))
      setStatus((prev) => ({ ...prev, openAlerts: Math.max(0, prev.openAlerts - 1) }))
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusyAlert('')
    }
  }

  const unhealthy = snapshot.dataQuality.filter((source) => source.status !== 'ok' && source.status !== 'demo')
  const isDemo = snapshot.isDemo || status.isDemo
  const updatedAt = snapshot.market?.computedAt || snapshot.asOf

  return (
    <>
      <Head>
        <title>投研驾驶舱 · 财经信号</title>
        <meta name="description" content="市场判断、行业台账、风险预警与深挖结论，一屏完成盘前决策" />
      </Head>
      <AppShell
        title="投研驾驶舱"
        subtitle="市场判断、行业台账与风险预警"
        scrollable={false}
        actions={(
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground md:inline" suppressHydrationWarning>{freshness(updatedAt)}</span>
            <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh()}>
              {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              {refreshing ? '刷新中' : '刷新数据'}
            </Button>
          </div>
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-3 py-2 text-xs text-muted-foreground lg:px-4">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <Radar className="size-3.5" />
              交易日 {snapshot.tradeDate || status.tradeDate || '—'}
            </span>
            <span suppressHydrationWarning>数据更新 {freshness(updatedAt)}</span>
            {isDemo && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">示例数据</Badge>}
            {unhealthy.length > 0 && (
              <span className="flex items-center gap-1 text-chart-5">
                <ShieldAlert className="size-3.5" />{unhealthy.length} 个数据源异常
              </span>
            )}
            <span className="ml-auto hidden text-[11px] lg:inline">仅供个人研究参考，不构成投资建议</span>
          </div>

          {error && (
            <div className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">{error}</div>
          )}

          {!snapshot.tradeDate ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <Gauge className="size-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">还没有投研快照</p>
                <p className="mt-1 text-xs text-muted-foreground">点击刷新拉取行情与公告，生成当天的市场与行业判断。</p>
              </div>
              <Button size="sm" disabled={refreshing} onClick={() => void refresh()}>
                {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                生成今日快照
              </Button>
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-3 overflow-y-auto p-3 md:grid-cols-2 lg:p-4 xl:auto-rows-fr xl:grid-cols-4 xl:overflow-hidden">
              <DeskPanel
                icon={<Gauge />}
                title="市场脉搏"
                meta={snapshot.market ? `${stanceText(snapshot.market.stance)} · ${confidenceText(snapshot.market.confidence)}` : undefined}
                className="xl:h-full"
                contentClassName="flex flex-col"
              >
                {snapshot.market ? (
                  <div className="flex min-h-0 flex-col xl:flex-1">
                    <button
                      type="button"
                      onClick={() => setJudgmentTarget(snapshot.market)}
                      className="w-full px-4 py-3 text-left transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:outline-none"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <StanceBadge stance={snapshot.market.stance} />
                        <ConfidenceBadge confidence={snapshot.market.confidence} />
                        <span className="text-xs tabular-nums text-muted-foreground">评分 {snapshot.market.score.toFixed(1)}</span>
                      </div>
                      <p className="mt-2 text-[13px] font-semibold leading-5 tracking-tight">{snapshot.market.headline}</p>
                      <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{snapshot.market.summary}</p>
                      {snapshot.market.drivers.length > 0 && (
                        <ul className="mt-2 space-y-0.5">
                          {snapshot.market.drivers.slice(0, 2).map((driver) => (
                            <li key={driver} className="flex gap-1.5 text-[11px] leading-4 text-muted-foreground">
                              <TrendingUp className="mt-0.5 size-3 shrink-0 text-chart-3" />
                              <span className="line-clamp-1">{driver}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </button>
                    <div className="flex shrink-0 items-center justify-between bg-muted/30 px-4 py-1.5 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1"><CloudSun className="size-3.5" />外盘隔夜</span>
                      <span>15 分钟延迟</span>
                    </div>
                    <div className="xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
                      {snapshot.overseas.length
                        ? snapshot.overseas.map((quote) => <OverseasRow key={quote.symbol} quote={quote} />)
                        : <EmptyHint>暂无外盘行情</EmptyHint>}
                    </div>
                  </div>
                ) : <EmptyHint>今天还没有生成市场判断，点右上角刷新。</EmptyHint>}
              </DeskPanel>

              <DeskPanel
                icon={<TrendingUp />}
                title="行业判断"
                meta={`${snapshot.industries.length} 个行业`}
                className="xl:h-full"
              >
                {snapshot.industries.length
                  ? snapshot.industries.map((judgment) => (
                    <JudgmentRow key={judgment.id} judgment={judgment} onSelect={() => setJudgmentTarget(judgment)} />
                  ))
                  : <EmptyHint>没有行业判断。数据补齐后刷新即可生成。</EmptyHint>}
              </DeskPanel>

              <DeskPanel
                icon={<ShieldAlert />}
                title="风险预警"
                meta={`${status.openAlerts} 条未处理`}
                className="xl:h-full"
              >
                {snapshot.alerts.length
                  ? snapshot.alerts.map((alert) => (
                    <AlertRow
                      key={alert.id}
                      alert={alert}
                      busy={busyAlert === alert.id}
                      onDeepDive={() => setInvestigationTarget({ kind: 'alert', alert })}
                      onAcknowledge={() => void acknowledge(alert.id)}
                    />
                  ))
                  : <EmptyHint>没有未处理的预警。新的政策、公告或异动会出现在这里。</EmptyHint>}
              </DeskPanel>

              <SideRail />
            </div>
          )}
        </div>
      </AppShell>

      <JudgmentSheet
        judgment={judgmentTarget}
        onClose={() => setJudgmentTarget(null)}
        onDeepDive={(judgment) => {
          setJudgmentTarget(null)
          setInvestigationTarget({ kind: 'judgment', judgment })
        }}
      />
      <InvestigationSheet
        target={investigationTarget}
        onClose={() => setInvestigationTarget(null)}
      />
    </>
  )
}
