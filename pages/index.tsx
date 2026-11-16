import { useCallback, useEffect, useRef, useState } from 'react'
import Head from 'next/head'
import type { GetServerSidePropsContext } from 'next'
import { AlertTriangle, LayoutGrid, RefreshCw } from 'lucide-react'
import AppShell from '@/components/app-shell'
import { TopbarRefreshButton } from '@/components/app-topbar'
import WelcomeScreen from '@/components/WelcomeScreen'
import { CopilotDock } from '@/components/cockpit/copilot-dock'
import { InspectorDrawer } from '@/components/cockpit/inspector-drawer'
import {
  BriefPanel,
  PortfolioPanel,
  PulsePanel,
  TasksPanel,
  WatchlistPanel,
} from '@/components/cockpit/home-panels'
import { CockpitSelectionProvider, useCockpitSelection } from '@/components/cockpit/selection-context'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useDesktopWelcome } from '@/hooks/use-desktop-welcome'
import {
  COCKPIT_PANELS,
  COCKPIT_PANEL_KEYS,
  isPanelKey,
  loadPanelKeys,
  savePanelKeys,
  togglePanelKey,
  type CockpitPanelKey,
} from '@/lib/cockpit-panels'
import { formatTime } from '@/lib/cockpit/format'
import type { DashboardPayload } from '@/lib/dashboard/aggregate'
import { track } from '@/lib/track'

const POLL_INTERVAL_MS = 60_000

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * 驾驶舱首页：市场怎样 / 持仓怎样 / 今天要处理什么。
 * 数据统一走 /api/dashboard（区块级失败隔离）；桌面首次启动必须先完成 welcome
 * 判定再发请求，否则服务端会先建空库，导入引导永远不出现。
 */
