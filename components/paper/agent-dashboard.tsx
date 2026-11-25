import { useCallback, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import { ArrowLeft, Bot, RefreshCw, Sparkles } from 'lucide-react'
import { Disclosure, EmptyState, SectionHeader, Sparkline } from '@/components/cockpit/bits'
import { Button, buttonVariants } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { formatCny, formatShortDate, formatTime } from '@/lib/cockpit/format'
import type {
  AgentDashboard,
  AgentDecisionView,
  AgentHorizonAccuracy,
  AgentRunDetail,
} from '@/lib/paper/agent-stats'
import { cn } from '@/lib/utils'
import { formatBpPct, positiveTone } from './labels'

type Horizon = 1 | 5 | 20

const RUN_STATUS_LABEL: Record<string, string> = {
  planning: '生成中',
  planned: '已计划',
  partial: '部分执行',
  executed: '已执行',
  failed: '失败',
  skipped: '已跳过',
}

const DECISION_STATUS_LABEL: Record<string, string> = {
  planned: '待执行',
  noted: '仅判断',
  executed: '已委托',
  skipped: '未执行',
  rejected: '被拒绝',
}

const HORIZONS: Horizon[] = [1, 5, 20]

function pct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

function runTone(status: string): string {
  if (status === 'executed') return 'text-positive'
  if (status === 'failed') return 'text-destructive'
  if (status === 'partial' || status === 'planning') return 'text-chart-5'
  return 'text-muted-foreground'
}

function HeroStat({
  label,
  value,
  note,
  tone,
}: {
  label: string
  value: string
  note: string
  tone?: string
}) {
  return (
    <div className="bg-card p-3">
      <span className="block text-[11px] text-muted-foreground">{label}</span>
      <b className={cn('mt-0.5 block text-lg font-semibold tabular-nums', tone)}>{value}</b>
      <span className="block text-[10px] leading-4 text-muted-foreground">{note}</span>
    </div>
  )
}

function AccuracyTable({ stats, horizon }: { stats: AgentHorizonAccuracy; horizon: Horizon }) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div className="ck-card ck-card-pad">
        <h3 className="ck-section-title text-sm">按动作</h3>
        <p className="ck-section-detail">同一动作在不同方向下的命中率；样本少于 5 条时只作参考。</p>
        <div className="mt-2 grid gap-1.5">
          {stats.byAction.length === 0 && <p className="text-xs text-muted-foreground">还没有 T+{horizon} 结果。</p>}
          {stats.byAction.map((bucket) => (
            <div className="flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5 text-xs" key={bucket.key}>
              <span className="font-medium">{bucket.label}</span>
              <span className="text-muted-foreground">
                {bucket.evaluated} 条 · 方向 {pct(bucket.directionHitRate)} · alpha {pct(bucket.alphaHitRate)}
              </span>
              <span className={cn('tabular-nums', positiveTone(bucket.avgAlphaBp))}>
                {formatBpPct(bucket.avgAlphaBp)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="ck-card ck-card-pad">
        <h3 className="ck-section-title text-sm">置信度校准</h3>
        <p className="ck-section-detail">高置信决策是否真的更准；偏差会直接暴露模型过度自信。</p>
        <div className="mt-2 grid gap-2">
          {stats.byConviction.length === 0 && <p className="text-xs text-muted-foreground">还没有可校准的样本。</p>}
          {stats.byConviction.map((bucket) => (
            <div className="grid gap-1" key={bucket.key}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">{bucket.key}</span>
                <span className="text-muted-foreground">{bucket.evaluated} 条</span>
                <span className={cn('tabular-nums', positiveTone(bucket.avgAlphaBp))}>{formatBpPct(bucket.avgAlphaBp)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="presentation">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.max(0, Math.min(100, bucket.directionHitRate ?? 0))}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function OutcomeChips({ decision }: { decision: AgentDecisionView }) {
  if (!decision.outcomes.length) {
    return <span className="text-[11px] text-muted-foreground">结果待评估</span>
  }
  return (
    <span className="flex flex-wrap gap-1.5">
      {decision.outcomes.map((outcome) => (
        <Hint
          key={outcome.horizonDays}
          content={outcome.evaluateDate ? `评估日 ${outcome.evaluateDate}` : undefined}
        >
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] tabular-nums',
              outcome.alphaHit == null
                ? 'border-border bg-muted/60 text-muted-foreground'
                : outcome.alphaHit
                  ? 'border-positive/30 bg-positive/10 text-positive'
                  : 'border-destructive/30 bg-destructive/10 text-destructive',
            )}
          >
            T+{outcome.horizonDays}
            <b className="font-semibold">{formatBpPct(outcome.returnBp)}</b>
            <span className="opacity-75">α {formatBpPct(outcome.alphaBp)}</span>
          </span>
        </Hint>
      ))}
    </span>
  )
}

function DecisionRow({ decision }: { decision: AgentDecisionView }) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <b className="text-[13px] font-semibold">{decision.symbolName}</b>
            <span className="text-[11px] text-muted-foreground">{decision.symbolCode}</span>
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              {decision.actionLabel}
            </span>
            <span className="text-[11px] text-muted-foreground">置信 {decision.conviction}</span>
            <span className="text-[11px] text-muted-foreground">· {formatShortDate(decision.decidedForDate)}</span>
            {decision.status !== 'executed' && (
              <span className="text-[11px] text-chart-5">
                {DECISION_STATUS_LABEL[decision.status] ?? decision.status}
                {decision.statusReason ? `（${decision.statusReason}）` : ''}
              </span>
            )}
          </div>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{decision.thesis}</p>
        </div>
        <OutcomeChips decision={decision} />
      </div>
      <Disclosure title="证据与证伪" hint={`${decision.evidence.length} 条证据 · ${decision.counterEvidence.length} 条反证`} headingLevel={3}>
        <div className="grid gap-2 text-[12px] leading-5">
          {decision.plannedQty != null && (
            <p>
              计划 {decision.plannedQty} 股
              {decision.plannedPriceCents != null && ` @≤${(decision.plannedPriceCents / 100).toFixed(2)} 元`}
              {decision.stopPriceCents != null && ` · 止损 ${(decision.stopPriceCents / 100).toFixed(2)} 元`}
              {decision.orderStatus && ` · 委托 ${decision.orderStatus}`}
            </p>
          )}
          <p><b className="font-medium">证据</b></p>
          <ul className="list-disc pl-4">
            {decision.evidence.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
          <p><b className="font-medium">反证</b></p>
          <ul className="list-disc pl-4">
            {decision.counterEvidence.length
              ? decision.counterEvidence.map((item, index) => <li key={index}>{item}</li>)
              : <li>模型未给出反证</li>}
          </ul>
          <p><b className="font-medium">证伪条件</b>：{decision.invalidation || '未给出'}</p>
        </div>
      </Disclosure>
    </li>
  )
}

function RunDetailPanel({
  detail,
  loading,
  error,
}: {
  detail: AgentRunDetail | null
  loading: boolean
  error: string | null
}) {
  if (loading) return <div className="ck-card ck-card-pad text-xs text-muted-foreground">正在读取审计记录…</div>
  if (error) return <div className="ck-error-banner">{error}</div>
  if (!detail) return null
  return (
    <div className="ck-card ck-card-pad grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="ck-section-title text-sm">运行 {detail.run.id}</h3>
          <p className="ck-section-detail">
            数据日 {detail.run.barsDate} · 计划日 {detail.run.planTradeDate} · 模型 {detail.run.model ?? '—'} · 提示词 {detail.run.promptVersion}
          </p>
        </div>
        <span className={cn('text-xs font-medium', runTone(detail.run.status))}>
          {RUN_STATUS_LABEL[detail.run.status] ?? detail.run.status}
        </span>
      </div>
      {detail.run.errorMessage && <div className="ck-error-banner">{detail.run.errorCode}：{detail.run.errorMessage}</div>}
      {detail.run.marketView && (
        <div className="text-[12px] leading-5"><b className="font-medium">市场判断</b>：{detail.run.marketView}</div>
      )}
      {detail.run.review && (
        <div className="text-[12px] leading-5"><b className="font-medium">复盘</b>：{detail.run.review}</div>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold">决策</h4>
          <ul className="mt-1 divide-y rounded-md border">
            {detail.decisions.map((decision) => (
              <li className="px-2.5 py-2 text-[12px]" key={decision.id}>
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span>{decision.symbolName} · {decision.actionLabel} · 置信 {decision.conviction}</span>
                  <span className="text-muted-foreground">{DECISION_STATUS_LABEL[decision.status] ?? decision.status}</span>
                </div>
                <OutcomeChips decision={decision} />
              </li>
            ))}
            {detail.decisions.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">没有决策记录</li>}
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold">事件</h4>
          <ul className="mt-1 max-h-56 divide-y overflow-auto rounded-md border">
            {detail.events.map((event) => (
              <li className="px-2.5 py-1.5 text-[11px]" key={event.id}>
                <span className="text-muted-foreground">{formatTime(event.createdAt)}</span>
                <span className="mx-1.5">·</span>
                <span className="font-medium">{event.kind}</span>
                <span className="mx-1.5">·</span>
                {event.message}
              </li>
            ))}
            {detail.events.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">没有事件</li>}
          </ul>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold">委托与成交</h4>
          <ul className="mt-1 divide-y rounded-md border">
            {detail.orders.map((order) => (
              <li className="px-2.5 py-2 text-[12px]" key={order.id}>
                {order.symbolCode} · {order.side === 'buy' ? '买入' : '卖出'} {order.qty} 股 · {order.status}
                {order.fillPriceCents != null && ` · 成交 ${(order.fillPriceCents / 100).toFixed(2)} 元 @${order.fillTradeDate}`}
                {order.rejectCode && ` · ${order.rejectCode}`}
              </li>
            ))}
            {detail.orders.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">没有委托</li>}
          </ul>
        </div>
        <div>
          <h4 className="text-xs font-semibold">模型尝试</h4>
          <ul className="mt-1 divide-y rounded-md border">
            {detail.attempts.map((attempt) => (
              <li className="px-2.5 py-2 text-[11px]" key={attempt.attemptNo}>
                第 {attempt.attemptNo} 次 · {attempt.errorMessage ? `失败：${attempt.errorMessage}` : '通过校验'}
                <span className="block text-muted-foreground">{formatTime(attempt.createdAt)}</span>
              </li>
            ))}
            {detail.attempts.length === 0 && <li className="px-2.5 py-2 text-xs text-muted-foreground">没有尝试记录</li>}
          </ul>
        </div>
      </div>

      <Disclosure title="原始输入（行情/新闻/账户快照）" hint="JSON" headingLevel={3}>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[10px] leading-4">
          {detail.run.inputJson}
        </pre>
      </Disclosure>
      <Disclosure title="原始模型输出" hint="JSON" headingLevel={3}>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-2 text-[10px] leading-4">
          {detail.run.rawResponse ?? '（无输出）'}
        </pre>
      </Disclosure>
    </div>
  )
}

export function AgentDashboardView({ dashboard }: { dashboard: AgentDashboard }) {
  const router = useRouter()
  const [horizon, setHorizon] = useState<Horizon>(5)
  const [queued, setQueued] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AgentRunDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const detailRequestRef = useRef(0)
  const detailAbortRef = useRef<AbortController | null>(null)

  const stats = dashboard.stats.find((item) => item.horizonDays === horizon) ?? dashboard.stats[0]

  const refresh = useCallback(async () => {
    await router.replace(router.asPath)
  }, [router])

  const trigger = useCallback(async (action: 'plan' | 'outcomes') => {
    setBusy(true)
    setQueued(null)
    try {
      const response = await fetch('/api/paper/agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error?.message ?? '触发失败')
      setQueued(`${action === 'plan' ? '计划生成' : '到期评估'}已入队（任务 ${String(payload.data.taskId).slice(0, 10)}…），完成后刷新查看。`)
    } catch (err) {
      setQueued(err instanceof Error ? err.message : '触发失败')
    } finally {
      setBusy(false)
    }
  }, [])

  const openRun = useCallback(async (runId: string) => {
    detailAbortRef.current?.abort()
    const request = detailRequestRef.current + 1
    detailRequestRef.current = request
    if (detailId === runId) {
      setDetailId(null)
      setDetail(null)
      setDetailError(null)
      setDetailLoading(false)
      return
    }
    const controller = new AbortController()
    detailAbortRef.current = controller
    setDetailId(runId)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const response = await fetch(`/api/paper/agent/runs/${encodeURIComponent(runId)}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error?.message ?? '读取失败')
      // 慢响应返回时用户可能已切到别的 run，旧数据不能覆盖新选择。
      if (request !== detailRequestRef.current) return
      setDetail(payload.data as AgentRunDetail)
    } catch (err) {
      if (request !== detailRequestRef.current) return
      setDetailError(err instanceof Error ? err.message : '读取失败')
    } finally {
      if (request === detailRequestRef.current) setDetailLoading(false)
    }
  }, [detailId])

  if (!dashboard.experiment) {
    return (
      <EmptyState
        title="模拟盘还没建实验"
        actions={<Link className={buttonVariants({ variant: 'default', size: 'sm' })} href="/paper">去创建</Link>}
      >
        投资经理 agent 需要一个运行中的模拟盘实验；建好后每天 17:35 自动生成次日计划。
      </EmptyState>
    )
  }

  const nav = dashboard.nav
  const benchmarkExcess = nav?.returnBp != null && nav.benchmarkReturnBp != null
    ? nav.returnBp - nav.benchmarkReturnBp
    : null

  return (
    <div className="grid gap-3">
      <article className="ck-card ck-hero-card" aria-labelledby="agent-headline">
        <div className="ck-hero-top">
          <span className="ck-hero-kicker">投资经理 agent</span>
          <div className="ck-hero-meta">
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Bot className="size-3.5" aria-hidden="true" />
              {dashboard.experiment.name}
            </span>
            <span className="text-[11px] text-muted-foreground">更新 {formatTime(dashboard.generatedAt)}</span>
          </div>
        </div>
        <h2 className="ck-hero-claim" id="agent-headline">
          先看判断准不准，再看赚没赚。
        </h2>
        <p className="px-[18px] text-[12px] leading-5 text-muted-foreground">
          正确率按“方向命中”计算：看多后上涨、看空后下跌；alpha 为相对 {dashboard.experiment.benchmarkCode} 的超额。
          所有决策（含未执行）都计入判断样本，执行结果单独列出。
        </p>

        <div className="mx-[18px] mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          <HeroStat
            label={`T+${horizon} 方向正确率`}
            value={pct(stats?.directionHitRate)}
            note={`${stats?.directional ?? 0} 条有方向样本`}
            tone={positiveTone(stats?.directionHitRate != null ? stats.directionHitRate - 50 : null)}
          />
          <HeroStat
            label={`T+${horizon} 跑赢基准率`}
            value={pct(stats?.alphaHitRate)}
            note={`${stats?.alphaEvaluated ?? 0} 条 alpha 样本`}
            tone={positiveTone(stats?.alphaHitRate != null ? stats.alphaHitRate - 50 : null)}
          />
          <HeroStat
            label={`T+${horizon} 平均 alpha`}
            value={formatBpPct(stats?.avgAlphaBp)}
            note={`平均收益 ${formatBpPct(stats?.avgReturnBp)}`}
            tone={positiveTone(stats?.avgAlphaBp)}
          />
          <HeroStat
            label="已执行交易"
            value={`${stats?.executed.outcomes ?? 0} 条`}
            note={`alpha ${pct(stats?.executed.alphaHitRate)} · ${formatBpPct(stats?.executed.avgAlphaBp)}`}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-[18px]">
          <div className="inline-flex items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5" role="tablist" aria-label="评估周期">
            {HORIZONS.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={item === horizon}
                onClick={() => setHorizon(item)}
                className={cn(
                  'inline-flex min-h-7 items-center rounded-md px-2.5 text-xs font-medium',
                  item === horizon ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                T+{item}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {nav && (
              <span className="text-[11px] text-muted-foreground">
                总资产 {formatCny(nav.totalEquityCents, true)} · 相对初始 {formatBpPct(nav.returnBp)} ·
                基准 {formatBpPct(nav.benchmarkReturnBp)} · 超额{' '}
                <b className={cn('tabular-nums', positiveTone(benchmarkExcess))}>{formatBpPct(benchmarkExcess)}</b>
              </span>
            )}
            <Button size="sm" variant="outline" onClick={refresh}>
              <RefreshCw /> 刷新
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => trigger('plan')}>
              <Sparkles /> 立即生成计划
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => trigger('outcomes')}>
              补评到期结果
            </Button>
          </div>
        </div>
        {queued && <p className="mx-[18px] mt-2 text-[11px] text-muted-foreground">{queued}</p>}

        {dashboard.curve.length > 1 && (
          <div className="ck-hero-foot">
            <div className="flex items-center gap-3">
              <Sparkline
                values={dashboard.curve.map((point) => point.totalEquityCents)}
                label={`agent 组合净值 ${dashboard.curve.length} 个交易日`}
                changePct={benchmarkExcess == null ? null : benchmarkExcess / 100}
              />
              <span className="text-[11px] leading-4 text-muted-foreground">
                主账户净值 · {dashboard.curve.length} 个交易日<br />
                {formatShortDate(dashboard.curve[0].date)} – {formatShortDate(dashboard.curve[dashboard.curve.length - 1].date)}
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {dashboard.counts.runs} 次计划 · {dashboard.counts.decisions} 条决策 · {dashboard.counts.executed} 条已委托
              {dashboard.counts.failedRuns > 0 ? ` · ${dashboard.counts.failedRuns} 次失败` : ''}
            </span>
          </div>
        )}
      </article>

      <section className="ck-section" aria-labelledby="agent-accuracy-title">
        <SectionHeader
          id="agent-accuracy-title"
          title={`T+${horizon} 复盘`}
          detail="按动作、按置信度拆开看；没有结果时保持空白，不用估算填数。"
        />
        {stats && <AccuracyTable stats={stats} horizon={horizon} />}
      </section>

      <section className="ck-section" aria-labelledby="agent-runs-title">
        <SectionHeader
          id="agent-runs-title"
          title="每日计划"
          detail="列表展示最近 30 次，上方计数为全量；点开可回溯模型输入、每次尝试、决策与最终成交。"
        />
        {dashboard.runs.length === 0 ? (
          <EmptyState title="还没有计划记录">
            每天收盘后 17:35 自动生成；第一次运行会留在这里，包括失败原因与原始输出。
          </EmptyState>
        ) : (
          <ul className="ck-card divide-y overflow-hidden">
            {dashboard.runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-muted/40"
                  onClick={() => openRun(run.id)}
                  aria-expanded={detailId === run.id}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
                      <b className="font-semibold">{formatShortDate(run.barsDate)} 收盘</b>
                      <span className="text-muted-foreground">→ 计划 {formatShortDate(run.planTradeDate)}</span>
                      <span className={cn('font-medium', runTone(run.status))}>{RUN_STATUS_LABEL[run.status] ?? run.status}</span>
                      <span className="text-muted-foreground">{run.decisions} 条决策 · {run.executed} 条已委托</span>
                    </div>
                    {run.marketView && <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{run.marketView}</p>}
                    {run.review && <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">复盘：{run.review}</p>}
                    {run.errorMessage && <p className="mt-0.5 text-[11px] text-destructive">{run.errorCode}：{run.errorMessage}</p>}
                  </div>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{detailId === run.id ? '收起' : '查看'}</span>
                </button>
                {detailId === run.id && (
                  <div className="border-t bg-muted/20 p-3">
                    <RunDetailPanel detail={detail} loading={detailLoading} error={detailError} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ck-section" aria-labelledby="agent-decisions-title">
        <SectionHeader
          id="agent-decisions-title"
          title="近期决策"
          detail="每一条都有当时的逻辑、反证、证伪条件与 T+1/5/20 结果。"
          action={<Link className={buttonVariants({ variant: 'ghost', size: 'sm' })} href="/paper"><ArrowLeft /> 返回模拟盘</Link>}
        />
        {dashboard.recentDecisions.length === 0 ? (
          <EmptyState title="还没有 agent 决策">
            计划生成后，这里会逐条列出买入、卖出与观察判断，并附上事后收益。
          </EmptyState>
        ) : (
          <ul className="ck-card divide-y overflow-hidden">
            {dashboard.recentDecisions.map((decision) => (
              <DecisionRow decision={decision} key={decision.id} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
