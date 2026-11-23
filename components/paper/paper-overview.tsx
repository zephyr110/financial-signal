import type { ReactNode } from 'react'
import { AlertTriangle, ArrowRight, CheckCircle2, CircleDashed, Clock3 } from 'lucide-react'
import { Disclosure, EmptyState, SectionHeader, Sparkline } from '@/components/cockpit/bits'
import { dateShanghai, formatCny, formatDateCn, formatPrice, formatShortDate, formatTime } from '@/lib/cockpit/format'
import type { PaperSummary } from '@/lib/paper/summary'
import { cn } from '@/lib/utils'
import { PaperActions } from './paper-actions'
import { PaperCardActions, PaperOrderActions } from './paper-trade-actions'
import {
  ACTION_LABEL,
  CARD_STATUS,
  EXPERIMENT_STATUS,
  ORDER_STATUS,
  RECON_STATUS,
  RISK_LABEL,
  STANCE_LABEL,
  formatBpPct,
  formatNumber,
  gateDecisionLabel,
  positiveTone,
  reasonLabel,
} from './labels'

type Tone = 'neutral' | 'accent' | 'ok' | 'warning' | 'critical'

const TAG_TONE: Record<Tone, string> = {
  neutral: 'border-border bg-muted/60 text-muted-foreground',
  accent: 'border-primary/25 bg-primary/10 text-primary',
  ok: 'border-positive/30 bg-positive/10 text-positive',
  warning: 'border-chart-5/35 bg-chart-5/10 text-chart-5',
  critical: 'border-destructive/35 bg-destructive/10 text-destructive',
}

function Tag({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className={cn(
      'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
      TAG_TONE[tone],
    )}>
      {children}
    </span>
  )
}

function statusTone(status: string): Tone {
  if (status === 'active' || status === 'pass' || status === 'filled' || status === 'executed') return 'ok'
  if (status === 'paused' || status === 'warn' || status === 'settlement_pending'
    || status === 'confirmed' || status === 'triggered' || status === 'missing_price') return 'warning'
  if (status === 'fail' || status === 'rejected' || status === 'invalidated' || status === 'closed') return 'critical'
  return 'neutral'
}

function AccountRow({ account }: { account: PaperSummary['accounts'][number] }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {account.name}
          <Tag tone={account.kind === 'user' ? 'accent' : 'neutral'}>
            {account.kind === 'user' ? '实际跟踪' : '影子对照'}
          </Tag>
        </span>
        <Tag tone={statusTone(account.status)}>{account.status === 'active' ? '运行中' : account.status === 'paused' ? '已暂停' : '已关闭'}</Tag>
      </div>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <span className="block text-[11px] text-muted-foreground">总资产</span>
          <b className="text-lg font-semibold tabular-nums">
            {formatCny(account.nav?.totalEquityCents ?? account.cashCents, true)}
          </b>
        </div>
        <span className="text-right text-[11px] leading-5 text-muted-foreground">
          {account.nav
            ? `净值截至 ${formatShortDate(account.nav.tradeDate)}${account.nav.quality === 'warn' ? '（含非当日价）' : ''}`
            : '尚未结算出净值'}
          <br />
          现金 {formatCny(account.cashCents, true)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px] text-muted-foreground">
        <span className={positiveTone(account.nav?.dailyReturnBp)}>
          当日 {formatBpPct(account.nav?.dailyReturnBp)}
        </span>
        <span>回撤 {formatBpPct(account.nav?.drawdownBp, false)}</span>
        <span>{account.risk.killSwitch ? '风控停牌' : '未停牌'}</span>
        <span>{RISK_LABEL[account.risk.dataQuality] ?? account.risk.dataQuality}</span>
      </div>
      {account.kind === 'shadow' && (
        <p className="mt-1 text-[10px] text-muted-foreground">影子账户按同一批卡自动执行，用作人工执行的对照。</p>
      )}
    </div>
  )
}