export default function CockpitPage() {
  const { showWelcome, checked: welcomeChecked, importing, importError, handleImport, handleSkip } = useDesktopWelcome()
  const [payload, setPayload] = useState<DashboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [visibleKeys, setVisibleKeys] = useState<CockpitPanelKey[]>([...COCKPIT_PANEL_KEYS])
  const inFlightRef = useRef<AbortController | null>(null)
  const viewTrackedRef = useRef(false)

  useEffect(() => {
    setVisibleKeys(loadPanelKeys(safeStorage()))
  }, [])

  const refresh = useCallback(async (mode: 'initial' | 'manual' | 'poll') => {
    if (inFlightRef.current) return
    const controller = new AbortController()
    inFlightRef.current = controller
    if (mode === 'initial') setLoading(true)
    if (mode === 'manual') setRefreshing(true)
    if (mode !== 'poll') setError('')

    try {
      const res = await fetch('/api/dashboard', {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error?.message || `数据刷新失败（HTTP ${res.status}）`)
      if (!body?.data?.sections) throw new Error('返回的数据格式不正确')
      setPayload(body.data as DashboardPayload)
      setLastUpdated(new Date())
      setError('')
      if (!viewTrackedRef.current) {
        viewTrackedRef.current = true
        track('cockpit_view')
      }
    } catch (err) {
      if (controller.signal.aborted) return
      setError(err instanceof Error ? err.message : '数据刷新失败，请稍后重试')
    } finally {
      if (inFlightRef.current === controller) inFlightRef.current = null
      if (!controller.signal.aborted) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!welcomeChecked || showWelcome) return
    void refresh('initial')
    return () => {
      inFlightRef.current?.abort()
      inFlightRef.current = null
    }
  }, [welcomeChecked, showWelcome, refresh])

  // 60s 轻量轮询；页面不可见时跳过，回到前台由下一次轮询补齐。
  useEffect(() => {
    if (!welcomeChecked || showWelcome) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh('poll')
    }, POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [welcomeChecked, showWelcome, refresh])

  const manualRefresh = useCallback(() => { void refresh('manual') }, [refresh])
  const retry = useCallback(() => { void refresh('manual') }, [refresh])

  const togglePanel = useCallback((key: CockpitPanelKey) => {
    track('cockpit_panel_toggle', { key })
    setVisibleKeys((current) => {
      const next = togglePanelKey(current, key)
      savePanelKeys(safeStorage(), next)
      return next
    })
  }, [])

  // 命令面板只发事件，页面自己决定能做什么；换页后自然失效。
  useEffect(() => {
    const onTogglePanel = (event: Event) => {
      const key = (event as CustomEvent<{ key?: unknown }>).detail?.key
      if (isPanelKey(key)) togglePanel(key)
    }
    const onRefresh = () => manualRefresh()
    window.addEventListener('app:toggle-panel', onTogglePanel)
    window.addEventListener('app:refresh-data', onRefresh)
    return () => {
      window.removeEventListener('app:toggle-panel', onTogglePanel)
      window.removeEventListener('app:refresh-data', onRefresh)
    }
  }, [manualRefresh, togglePanel])

  if (showWelcome) {
    return <WelcomeScreen onImport={handleImport} onSkip={handleSkip} importing={importing} error={importError} />
  }

  const sections = payload?.sections

  return (
    <>
      <Head>
        <title>驾驶舱 · 财经信号</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="description" content="个人 A 股投研驾驶舱：市场、持仓、任务与证据" />
      </Head>

      <AppShell
        title="驾驶舱"
        actions={<TopbarRefreshButton onClick={manualRefresh} refreshing={refreshing} />}
      >
        <CockpitSelectionProvider>
          <div className="flex min-h-full flex-col xl:h-full">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pt-3 md:px-4">
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">驾驶舱</h1>
                <p className="text-[11px] text-muted-foreground">市场怎样 · 持仓怎样 · 今天要处理什么</p>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] tabular-nums text-muted-foreground" aria-live="polite">
                  {lastUpdated ? `更新于 ${formatTime(lastUpdated.toISOString())}` : '加载中…'}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2 text-xs">
                        <LayoutGrid className="size-3.5" aria-hidden="true" />
                        面板
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuLabel className="px-1.5" inset={false}>显示面板</DropdownMenuLabel>
                    <DropdownMenuSeparator className="my-1" />
                    {COCKPIT_PANELS.map((panel) => {
                      const shown = visibleKeys.includes(panel.key)
                      return (
                        <DropdownMenuCheckboxItem
                          key={panel.key}
                          className="text-xs"
                          inset={false}
                          checked={shown}
                          closeOnClick={false}
                          disabled={shown && visibleKeys.length === 1}
                          onCheckedChange={() => togglePanel(panel.key)}
                        >
                          {panel.label}
                        </DropdownMenuCheckboxItem>
                      )
                    })}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="mx-3 mt-2 flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive md:mx-4"
              >
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">{error}{payload ? ' · 当前显示上次数据' : ''}</span>
                <button
                  type="button"
                  onClick={retry}
                  className="flex shrink-0 items-center gap-1 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <RefreshCw className="size-3" aria-hidden="true" />重试
                </button>
              </div>
            )}

            <SelectionChip />

            <div className="grid min-h-0 grid-cols-1 gap-3 p-3 md:grid-cols-2 md:p-4 xl:flex-1 xl:grid-cols-4 xl:grid-rows-2">
              {visibleKeys.includes('brief') && (
                <BriefPanel
                  section={sections?.brief}
                  loading={loading}
                  refreshing={refreshing}
                  onRetry={retry}
                  onRefresh={manualRefresh}
                />
              )}
              {visibleKeys.includes('pulse') && (
                <PulsePanel
                  section={sections?.pulse}
                  loading={loading}
                  refreshing={refreshing}
                  onRetry={retry}
                  onRefresh={manualRefresh}
                />
              )}
              {visibleKeys.includes('watchlist') && (
                <WatchlistPanel
                  section={sections?.watchlist}
                  loading={loading}
                  refreshing={refreshing}
                  onRetry={retry}
                  onRefresh={manualRefresh}
                />
              )}
              {visibleKeys.includes('portfolio') && (
                <PortfolioPanel
                  section={sections?.portfolio}
                  loading={loading}
                  refreshing={refreshing}
                  onRetry={retry}
                  onRefresh={manualRefresh}
                />
              )}
              {visibleKeys.includes('tasks') && (
                <TasksPanel
                  section={sections?.tasks}
                  loading={loading}
                  refreshing={refreshing}
                  onRetry={retry}
                  onRefresh={manualRefresh}
                />
              )}
            </div>
          </div>

          <InspectorDrawer />
          <CopilotDock />
        </CockpitSelectionProvider>
      </AppShell>
    </>
  )
}

function SelectionChip() {
  const { symbol, thread, clear } = useCockpitSelection()
  if (!symbol && !thread) return null
  return (
    <div className="mx-3 mt-2 flex items-center gap-2 md:mx-4" aria-live="polite">
      <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2 py-0.5 text-[11px]">
        <span className="text-muted-foreground">已选中</span>
        <span className="font-medium tabular-nums">{symbol || `线索 #${thread}`}</span>
      </span>
      <button
        type="button"
        onClick={clear}
        className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        清除
      </button>
    </div>
  )
}

/** `?layout=classic` 或环境变量回退到旧新闻首页，方便线上比对与回滚。 */
export async function getServerSideProps(context: GetServerSidePropsContext) {
  if (context.query.layout === 'classic' || process.env.COCKPIT_HOME_CLASSIC === '1') {
    return { redirect: { destination: '/news', permanent: false } }
  }
  return { props: {} }
}
