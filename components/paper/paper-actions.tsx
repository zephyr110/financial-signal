import { useState } from 'react'
import { Pause, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

async function postAction(url: string, body: Record<string, unknown> = {}): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => null) as { error?: { message?: string } } | null
  if (!res.ok) throw new Error(json?.error?.message || '操作失败，请稍后重试。')
}

/** 实验生命周期按钮：暂停需原因，重置先二次确认，恢复沿用原计时。 */
export function PaperActions({
  experimentId,
  status,
  onChanged,
}: {
  experimentId: string
  status: string
  onChanged: () => Promise<void> | void
}) {
  const [mode, setMode] = useState<'idle' | 'pause' | 'reset'>('idle')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: 'start' | 'pause' | 'reset') {
    setBusy(true)
    setError(null)
    try {
      await postAction(`/api/paper/experiments/${encodeURIComponent(experimentId)}/${action}`,
        action === 'pause' ? { reason: reason.trim() } : {})
      setMode('idle')
      setReason('')
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {(status === 'paused' || status === 'planned') && (
          <Button size="sm" disabled={busy} onClick={() => void run('start')}>
            <Play aria-hidden="true" />
            {status === 'planned' ? '开始实验' : '恢复实验'}
          </Button>
        )}
        {status === 'active' && mode !== 'pause' && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setMode('pause')}>
            <Pause aria-hidden="true" />
            暂停实验
          </Button>
        )}
        {(status === 'active' || status === 'paused') && mode !== 'reset' && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode('reset')}>
            <RotateCcw aria-hidden="true" />
            重置
          </Button>
        )}
      </div>

      {mode === 'pause' && (
        <div className="w-full max-w-sm rounded-lg border bg-card p-3 text-left">
          <label className="ck-label" htmlFor="paper-pause-reason">暂停原因</label>
          <Textarea
            id="paper-pause-reason"
            className="mt-1 min-h-16 text-sm"
            value={reason}
            maxLength={300}
            placeholder="例如：数据源连续缺失，先修复再继续"
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode('idle')}>取消</Button>
            <Button size="sm" disabled={busy || !reason.trim()} onClick={() => void run('pause')}>
              {busy ? '暂停中…' : '确认暂停'}
            </Button>
          </div>
        </div>
      )}

      {mode === 'reset' && (
        <div className="w-full max-w-sm rounded-lg border border-destructive/35 bg-destructive/5 p-3 text-left">
          <p className="text-[13px] font-semibold">重置会关闭当前实验</p>
          <p className="mt-1 text-[12px] leading-5 text-muted-foreground">
            旧账户与账本保留只读，新实验从今天重新计时，协议与资金档不变。仍有未结束委托时会被拒绝。
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode('idle')}>取消</Button>
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void run('reset')}>
              {busy ? '重置中…' : '确认重置并开新实验'}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="ck-form-error" role="alert">{error}</p>}
    </div>
  )
}