function GateBlock({ report }: { report: NonNullable<PaperSummary['gates']>['l1'] }) {
  const label = report.gate === 'L1_TO_L2' ? 'L1 → L2 过程与完整性' : 'L2 → L3 绩效与校准'
  const ratio = report.totalRatioBp / 100
  const tone = report.decision === 'pass' ? 'ok' : report.decision === 'blocked' ? 'warning' : 'critical'
  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{label}</h4>
        <Tag tone={tone}>{gateDecisionLabel(report.decision)}</Tag>
      </div>
      <div className="mt-2">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>加权得分 {ratio.toFixed(0)} / 100</span>
          <span>门槛 ≥80</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={`阶段门得分 ${ratio.toFixed(0)} 分`}>
          <span
            className={cn('block h-full rounded-full', tone === 'ok' ? 'bg-positive' : tone === 'warning' ? 'bg-chart-5' : 'bg-destructive')}
            style={{ width: `${Math.min(100, Math.max(0, ratio))}%` }}
          />
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <div>
          <dt className="text-muted-foreground">有效交易日</dt>
          <dd className="font-medium tabular-nums">{report.sample.validDays} · {report.sample.required}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">最后一张卡满 60 日</dt>
          <dd className="font-medium">{report.sample.lastCardMature60 ? '是' : '否'}</dd>
        </div>
      </dl>
      {report.failedCriteria.length > 0 && (
        <div className="mt-3 border-t pt-2">
          <p className="text-[11px] font-medium text-destructive">未达标项</p>
          <ul className="mt-1 space-y-1 text-[11px] leading-5 text-muted-foreground">
            {report.failedCriteria.slice(0, 6).map((item) => <li key={item}>· {item}</li>)}
          </ul>
        </div>
      )}
      {report.blockedBy.length > 0 && (
        <div className="mt-2">
          <p className="text-[11px] font-medium text-chart-5">待补证据</p>
          <ul className="mt-1 space-y-1 text-[11px] leading-5 text-muted-foreground">
            {report.blockedBy.slice(0, 5).map((item) => <li key={item}>· {item}</li>)}
          </ul>
        </div>
      )}
      <div className="mt-3 grid gap-1.5 border-t pt-2">
        {report.dimensions.map((dim) => (
          <div className="flex items-center gap-2 text-[11px]" key={dim.key}>
            <span className="w-20 flex-none text-muted-foreground">{dim.label}</span>
            <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn('block h-full rounded-full', dim.status === 'pass' ? 'bg-positive' : dim.status === 'pending' ? 'bg-chart-5' : 'bg-destructive')}
                style={{ width: `${Math.min(100, (dim.ratioBp ?? 0) / 100)}%` }}
              />
            </span>
            <span className="w-9 text-right tabular-nums text-muted-foreground">
              {dim.ratioBp == null ? '—' : `${Math.round(dim.ratioBp / 100)}%`}
            </span>
            <span className="w-7 text-right tabular-nums text-muted-foreground">{dim.weight}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CardList({
  cards,
  navCents,
  onChanged,
}: {
  cards: PaperSummary['cards']
  navCents: number
  onChanged: () => Promise<void> | void
}) {
  const count = Object.values(cards.counts).reduce((sum, n) => sum + n, 0)
  return (
    <section className="ck-section" aria-labelledby="paper-cards-title">
      <SectionHeader
        id="paper-cards-title"
        title={`决策卡${count ? ` · ${count} 张` : ''}`}
        detail={cards.latestTradeDate
          ? `${formatDateCn(cards.latestTradeDate)} · 待确认 ${cards.pendingToday} 张，明日候选 ${cards.pendingFuture} 张`
          : '生成后按固定规则展示；没有卡时不补造结论。'}
      />
      {cards.items.length === 0 ? (
        <EmptyState title="还没有决策卡">
          收盘数据、政策与公告齐备后，系统会按固定证据门槛生成卡。没有卡时不需要操作模拟盘。
        </EmptyState>
      ) : (
        <ul className="ck-card overflow-hidden">
          {cards.items.map((card) => (
            <li className="grid gap-2 border-t px-4 py-3 first:border-t-0 sm:grid-cols-[minmax(0,1fr)_auto]" key={card.id}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{card.symbolName || card.symbolCode}</span>
                  <code className="text-[11px] text-muted-foreground">{card.symbolCode}</code>
                  <Tag tone={card.stance === 'candidate' ? 'accent' : 'neutral'}>
                    {STANCE_LABEL[card.stance] ?? card.stance}
                  </Tag>
                  <Tag tone={statusTone(card.status)}>{CARD_STATUS[card.status] ?? card.status}</Tag>
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-muted-foreground">{card.thesis}</p>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-muted-foreground sm:text-right">
                <span>触发 {card.triggerPriceCents == null ? '—' : `≤ ¥${formatPrice(card.triggerPriceCents / 100)}`}</span>
                <span>止损 {card.stopPriceCents == null ? '—' : `¥${formatPrice(card.stopPriceCents / 100)}`}</span>
                <span>仓位 ≤ {(card.maxPositionPctBp / 100).toFixed(0)}%</span>
                <span>置信 {Math.round(card.confidenceScore)}</span>
              </div>
              {card.status === 'active' && card.stance === 'candidate' && (
                <div className="sm:col-span-2">
                  <PaperCardActions card={card} navCents={navCents} onChanged={onChanged} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function PaperOverview({
  summary,
  onChanged,
}: {
  summary: PaperSummary
  onChanged: () => Promise<void> | void
}) {
  const { experiment, accounts, nav, metrics, cards, orders, fills, reconciliation, reviews, today } = summary
  if (!experiment) return null
  const user = accounts.find((a) => a.kind === 'user') ?? null
  const shadow = accounts.find((a) => a.kind === 'shadow') ?? null
  const series = nav.series.map((point) => point.totalEquityCents)
  const benchmarkBasis = metrics?.benchmark.basis
  const userMetrics = metrics?.accounts.user ?? null
  const actionTone: Tone = today.action === 'blocked'
    ? 'critical'
    : today.action === 'review_cards' || today.action === 'start' || today.action === 'resume'
      ? 'warning'
      : today.action === 'wait_settlement' ? 'accent' : 'neutral'

  return (
    <div className="grid gap-1">
      {(summary.metricsError || summary.gatesError) && (
        <div className="ck-error-banner">
          {summary.metricsError ? `指标暂不可用：${summary.metricsError}` : `阶段门暂不可用：${summary.gatesError}`}
        </div>
      )}

      <article className="ck-card ck-hero-card" aria-labelledby="paper-headline">
        <div className="ck-hero-top">
          <span className="ck-hero-kicker">今天要不要动</span>
          <div className="ck-hero-meta">
            <Tag tone={actionTone}>{ACTION_LABEL[today.action]}</Tag>
            <Tag tone={today.isTradingDay ? 'neutral' : 'warning'}>
              {today.isTradingDay ? '交易日' : '休市日'}
            </Tag>
            <Tag tone={statusTone(experiment.status)}>{EXPERIMENT_STATUS[experiment.status] ?? experiment.status}</Tag>
          </div>
        </div>
        <h2 className="ck-hero-claim" id="paper-headline">{today.headline}</h2>
        <p className="px-[18px] text-[12px] leading-5 text-muted-foreground">
          {formatDateCn(today.tradeDate)} · 上海时间 {today.now} · 确认截止 {today.cutoffAt}
          {!today.isTradingDay && ' · 今天只采集新闻与政策'}
        </p>

        <div className="mx-[18px] mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
          <div className="bg-card p-3">
            <span className="block text-[11px] text-muted-foreground">虚拟总资产</span>
            <b className="mt-0.5 block text-lg font-semibold tabular-nums">
              {formatCny(user?.nav?.totalEquityCents ?? user?.cashCents ?? experiment.initialCashCents, true)}
            </b>
            <span className="text-[10px] text-muted-foreground">
              {user?.nav
                ? `截至 ${formatShortDate(user.nav.tradeDate)}${user.nav.quality === 'warn' ? ' · 含非当日价' : ''}`
                : '待首次结算'}
            </span>
          </div>
          <div className="bg-card p-3">
            <span className="block text-[11px] text-muted-foreground">相对基准</span>
            <b className={cn('mt-0.5 block text-lg font-semibold tabular-nums', positiveTone(metrics?.excessBp.user))}>
              {formatBpPct(metrics?.excessBp.user)}
            </b>
            <span className="text-[10px] text-muted-foreground">
              {metrics?.benchmark.code ?? experiment.benchmarkCode}{benchmarkBasis === 'price_index' ? ' · 价格指数（估算）' : benchmarkBasis === 'total_return_index' ? ' · 全收益' : ''}
            </span>
          </div>
          <div className="bg-card p-3">
            <span className="block text-[11px] text-muted-foreground">最大回撤</span>
            <b className="mt-0.5 block text-lg font-semibold tabular-nums">
              {formatBpPct(userMetrics?.maxDrawdownBp, false)}
            </b>
            <span className="text-[10px] text-muted-foreground">实验以来 · 门槛 ≤10%</span>
          </div>
          <div className="bg-card p-3">
            <span className="block text-[11px] text-muted-foreground">有效交易日</span>
            <b className="mt-0.5 block text-lg font-semibold tabular-nums">
              {metrics ? metrics.sample.validDays : '—'}<span className="text-xs font-normal text-muted-foreground"> / 120</span>
            </b>
            <span className="text-[10px] text-muted-foreground">
              {metrics?.sample.sufficientForDescriptive ? '已达描述统计门槛' : '只报计数，不下有效性结论'}
            </span>
          </div>
        </div>

        <div className="ck-hero-foot">
          <div className="min-w-0 text-[12px] leading-5 text-muted-foreground">
            <b className="font-medium text-foreground">{experiment.name}</b>
            <span className="mx-1.5">·</span>
            {metrics?.benchmark.code ?? experiment.benchmarkCode}
            <span className="mx-1.5">·</span>
            初始 {formatCny(experiment.initialCashCents, true)}
            <span className="mx-1.5">·</span>
            重置 {experiment.resetCount} 次
            {experiment.pauseReason && (
              <span className="mt-1 block text-chart-5">暂停原因：{experiment.pauseReason}</span>
            )}
          </div>
          <PaperActions
            experimentId={experiment.id}
            status={experiment.status}
            onChanged={onChanged}
          />
        </div>
      </article>

      <section className="ck-section" aria-labelledby="paper-todo-title">
        <SectionHeader
          id="paper-todo-title"
          title="今日待办"
          detail="按时间顺序处理；没有待办时保持观察，不为交易而交易。"
        />
        <ul className="ck-card divide-y overflow-hidden">
          {today.todos.map((todo) => {
            const Icon = todo.kind === 'action' ? Clock3 : todo.kind === 'warning' ? AlertTriangle : CheckCircle2
            return (
              <li className="flex items-start gap-3 px-4 py-3" key={`${todo.kind}-${todo.label}`}>
                <Icon
                  className={cn(
                    'mt-0.5 size-4 flex-none',
                    todo.kind === 'action' ? 'text-primary' : todo.kind === 'warning' ? 'text-chart-5' : 'text-muted-foreground',
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">{todo.label}</p>
                  {todo.detail && <p className="mt-0.5 text-[12px] leading-5 text-muted-foreground">{todo.detail}</p>}
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      <section className="ck-section grid gap-3 lg:grid-cols-[1.25fr_1fr]" aria-label="账户净值与执行">
        <div className="ck-card ck-card-pad">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="ck-section-title">主账户净值</h2>
              <p className="ck-section-detail">
                {nav.latest ? `截至 ${formatShortDate(nav.latest.tradeDate)} 收盘 · 每日 16:30 记录` : '首次收盘结算后出现净值曲线'}
              </p>
            </div>
            <Tag tone={benchmarkBasis === 'price_index' ? 'warning' : 'neutral'}>
              {metrics?.benchmark.code ?? experiment.benchmarkCode}
              {benchmarkBasis === 'price_index' ? ' 价格指数' : benchmarkBasis === 'total_return_index' ? ' 全收益' : ''}
            </Tag>
          </div>
          <div className="mt-3 flex flex-wrap items-end justify-between gap-2">
            <div>
              <b className="text-2xl font-semibold tabular-nums">
                {formatCny(nav.latest?.totalEquityCents ?? user?.cashCents ?? experiment.initialCashCents)}
              </b>
              <span className={cn('ml-2 text-sm tabular-nums', positiveTone(userMetrics?.returnBp))}>
                {formatBpPct(userMetrics?.returnBp)}
              </span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {userMetrics?.startDate ? `${formatShortDate(userMetrics.startDate)} 起` : ''}
              {userMetrics?.fillCount != null ? ` · ${userMetrics.fillCount} 笔成交` : ''}
            </span>
          </div>
          {series.length >= 2 ? (
            <Sparkline
              values={series}
              label="主账户净值走势"
              changePct={userMetrics?.returnBp == null ? null : userMetrics.returnBp / 100}
              className="mt-3 h-12"
            />
          ) : (
            <div className="mt-3 flex h-12 items-center justify-center rounded-lg border border-dashed text-[11px] text-muted-foreground">
              净值点不足两个，先等几个交易日
            </div>
          )}
          <div className="ck-stat-line">
            <div className="ck-stat">
              <span className="ck-stat-label">年化收益</span>
              <span className="ck-stat-value">
                {userMetrics?.annualizedReturnBp == null ? '—' : formatBpPct(userMetrics.annualizedReturnBp)}
              </span>
              <span className="ck-stat-note">{userMetrics?.annualizedReturnBp == null ? '不足 252 个交易日不年化' : '按 252 日'}</span>
            </div>
            <div className="ck-stat">
              <span className="ck-stat-label">费用拖累</span>
              <span className="ck-stat-value">{formatBpPct(userMetrics?.feesDragBp, false)}</span>
              <span className="ck-stat-note">累计 {formatCny(userMetrics?.totalFeesCents ?? 0, true)}</span>
            </div>
            <div className="ck-stat">
              <span className="ck-stat-label">夏普</span>
              <span className="ck-stat-value">{userMetrics?.sharpe == null ? '—' : userMetrics.sharpe.toFixed(2)}</span>
              <span className="ck-stat-note">无风险利率按 0</span>
            </div>
          </div>
        </div>

        <div className="ck-card ck-card-pad">
          <h2 className="ck-section-title">双轨账户</h2>
          <p className="ck-section-detail">同一批卡，主账户由你确认；影子账户按规则自动执行，用来区分「方法」与「手」。 </p>
          <div className="mt-3 grid gap-2">
            {user && <AccountRow account={user} />}
            {shadow && <AccountRow account={shadow} />}
          </div>
          <div className="ck-stat-line">
            <div className="ck-stat">
              <span className="ck-stat-label">触发卡</span>
              <span className="ck-stat-value">{metrics?.execution.triggeredCards ?? '—'}</span>
            </div>
            <div className="ck-stat">
              <span className="ck-stat-label">执行率</span>
              <span className="ck-stat-value">{formatBpPct(metrics?.execution.executionRateBp, false)}</span>
              <span className="ck-stat-note">{metrics ? `${metrics.execution.filledCards} 张成交` : '—'}</span>
            </div>
            <div className="ck-stat">
              <span className="ck-stat-label">偏离</span>
              <span className="ck-stat-value">
                {metrics?.execution.deviations.length
                  ? metrics.execution.deviations.map((d) => `${reasonLabel(d.reason)} ${d.count}`).join(' · ')
                  : '无'}
              </span>
            </div>
          </div>
        </div>
      </section>

      <CardList
        cards={cards}
        navCents={user?.nav?.totalEquityCents ?? user?.cashCents ?? experiment.initialCashCents}
        onChanged={onChanged}
      />

      <section className="ck-section grid gap-3 lg:grid-cols-2" aria-label="委托与成交">
        <div>
          <SectionHeader
            title={`最近委托${orders.openCount ? ` · ${orders.openCount} 笔在途` : ''}`}
            detail="确认后 09:15 截止；收盘按官方开盘价结算。"
          />
          {orders.recent.length === 0 ? (
            <EmptyState title="还没有委托">确认一张候选卡后，委托会出现在这里。</EmptyState>
          ) : (
            <ul className="ck-card overflow-hidden">
              {orders.recent.map((order) => (
                <li className="flex items-start justify-between gap-3 border-t px-4 py-2.5 first:border-t-0" key={order.id}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <b className="font-medium">{order.symbolName || order.symbolCode}</b>
                      <Tag tone={order.side === 'buy' ? 'accent' : 'neutral'}>{order.side === 'buy' ? '买入' : '卖出'}</Tag>
                      <span className="text-muted-foreground">{formatNumber(order.qty)} 股</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      目标 {formatShortDate(order.targetTradeDate)} · {formatTime(order.createdAt)}
                      {order.rejectCode ? ` · ${order.rejectCode}` : ''}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <Tag tone={statusTone(order.status)}>{ORDER_STATUS[order.status] ?? order.status}</Tag>
                    <PaperOrderActions order={order} onChanged={onChanged} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <SectionHeader
            title="最近成交"
            detail="成交价来自官方日线开盘价；计划外成交必须带理由。"
          />
          {fills.recent.length === 0 ? (
            <EmptyState title="还没有成交">只有确认的委托触发后才会产生纸面成交。</EmptyState>
          ) : (
            <ul className="ck-card overflow-hidden">
              {fills.recent.map((fill) => (
                <li className="flex items-start justify-between gap-3 border-t px-4 py-2.5 first:border-t-0" key={fill.id}>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[13px]">
                      <b className="font-medium">{fill.symbolName || fill.symbolCode}</b>
                      <Tag tone={fill.side === 'buy' ? 'accent' : 'neutral'}>{fill.side === 'buy' ? '买入' : '卖出'}</Tag>
                      <span className="text-muted-foreground">{formatNumber(fill.qty)} 股</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatShortDate(fill.tradeDate)} · ¥{formatPrice(fill.priceCents / 100)} · 费用 {formatCny(fill.totalFeesCents)}
                    </p>
                  </div>
                  <Tag tone={fill.priceBasis === 'official_daily_open' ? 'ok' : 'warning'}>
                    {fill.priceBasis === 'official_daily_open' ? '官方开盘' : '人工价'}
                  </Tag>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="ck-section grid gap-3 lg:grid-cols-2" aria-label="风险与对账">
        <div>
          <SectionHeader title="风险状态" detail="任一账户数据失败或停牌时，模拟盘不生成新卡、不成交。" />
          <div className="ck-card ck-card-pad grid gap-3">
            {accounts.map((account) => (
              <div className="flex items-start justify-between gap-3" key={account.id}>
                <div>
                  <p className="text-[13px] font-medium">{account.name}</p>
                  <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">
                    {RISK_LABEL[account.risk.dataQuality] ?? account.risk.dataQuality}
                    {account.risk.missingPriceSince ? ` · 缺价自 ${formatShortDate(account.risk.missingPriceSince)}` : ''}
                    {account.risk.killReason ? ` · ${account.risk.killReason}` : ''}
                  </p>
                </div>
                <Tag tone={account.risk.killSwitch || account.risk.dataQuality === 'fail' ? 'critical' : account.risk.dataQuality === 'warn' ? 'warning' : 'ok'}>
                  {account.risk.killSwitch ? '已停牌' : '正常'}
                </Tag>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionHeader title="对账" detail="现金、持仓、净值三者必须一致；不平衡会阻止进入下一阶段。" />
          {!reconciliation.user && !reconciliation.shadow ? (
            <EmptyState title="尚无对账记录">每日 16:30 结算后写入；缺价时保留挂起状态。</EmptyState>
          ) : (
            <div className="ck-card ck-card-pad grid gap-3">
              {[
                ['主账户', reconciliation.user],
                ['影子账户', reconciliation.shadow],
              ].map(([label, record]) => {
                const row = record as PaperSummary['reconciliation']['user']
                return (
                  <div className="flex items-start justify-between gap-3" key={label as string}>
                    <div>
                      <p className="text-[13px] font-medium">{label as string}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {row ? `${formatShortDate(row.tradeDate)} · 差额 ${formatCny(row.mismatchCents)}` : '尚无记录'}
                      </p>
                    </div>
                    <Tag tone={row ? statusTone(row.status) : 'neutral'}>
                      {row ? RECON_STATUS[row.status] ?? row.status : '未对账'}
                    </Tag>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      <section className="ck-section" aria-labelledby="paper-review-title">
        <SectionHeader
          id="paper-review-title"
          title="复盘"
          detail="先看事实与偏离，再解释；没有样本就不下有效性结论。"
        />
        {!reviews.daily && !reviews.weekly ? (
          <EmptyState title="还没有复盘">
            每个交易日 17:00 生成本日复盘，周六 10:00 生成本周复盘。没有复盘时不补写故事。
          </EmptyState>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {[reviews.daily, reviews.weekly].filter(Boolean).map((review) => {
              const item = review as NonNullable<typeof reviews.daily>
              return (
                <article className="ck-card ck-card-pad" key={item.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{item.kind === 'daily' ? '本日复盘' : '本周复盘'}</h3>
                    <Tag tone="neutral">{formatShortDate(item.periodStart)}–{formatShortDate(item.periodEnd)}</Tag>
                  </div>
                  <p className="mt-2 whitespace-pre-line text-[12px] leading-6 text-muted-foreground">
                    {item.narrative || '本期只记录事实，没有生成叙述。'}
                  </p>
                  <div className="ck-stat-line">
                    <div className="ck-stat">
                      <span className="ck-stat-label">主账户净值</span>
                      <span className="ck-stat-value">{item.actualNavCents == null ? '—' : formatCny(item.actualNavCents)}</span>
                    </div>
                    <div className="ck-stat">
                      <span className="ck-stat-label">影子净值</span>
                      <span className="ck-stat-value">{item.shadowNavCents == null ? '—' : formatCny(item.shadowNavCents)}</span>
                    </div>
                    <div className="ck-stat">
                      <span className="ck-stat-label">执行率</span>
                      <span className="ck-stat-value">{formatBpPct(item.executionRateBp, false)}</span>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <section className="ck-section" aria-label="阶段门与实验谱系">
        <Disclosure
          title="阶段门"
          hint={summary.gates
            ? `L1→L2 ${gateDecisionLabel(summary.gates.l1.decision)} · L2→L3 ${gateDecisionLabel(summary.gates.l2.decision)}`
            : '等待指标'}
          headingLevel={2}
        >
          {summary.gates ? (
            <div className="grid gap-3 lg:grid-cols-2">
              <GateBlock report={summary.gates.l1} />
              <GateBlock report={summary.gates.l2} />
            </div>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              {summary.gatesError || '阶段门尚未计算。'}
            </p>
          )}
          {metrics?.notes.length ? (
            <ul className="mt-3 space-y-1 text-[11px] leading-5 text-muted-foreground">
              {metrics.notes.map((note) => <li key={note}>· {note}</li>)}
            </ul>
          ) : null}
        </Disclosure>

        <div className="mt-3">
          <Disclosure
            title="实验谱系"
            hint={`${summary.history.length} 个版本 · 当前重置 ${experiment.resetCount} 次`}
            headingLevel={2}
          >
            <ol className="grid gap-2">
              {summary.history.map((item) => (
                <li className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2" key={item.id}>
                  <span className="flex min-w-0 items-center gap-2 text-[12px]">
                    <CircleDashed className="size-3.5 flex-none text-muted-foreground" aria-hidden="true" />
                    <b className="truncate font-medium">{item.name}</b>
                    <span className="text-muted-foreground">{EXPERIMENT_STATUS[item.status] ?? item.status}</span>
                  </span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {item.validDays} 日 · {formatShortDate(dateShanghai(item.createdAt))}
                    {item.endedAt ? ` → ${formatShortDate(dateShanghai(item.endedAt))}` : ''}
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
              旧实验只读保留，不能借重置改规则。
              <ArrowRight className="size-3" aria-hidden="true" />
              新实验沿用协议与资金档。
            </p>
          </Disclosure>
        </div>
      </section>
    </div>
  )
}
