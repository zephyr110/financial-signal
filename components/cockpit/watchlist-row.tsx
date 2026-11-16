import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown, Loader2 } from 'lucide-react'
import type { StockDetail, WatchlistItem } from '@/lib/cockpit/types'
import { formatPrice } from '@/lib/cockpit/format'
import { watchAnchorId } from '@/lib/cockpit/anchor'
import { Button, buttonVariants } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { DeltaValue, SourceChip, Sparkline, ThesisTag } from './bits'
import { DocumentList } from './document-list'
import { EvidenceSpine } from './evidence-spine'
import { ThesisCard } from './thesis-card'
import { WatchlistRemove } from './watchlist-editor'

type DetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; detail: StockDetail }

function backfillLabel(status: WatchlistItem['backfill']): string {
  if (status === 'queued' || status === 'running') return '行情自动补齐中'
  if (status === 'failed') return '上次补库失败，下次行情入库时重试'
  return '行情待入库'
}

/** 自选行：点击整行原地展开证据，避免离开列表后再折返。 */
export function WatchlistRow({ item }: { item: WatchlistItem }) {
  const [open, setOpen] = useState(false)
  const [detail, setDetail] = useState<DetailState>({ status: 'idle' })
  const panelId = `watch-detail-${item.code.replace(/[^A-Za-z0-9_-]/g, '-')}`

  async function load() {
    setDetail({ status: 'loading' })
    try {
      const res = await fetch(`/api/cockpit/stocks/${encodeURIComponent(item.code)}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      })
      const json = await res.json() as { data?: StockDetail; error?: { message?: string } }
      if (!res.ok || !json.data) {
        setDetail({ status: 'error', message: json.error?.message || '读取个股证据失败。' })
        return
      }
      setDetail({ status: 'ready', detail: json.data })
    } catch {
      setDetail({ status: 'error', message: '网络连接失败，未能读取个股证据。' })
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && detail.status === 'idle') void load()
  }

  return (
    <article className="ck-watch-row" id={watchAnchorId(item.code)}>
      <button
        type="button"
        className="ck-watch-main"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <div className="ck-watch-copy">
          <div className="ck-watch-code">
            <span>{item.code}</span>
            {/* 名称未入库时回退为代码，这里不再重复显示。 */}
            {item.name !== item.code && (
              <span className="ck-watch-name">{item.name}</span>
            )}
          </div>
          <div className="ck-watch-meta">
            {item.thesisStatus && <ThesisTag status={item.thesisStatus} />}
            <SourceChip source={item.source} link={false} />
            {item.nextEvent && <span>下一事件：{item.nextEvent}</span>}
            {item.price === null && <span>{backfillLabel(item.backfill)}</span>}
          </div>
          {item.note && <p className="ck-watch-note">{item.note}</p>}
        </div>
        <div className="ck-watch-side">
          <p className={`ck-watch-price${item.price === null ? ' is-pending' : ''}`}>
            {item.price === null
              ? (item.backfill === 'queued' || item.backfill === 'running' ? '补齐中' : '待入库')
              : formatPrice(item.price)}
          </p>
          {item.price !== null && <DeltaValue value={item.changePct} />}
          {item.sparkline.length > 1 && (
            <div className="ck-watch-spark">
              <Sparkline
                values={item.sparkline}
                changePct={item.changePct}
                label={`${item.name}近 ${item.sparkline.length} 个交易日走势`}
              />
            </div>
          )}
          <span className="ck-sr-only">{open ? '收起' : '展开'}个股详情</span>
        </div>
      </button>

      {/* 折叠与移除按钮同排同尺寸，默认隐藏，悬停整行时才浮现 */}
      <div className="ck-watch-action">
        <Hint content={open ? '收起详情' : '展开详情'}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ck-watch-toggle"
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={`${open ? '收起' : '展开'}${item.name}个股详情`}
            onClick={toggle}
          >
            <ChevronDown className={`ck-watch-chevron${open ? ' is-open' : ''}`} aria-hidden="true" />
          </Button>
        </Hint>
        <WatchlistRemove code={item.code} name={item.name} />
      </div>

      <div
        className={`ck-watch-expand${open ? ' is-open' : ''}`}
        id={panelId}
        inert={!open}
      >
        <div className="ck-watch-expand-inner">
          {detail.status === 'loading' && (
            <p className="ck-watch-detail-status" role="status">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              正在读取已入库证据…
            </p>
          )}
          {detail.status === 'error' && (
            <div className="ck-watch-detail-status" role="alert">
              <span>{detail.message}</span>
              <Button size="sm" variant="outline" type="button" onClick={() => void load()}>
                重试
              </Button>
            </div>
          )}
          {detail.status === 'ready' && (
            <div className="ck-watch-detail">
              <section className="ck-watch-detail-sec">
                <h3 className="ck-watch-detail-title">证据链</h3>
                {detail.detail.evidence.length > 0 ? (
                  <EvidenceSpine items={detail.detail.evidence} />
                ) : (
                  <p className="ck-inline-meta">暂无已入库证据。</p>
                )}
              </section>
              <section className="ck-watch-detail-sec">
                <h3 className="ck-watch-detail-title">当前论点</h3>
                {detail.detail.thesis ? (
                  <ThesisCard thesis={detail.detail.thesis} />
                ) : (
                  <p className="ck-inline-meta">尚未建立可推翻的论点。</p>
                )}
              </section>
              <section className="ck-watch-detail-sec">
                <h3 className="ck-watch-detail-title">相关公告</h3>
                <DocumentList
                  documents={detail.detail.documents.slice(0, 3)}
                  emptyText="当前没有与该个股关联的已入库公告。"
                />
                {detail.detail.documents.length > 3 && (
                  <p className="ck-inline-meta">仅显示最近 3 条，完整列表见个股页。</p>
                )}
              </section>
            </div>
          )}
          {/* 详情加载失败或尚未入库时也要留出口，否则整行按钮化后无处可去 */}
          <div className="ck-watch-detail-foot">
            <Link
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              href={`/stock/${encodeURIComponent(item.code)}`}
            >
              查看完整个股页
            </Link>
          </div>
        </div>
      </div>
    </article>
  )
}
