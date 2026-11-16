import Link from 'next/link'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  FileText,
  Gauge,
  ListChecks,
  Newspaper,
  PieChart,
  Wallet,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type {
  DashboardBrief,
  DashboardPulse,
  DashboardSection,
  DashboardSectionKey,
} from '@/lib/dashboard/aggregate'
import type { PortfolioView, WatchlistItem } from '@/lib/cockpit/types'
import {
  formatCny,
  formatPrice,
  formatShortDate,
  formatSignedPct,
  formatTime,
  formatYi,
  taskStatusLabel,
  taskTypeLabel,
  thesisStatusLabel,
} from '@/lib/cockpit/format'
import type { AlertView, DeskSeverity, DeskStance } from '@/lib/desk/types'
import { cn } from '@/lib/utils'
import { Panel, PanelEmpty, PanelError, PanelRefresh, PanelSkeleton } from './panel'
import { useCockpitSelection } from './selection-context'

export interface CockpitPanelProps<K extends DashboardSectionKey> {
  section?: DashboardSection<K>
  loading: boolean
  refreshing: boolean
  onRetry: () => void
  onRefresh: () => void
}

const EVIDENCE_KIND: Record<string, string> = {
  fact: '事实',
  inference: '推断',
  counter: '反证',
  conclusion: '结论',
}

const STANCE: Record<DeskStance, { label: string; tone: string }> = {
  bullish: { label: '偏多', tone: 'text-chart-3' },
  neutral: { label: '中性', tone: 'text-muted-foreground' },
  bearish: { label: '偏空', tone: 'text-chart-2' },
}

const SEVERITY_DOT: Record<DeskSeverity, string> = {
  info: 'bg-muted-foreground',
  watch: 'bg-chart-1',
  important: 'bg-chart-5',
  critical: 'bg-destructive',
}

function toneClass(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-muted-foreground'
  return value > 0 ? 'text-chart-3' : 'text-chart-2'
}

function confidenceTone(label: string): string {
  if (label === '高') return 'text-chart-3'
  if (label === '低') return 'text-chart-2'
  return 'text-muted-foreground'
}

function ViewLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
      <ChevronRight className="size-3" aria-hidden="true" />
    </Link>
  )
}

function PanelActions({
  label,
  href,
  hrefLabel,
  refreshing,
  onRefresh,
}: {
  label: string
  href: string
  hrefLabel: string
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <>
      <PanelRefresh label={label} refreshing={refreshing} onClick={onRefresh} />
      <ViewLink href={href} label={hrefLabel} />
    </>
  )
}

