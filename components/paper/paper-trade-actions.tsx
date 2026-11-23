import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PaperSummary } from '@/lib/paper/summary'

async function post(url: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null) as { error?: { message?: string } } | null
  if (!res.ok) throw new Error(json?.error?.message || '操作失败，请稍后重试。')
  return json
}

function clientRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return `card:${c.randomUUID()}`
  return `card:${Date.now()}:${Math.random().toString(36).slice(2)}`
}

function suggestedQty(card: PaperSummary['cards']['items'][number], navCents: number): number {
  const price = card.triggerPriceCents
  if (!price || price <= 0 || navCents <= 0) return 100
  const budget = Math.floor(navCents * Math.max(0, card.maxPositionPctBp) / 10_000)
  const lots = Math.floor(budget / price / 100)
  return Math.max(100, lots * 100)
}

type CardItem = PaperSummary['cards']['items'][number]
type OrderItem = PaperSummary['orders']['recent'][number]

/** 卡片确认：只提交卡 id + 股数，价格与版本由服务端回读，避免前端篡改。 */
export function PaperCardActions({
  card,
  navCents,
  onChanged,
}: {
  card: CardItem
  navCents: number
  onChanged: () => Promise<void> | void
}) {
  const [qty, setQty] = useState(() => String(suggestedQty(card, navCents)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const shares = Number(qty)
  const valid = Number.isSafeInteger(shares) && shares > 0

  async function confirm(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await post('/api/paper/execute', {
        cardId: card.id,
        side: 'buy',
        qty: shares,
        clientRequestId: clientRequestId(),
      })
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '下单失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 sm:justify-end">
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        股数
        <Input
          type="number"
          min={1}
          step={100}
          value={qty}
          disabled={busy}
          aria-label={`${card.symbolName || card.symbolCode} 买入股数`}
          className="h-7 w-24 text-right tabular-nums"
          onChange={(event) => setQty(event.target.value)}
        />
      </label>
      <Button size="sm" disabled={busy || !valid} onClick={() => void confirm()}>
        {busy ? '提交中…' : '确认买入'}
      </Button>
      {error && <p className="ck-form-error w-full" role="alert">{error}</p>}
    </div>
  )
}

/** 撤单只在 09:15 前有效；过期/已冻结由服务端返回冲突并展示原因。 */
export function PaperOrderActions({
  order,
  onChanged,
}: {
  order: OrderItem
  onChanged: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (order.status !== 'confirmed') return null

  async function cancel(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await post('/api/paper/cancel', { orderId: order.id })
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤单失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button variant="ghost" size="xs" disabled={busy} onClick={() => void cancel()}>
        {busy ? '撤销中…' : '撤单'}
      </Button>
      {error && <p className="ck-form-error max-w-48 text-right" role="alert">{error}</p>}
    </div>
  )
}
