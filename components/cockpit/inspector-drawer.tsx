import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Bot, FileText, Loader2, RefreshCw } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { useIsMobile } from '@/hooks/use-mobile'
import { formatPrice, formatSignedPct, thesisStatusLabel } from '@/lib/cockpit/format'
import type { StockDetail } from '@/lib/cockpit/types'
import { cn } from '@/lib/utils'
import { useCockpitSelection } from './selection-context'

interface ThreadDetail {
  id: number
  title: string
  narrative: string
  stage?: string
  confidence?: string
  industries?: string[]
  watch_points?: string[]
  signals?: Array<{ id: number; summary: string; published_at?: string }>
}

interface DrawerState {
  loading: boolean
  error: string
  stock: StockDetail | null
  thread: ThreadDetail | null
}

const EMPTY_STATE: DrawerState = { loading: false, error: '', stock: null, thread: null }

const STAGE_LABEL: Record<string, string> = {
  early: '早期',
  brewing: '发酵中',
  spreading: '全面扩散',
  priced_in: '成熟定价',
}

function toneClass(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-muted-foreground'
  return value > 0 ? 'text-chart-3' : 'text-chart-2'
}

export function InspectorDrawer() {
  const { symbol, thread, open, clear } = useCockpitSelection()
  const isMobile = useIsMobile()
  const [state, setState] = useState<DrawerState>(EMPTY_STATE)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (!symbol && !thread) {
      setState(EMPTY_STATE)
      return
    }
    const controller = new AbortController()
    setState((prev) => ({ ...prev, loading: true, error: '' }))
    const url = symbol
      ? `/api/cockpit/stocks/${encodeURIComponent(symbol)}`
      : `/api/thread/${thread}`
    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(body?.error?.message || body?.error || '读取失败')
        return body
      })
      .then((body) => {
        if (symbol) setState({ loading: false, error: '', stock: body.data as StockDetail, thread: null })
        else setState({ loading: false, error: '', stock: null, thread: body as ThreadDetail })
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return
        setState({ loading: false, error: err.message || '读取失败', stock: null, thread: null })
      })
    return () => controller.abort()
  }, [symbol, thread, reloadKey])

  const retry = useCallback(() => setReloadKey((key) => key + 1), [])
  const askCopilot = useCallback(() => {
    if (!symbol) return
    window.dispatchEvent(new CustomEvent('cockpit:copilot-open', { detail: { symbol } }))
  }, [symbol])

  const title = symbol ? state.stock?.name || symbol : state.thread?.title || (thread ? `线索 #${thread}` : '')
  const subtitle = symbol
    ? [state.stock?.code || symbol, state.stock?.industry].filter(Boolean).join(' · ')
    : state.thread?.stage
      ? STAGE_LABEL[state.thread.stage] || state.thread.stage
      : '事件线索'

  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) clear() }}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className={cn(
          'gap-0 p-0 motion-reduce:transition-none',
          isMobile ? 'h-[85dvh] max-w-none rounded-t-xl' : 'w-full sm:max-w-[480px]',
        )}
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="truncate text-sm">{title || '详情'}</SheetTitle>
          <SheetDescription className="truncate text-xs">{subtitle}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {state.loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              加载中…
            </div>
          ) : state.error ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center" role="alert">
              <p className="px-6 text-xs text-muted-foreground">{state.error}</p>
              <Button size="sm" variant="outline" onClick={retry}>
                <RefreshCw className="size-3.5" />重试
              </Button>
            </div>
          ) : state.stock ? (
            <StockBody stock={state.stock} onAskCopilot={askCopilot} />
          ) : state.thread ? (
            <ThreadBody thread={state.thread} />
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function StockBody({ stock, onAskCopilot }: { stock: StockDetail; onAskCopilot: () => void }) {
  return (
    <div className="space-y-4 p-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-2xl font-semibold tabular-nums">{stock.price == null ? '—' : formatPrice(stock.price)}</p>
          <p className={cn('text-xs tabular-nums', toneClass(stock.changePct))}>
            {stock.changePct == null ? '暂无涨跌数据' : formatSignedPct(stock.changePct)}
          </p>
        </div>
        {stock.thesis && (
          <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
            {thesisStatusLabel(stock.thesis.status)}
          </Badge>
        )}
      </div>

      {stock.thesis && (
        <div className="rounded-lg border bg-muted/30 p-3">
          <p className="text-xs font-medium">{stock.thesis.title}</p>
          <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{stock.thesis.claim}</p>
        </div>
      )}

      <section aria-label="证据">
        <h3 className="mb-2 text-[11px] font-medium text-muted-foreground">证据</h3>
        {stock.evidence.length ? (
          <ul className="space-y-2">
            {stock.evidence.slice(0, 4).map((item) => (
              <li key={item.id} className="rounded-md border px-3 py-2">
                <p className="text-xs font-medium">{item.label}</p>
                {item.detail && <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{item.detail}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">还没有可引用的证据。</p>
        )}
      </section>

      {stock.documents.length > 0 && (
        <section aria-label="相关公告">
          <h3 className="mb-2 text-[11px] font-medium text-muted-foreground">公告</h3>
          <ul className="space-y-1.5">
            {stock.documents.slice(0, 3).map((doc) => (
              <li key={doc.id} className="flex items-start gap-1.5 text-xs leading-5">
                <FileText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="line-clamp-2">{doc.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Link href={`/stock/${stock.code}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
          打开完整页<ArrowUpRight className="size-3.5" />
        </Link>
        <Button size="sm" variant="secondary" onClick={onAskCopilot}>
          <Bot className="size-3.5" />问 Copilot
        </Button>
      </div>
    </div>
  )
}

function ThreadBody({ thread }: { thread: ThreadDetail }) {
  return (
    <div className="space-y-4 p-4">
      <p className="text-[13px] leading-6">{thread.narrative}</p>
      {thread.industries?.length ? (
        <div className="flex flex-wrap gap-1.5">
          {thread.industries.map((industry) => (
            <Badge key={industry} variant="secondary" className="h-5 px-1.5 text-[10px]">{industry}</Badge>
          ))}
        </div>
      ) : null}
      {thread.watch_points?.length ? (
        <section aria-label="观察要点">
          <h3 className="mb-2 text-[11px] font-medium text-muted-foreground">观察要点</h3>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-muted-foreground">
            {thread.watch_points.slice(0, 5).map((point) => <li key={point}>{point}</li>)}
          </ul>
        </section>
      ) : null}
      <Link href={`/thread/${thread.id}`} className={buttonVariants({ size: 'sm', variant: 'outline' })}>
        打开线索全文<ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  )
}