function SectionFallback<K extends DashboardSectionKey>({
  section,
  loading,
  label,
  onRetry,
}: {
  section?: DashboardSection<K>
  loading: boolean
  label: string
  onRetry: () => void
}) {
  if (!section) {
    return loading
      ? <PanelSkeleton label={label} />
      : <PanelError message={`${label}暂时不可用`} onRetry={onRetry} />
  }
  if (section.ok === false) return <PanelError message={section.error} onRetry={onRetry} />
  return null
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${30 - ((value - min) / span) * 26}`)
    .join(' ')
  return (
    <svg
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      className="h-7 w-14 shrink-0 text-muted-foreground/60"
      aria-hidden="true"
    >
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** 涨跌分布与成交额：缺失值一律显示“—”，不把没取到的数据画成 0。 */
function BreadthBlock({ brief }: { brief: DashboardBrief }) {
  const { up, flat, down, limitUp, limitDown, limitUpDownAvailable } = brief.breadth
  const total = up + flat + down
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>涨跌分布</span>
        <span className="tabular-nums">{total > 0 ? `${total} 只` : '—'}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={total > 0 ? `上涨 ${up}，平盘 ${flat}，下跌 ${down}` : '暂无涨跌分布'}>
        {total > 0 && (
          <>
            <span className="bg-chart-3/80" style={{ width: `${(up / total) * 100}%` }} />
            <span className="bg-muted-foreground/30" style={{ width: `${(flat / total) * 100}%` }} />
            <span className="bg-chart-2/80" style={{ width: `${(down / total) * 100}%` }} />
          </>
        )}
      </div>
      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>涨 {up}</span>
        <span>平 {flat}</span>
        <span>跌 {down}</span>
      </div>
      <p className="mt-1.5 text-[10px] tabular-nums text-muted-foreground">
        {limitUpDownAvailable === false ? '涨跌停统计 —' : `涨停 ${limitUp} · 跌停 ${limitDown}`}
      </p>
    </div>
  )
}

export function BriefPanel({ section, loading, refreshing, onRetry, onRefresh }: CockpitPanelProps<'brief'>) {
  const { openSymbol, symbol } = useCockpitSelection()
  const brief = section?.ok ? section.data : null
  const meta = brief ? `${formatShortDate(brief.tradeDate)} · 第 ${brief.issueNo} 期` : undefined

  return (
    <Panel
      id="brief"
      title="今日简报"
      icon={<Newspaper />}
      meta={meta}
      action={<PanelActions label="简报" href="/today" hrefLabel="全文" refreshing={refreshing} onRefresh={onRefresh} />}
      className="md:col-span-2 xl:row-span-2"
    >
      {!brief ? (
        section?.ok ? (
          <PanelEmpty
            icon={<Newspaper />}
            title="今天还没有收盘简报"
            action={
              <Link href="/today" className="text-[11px] text-primary underline-offset-2 hover:underline">
                去简报页看看
              </Link>
            }
          >
            收盘后会生成结论、依据与你持仓相关的提示。
          </PanelEmpty>
        ) : (
          <SectionFallback section={section} loading={loading} label="今日简报" onRetry={onRetry} />
        )
      ) : (
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="outline" className={cn('h-5 px-1.5 text-[10px]', confidenceTone(brief.confidence.label))}>
                置信度 {brief.confidence.label}
              </Badge>
              <span className="text-[10px] text-muted-foreground">生成于 {formatTime(brief.generatedAt)}</span>
              {brief.isDemo && <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">示例数据</Badge>}
            </div>

            <p className="text-[15px] font-medium leading-7">{brief.claim}</p>

            {brief.evidence.length > 0 && (
              <ul className="flex flex-wrap gap-1.5" aria-label="结论依据">
                {brief.evidence.slice(0, 5).map((item) => (
                  <li key={item.id} className="inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]">
                    <span className="shrink-0 text-muted-foreground">{EVIDENCE_KIND[item.kind] || item.kind}</span>
                    <span className="truncate">{item.label}</span>
                    {item.value && <span className="shrink-0 font-medium tabular-nums">{item.value}</span>}
                  </li>
                ))}
              </ul>
            )}

            {brief.impacts.length > 0 && (
              <section aria-label="与你相关">
                <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">与你相关</h3>
                <ul className="space-y-1.5">
                  {brief.impacts.slice(0, 3).map((impact) => (
                    <li key={impact.code}>
                      <button
                        type="button"
                        onClick={() => openSymbol(impact.code)}
                        aria-current={symbol === impact.code ? 'true' : undefined}
                        className={cn(
                          'group flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          symbol === impact.code && 'border-ring/40 bg-accent/40',
                        )}
                      >
                        <span className="w-16 shrink-0 truncate text-xs font-medium">
                          {impact.name}
                          <span className="mt-0.5 block text-[10px] font-normal tabular-nums text-muted-foreground">{impact.code}</span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs">{impact.headline}</span>
                          <span className="mt-0.5 line-clamp-2 block text-[11px] leading-4 text-muted-foreground">{impact.detail}</span>
                        </span>
                        {impact.thesisStatus && (
                          <Badge variant="secondary" className="h-5 shrink-0 px-1.5 text-[10px]">
                            {thesisStatusLabel(impact.thesisStatus)}
                          </Badge>
                        )}
                        <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {brief.documents.length > 0 && (
              <section aria-label="公告">
                <h3 className="mb-1.5 text-[11px] font-medium text-muted-foreground">公告</h3>
                <ul className="space-y-1">
                  {brief.documents.slice(0, 2).map((doc) => (
                    <li key={doc.id} className="flex items-start gap-1.5 text-[11px] leading-4">
                      <FileText className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="line-clamp-1">{doc.title}</span>
                      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{formatShortDate(doc.publishedAt.slice(0, 10))}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>

          <aside className="space-y-3 lg:border-l lg:pl-4" aria-label="市场概览">
            {brief.indices.length > 0 ? (
              <ul className="space-y-1.5">
                {brief.indices.map((index) => (
                  <li key={index.code} className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate text-muted-foreground">{index.name}</span>
                    <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                      <span>{formatPrice(index.close)}</span>
                      <span className={cn('w-14 text-right', toneClass(index.changePct))}>{formatSignedPct(index.changePct)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[11px] text-muted-foreground">指数数据 —</p>
            )}
            <BreadthBlock brief={brief} />
            <div className="flex items-baseline justify-between gap-2 border-t pt-2.5 text-[11px]">
              <span className="text-muted-foreground">成交额</span>
              <span className="text-right tabular-nums">
                {formatYi(brief.turnover.value)}
                <span className={cn('ml-1.5', toneClass(brief.turnover.changePct))}>
                  {brief.turnover.changePct == null ? '较前日 —' : formatSignedPct(brief.turnover.changePct)}
                </span>
              </span>
            </div>
          </aside>
        </div>
      )}
    </Panel>
  )
}

export function PulsePanel({ section, loading, refreshing, onRetry, onRefresh }: CockpitPanelProps<'pulse'>) {
  const { openSymbol, symbol } = useCockpitSelection()
  const pulse = section?.ok ? section.data : null
  const meta = pulse?.tradeDate ? `${formatShortDate(pulse.tradeDate)} · ${formatTime(pulse.asOf)}` : undefined

  return (
    <Panel
      id="pulse"
      title="市场脉搏"
      icon={<Activity />}
      meta={meta}
      action={<PanelActions label="脉搏" href="/desk" hrefLabel="投研台" refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {!pulse ? (
        <SectionFallback section={section} loading={loading} label="市场脉搏" onRetry={onRetry} />
      ) : (
        <div className="space-y-3 p-4">
          {pulse.market ? (
            <div className="rounded-lg border bg-muted/30 p-2.5">
              <div className="flex items-center gap-1.5 text-[10px]">
                <Badge variant="outline" className={cn('h-5 px-1.5 text-[10px]', STANCE[pulse.market.stance].tone)}>
                  {STANCE[pulse.market.stance].label}
                </Badge>
                <span className="text-muted-foreground">置信度 {pulse.market.confidence === 'high' ? '高' : pulse.market.confidence === 'low' ? '低' : '中'}</span>
                {pulse.isDemo && <span className="text-muted-foreground">· 示例</span>}
              </div>
              <p className="mt-1.5 text-xs font-medium leading-5">{pulse.market.headline}</p>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{pulse.market.summary}</p>
            </div>
          ) : pulse.industries.length > 0 || pulse.realtime.length > 0 ? (
            <p className="text-[11px] leading-5 text-muted-foreground">投研台还没有今天的市场判断。</p>
          ) : null}

          {pulse.industries.length > 0 && <IndustryHeat industries={pulse.industries} />}

          {pulse.realtime.length > 0 && (
            <section aria-label="实时行情">
              <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">自选实盘</h3>
              <ul className="space-y-0.5">
                {pulse.realtime.map((quote) => (
                  <li key={quote.code}>
                    <button
                      type="button"
                      onClick={() => openSymbol(quote.code)}
                      aria-current={symbol === quote.code ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-baseline justify-between gap-2 rounded px-1 py-1 text-[11px] transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        symbol === quote.code && 'bg-accent/40',
                      )}
                    >
                      <span className="truncate">{quote.name || quote.code}</span>
                      <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                        <span>{formatPrice(quote.price)}</span>
                        <span className={cn('w-12 text-right', toneClass(quote.changePct))}>
                          {quote.changePct == null ? '—' : formatSignedPct(quote.changePct)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pulse.overseas.length > 0 && (
            <section aria-label="外盘" className="border-t pt-2">
              <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">外盘</h3>
              <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums">
                {pulse.overseas.map((quote) => (
                  <li key={quote.symbol} className="flex items-baseline gap-1">
                    <span className="text-muted-foreground">{quote.symbol}</span>
                    <span>{formatPrice(quote.price)}</span>
                    <span className={toneClass(quote.changePct)}>
                      {quote.changePct == null ? '—' : formatSignedPct(quote.changePct)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!pulse.market && pulse.industries.length === 0 && pulse.realtime.length === 0 && (
            <PanelEmpty icon={<Gauge />} title="暂无脉搏数据">
              每天收盘后投研台会生成快照。
            </PanelEmpty>
          )}
        </div>
      )}
    </Panel>
  )
}

function IndustryHeat({ industries }: { industries: DashboardPulse['industries'] }) {
  const max = Math.max(...industries.map((item) => Math.abs(item.score)), 1)
  return (
    <section aria-label="行业判断">
      <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">行业判断</h3>
      <ul className="space-y-1">
        {industries.map((item) => {
          const width = (Math.abs(item.score) / max) * 50
          return (
            <li key={item.id} className="flex items-center gap-2 text-[11px]">
              <span className="w-16 shrink-0 truncate text-muted-foreground">{item.industry || '—'}</span>
              <span className="relative h-1.5 flex-1 rounded-full bg-muted">
                <span
                  className={cn('absolute top-0 h-full rounded-full', item.score >= 0 ? 'bg-chart-3/80' : 'bg-chart-2/80')}
                  style={item.score >= 0
                    ? { left: '50%', width: `${width}%` }
                    : { right: '50%', width: `${width}%` }}
                />
              </span>
              <span className={cn('w-12 shrink-0 text-right tabular-nums', toneClass(item.score))}>
                {item.score > 0 ? '+' : ''}{item.score.toFixed(1)}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function WatchlistPanel({ section, loading, refreshing, onRetry, onRefresh }: CockpitPanelProps<'watchlist'>) {
  const { openSymbol, symbol } = useCockpitSelection()
  const items = section?.ok ? section.data : null
  const meta = items ? `${items.length} 只` : undefined

  return (
    <Panel
      id="watchlist"
      title="自选异动"
      icon={<ListChecks />}
      meta={meta}
      action={<PanelActions label="自选" href="/watchlist" hrefLabel="全部" refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {!items ? (
        <SectionFallback section={section} loading={loading} label="自选异动" onRetry={onRetry} />
      ) : items.length === 0 ? (
        <PanelEmpty
          icon={<ListChecks />}
          title="自选还没有标的"
          action={<Link href="/watchlist" className="text-xs text-primary underline-offset-4 hover:underline">去添加自选</Link>}
        >
          添加后这里按涨跌幅排出今天的异动。
        </PanelEmpty>
      ) : (
        <ul className="divide-y">
          {items.map((item) => (
            <li key={item.code}>
              <WatchlistRow item={item} selected={item.code === symbol} onOpen={() => openSymbol(item.code)} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function WatchlistRow({ item, selected, onOpen }: { item: WatchlistItem; selected: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        selected && 'bg-accent/40',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{item.name}</span>
        <span className="mt-0.5 block truncate text-[10px] tabular-nums text-muted-foreground">
          {item.code}
          {item.thesisStatus ? ` · ${thesisStatusLabel(item.thesisStatus)}` : ''}
        </span>
      </span>
      <Sparkline values={item.sparkline} />
      <span className="w-16 shrink-0 text-right">
        <span className="block text-xs tabular-nums">{formatPrice(item.price)}</span>
        <span className={cn('mt-0.5 block text-[11px] tabular-nums', toneClass(item.changePct))}>
          {item.changePct == null ? '—' : formatSignedPct(item.changePct)}
        </span>
      </span>
    </button>
  )
}

export function PortfolioPanel({ section, loading, refreshing, onRetry, onRefresh }: CockpitPanelProps<'portfolio'>) {
  const { openSymbol, symbol } = useCockpitSelection()
  const portfolio = section?.ok ? section.data : null
  const meta = portfolio ? `集中度 ${portfolio.concentration.toFixed(0)}%` : undefined

  return (
    <Panel
      id="portfolio"
      title="持仓暴露"
      icon={<PieChart />}
      meta={meta}
      action={<PanelActions label="持仓" href="/portfolio" hrefLabel="全部" refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {!portfolio ? (
        <SectionFallback section={section} loading={loading} label="持仓暴露" onRetry={onRetry} />
      ) : portfolio.positions.length === 0 ? (
        <PanelEmpty
          icon={<Wallet />}
          title="还没有录入持仓"
          action={<Link href="/portfolio" className="text-xs text-primary underline-offset-4 hover:underline">去录入持仓</Link>}
        >
          录入后可看到行业暴露与集中度风险。
        </PanelEmpty>
      ) : (
        <div className="space-y-3 p-4">
          <div className="flex items-end justify-between gap-2">
            <div>
              <p className="text-[10px] text-muted-foreground">总市值</p>
              <p className="text-lg font-semibold tabular-nums">{formatCny(portfolio.totalValue, true)}</p>
            </div>
            <p className={cn('text-right text-[11px] tabular-nums', toneClass(portfolio.totalPnl))}>
              <span className="block">{formatCny(portfolio.totalPnl, true)}</span>
              <span className="block">{portfolio.totalPnlPct == null ? '—' : formatSignedPct(portfolio.totalPnlPct)}</span>
            </p>
          </div>

          {portfolio.exposure.length > 0 && <ExposureBlock exposure={portfolio.exposure} />}

          {portfolio.risks[0] && (
            <p className={cn(
              'flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-[11px] leading-4',
              portfolio.risks[0].level === 'critical'
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-chart-5/30 bg-chart-5/5 text-muted-foreground',
            )}>
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>{portfolio.risks[0].title}</span>
            </p>
          )}

          <section aria-label="主要持仓">
            <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">主要持仓</h3>
            <ul className="space-y-0.5">
              {[...portfolio.positions]
                .sort((a, b) => b.weight - a.weight)
                .slice(0, 3)
                .map((position) => (
                  <li key={position.code}>
                    <button
                      type="button"
                      onClick={() => openSymbol(position.code)}
                      aria-current={symbol === position.code ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-baseline justify-between gap-2 rounded px-1 py-1 text-[11px] transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        symbol === position.code && 'bg-accent/40',
                      )}
                    >
                      <span className="min-w-0 truncate">
                        {position.name}
                        <span className="ml-1 text-[10px] tabular-nums text-muted-foreground">{position.weight.toFixed(1)}%</span>
                      </span>
                      <span className={cn('shrink-0 tabular-nums', toneClass(position.pnl))}>
                        {formatCny(position.pnl, true)}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        </div>
      )}
    </Panel>
  )
}

function ExposureBlock({ exposure }: { exposure: PortfolioView['exposure'] }) {
  const sorted = [...exposure].sort((a, b) => b.weight - a.weight).slice(0, 4)
  return (
    <section aria-label="行业暴露">
      <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">行业暴露</h3>
      <ul className="space-y-1">
        {sorted.map((item) => (
          <li key={item.industry} className="flex items-center gap-2 text-[11px]">
            <span className="w-14 shrink-0 truncate text-muted-foreground">{item.industry}</span>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
              <span className="block h-full rounded-full bg-chart-1/70" style={{ width: `${Math.min(item.weight, 100)}%` }} />
            </span>
            <span className="w-10 shrink-0 text-right tabular-nums">{item.weight.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function TasksPanel({ section, loading, refreshing, onRetry, onRefresh }: CockpitPanelProps<'tasks'>) {
  const { openSymbol } = useCockpitSelection()
  const tasks = section?.ok ? section.data : null
  const pending = tasks ? tasks.alerts.length + tasks.active.length + tasks.failed.length : undefined
  const meta = pending === undefined ? undefined : pending > 0 ? `${pending} 项待处理` : '无待办'

  return (
    <Panel
      id="tasks"
      title="今日任务"
      icon={<ClipboardList />}
      meta={meta}
      action={<PanelActions label="任务" href="/tasks" hrefLabel="任务中心" refreshing={refreshing} onRefresh={onRefresh} />}
    >
      {!tasks ? (
        <SectionFallback section={section} loading={loading} label="今日任务" onRetry={onRetry} />
      ) : pending === 0 ? (
        <PanelEmpty icon={<CheckCircle2 />} title="今天没有待处理项">
          收盘简报与论点复核都已处理完。
        </PanelEmpty>
      ) : (
        <div className="space-y-3 p-4">
          {tasks.alerts.length > 0 && (
            <section aria-label="预警">
              <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">预警</h3>
              <ul className="space-y-1">
                {tasks.alerts.map((alert) => (
                  <li key={alert.id}>
                    <AlertRow alert={alert} onOpenSymbol={openSymbol} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tasks.active.length > 0 && (
            <section aria-label="进行中任务">
              <h3 className="mb-1 text-[11px] font-medium text-muted-foreground">进行中</h3>
              <ul className="space-y-1.5">
                {tasks.active.map((task) => (
                  <li key={task.id}>
                    <Link
                      href="/tasks"
                      className="block rounded-md border px-2 py-1.5 transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate">{taskTypeLabel(task.type)}</span>
                        <span className="shrink-0 text-muted-foreground">{taskStatusLabel(task.status)}</span>
                      </span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-muted">
                        <span className="block h-full rounded-full bg-chart-1 transition-[width] duration-500 motion-reduce:transition-none" style={{ width: `${Math.max(4, Math.min(task.progress, 100))}%` }} />
                      </span>
                      {task.step && <span className="mt-1 block truncate text-[10px] text-muted-foreground">{task.step}</span>}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tasks.failed.length > 0 && (
            <Link href="/tasks" className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] leading-4 text-destructive">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>
                {tasks.failed.length} 个任务失败：{taskTypeLabel(tasks.failed[0].type)}
                {tasks.failed[0].error ? ` · ${tasks.failed[0].error}` : ''}
              </span>
            </Link>
          )}

          {tasks.latestSucceeded && (
            <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <CheckCircle2 className="size-3" aria-hidden="true" />
              最近完成 {taskTypeLabel(tasks.latestSucceeded.type)} · {formatTime(tasks.latestSucceeded.finishedAt || tasks.latestSucceeded.createdAt)}
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}

function AlertRow({ alert, onOpenSymbol }: { alert: AlertView; onOpenSymbol: (code: string) => void }) {
  const body = (
    <>
      <span className={cn('mt-1 size-1.5 shrink-0 rounded-full', SEVERITY_DOT[alert.severity])} aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium">{alert.title}</span>
        <span className="mt-0.5 line-clamp-2 block text-[10px] leading-4 text-muted-foreground">{alert.whyNow || alert.summary}</span>
      </span>
      <ChevronRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
    </>
  )
  const className = 'flex w-full items-start gap-1.5 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

  if (alert.symbolCode) {
    return (
      <button type="button" onClick={() => onOpenSymbol(alert.symbolCode!)} className={className}>
        {body}
      </button>
    )
  }
  return (
    <Link href={`/desk?alert=${encodeURIComponent(alert.id)}`} className={className}>
      {body}
    </Link>
  )
}
