import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/router'

export function WatchlistEditor() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSuccess(null)
    setBusy(true)
    try {
      const res = await fetch('/api/cockpit/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code: code.trim(), note: note.trim() || undefined }),
      })
      const json = await res.json() as { error?: { message?: string } }
      if (!res.ok) {
        setError(json.error?.message || '加入自选失败。')
        return
      }
      setCode('')
      setNote('')
      setSuccess('已加入自选；下一次行情入库后补齐价格与走势。')
      await router.replace(router.asPath)
    } catch {
      setError('网络连接失败，未写入自选。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ck-card ck-form" onSubmit={(event) => void submit(event)}>
      <h2 className="ck-form-title">加入观察名单</h2>
      <p className="ck-form-hint">只登记需要持续验证的标的；没有行情时页面会明确显示待入库，不补造价格。</p>
      <div className="ck-form-row">
        <div className="ck-field">
          <label className="ck-label" htmlFor="watch-code">股票代码</label>
          <input
            className="ck-input"
            id="watch-code"
            value={code}
            required
            maxLength={12}
            placeholder="例如 600519 或 600519.SH"
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="ck-field ck-field-full">
          <label className="ck-label" htmlFor="watch-note">观察理由（可选）</label>
          <input
            className="ck-input"
            id="watch-note"
            value={note}
            maxLength={200}
            placeholder="例如：等待季度毛利率确认"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
      </div>
      <div className="ck-form-actions">
        <button className="ck-button ck-button-primary" type="submit" disabled={busy}>
          {busy ? '写入中…' : '加入自选'}
        </button>
        <span className="ck-inline-meta">代码支持 6 位数字或带交易所后缀</span>
      </div>
      {error && <p className="ck-form-error" role="alert">{error}</p>}
      {success && <p className="ck-form-success" role="status">{success}</p>}
    </form>
  )
}

export function WatchlistRemove({ code, name }: { code: string; name: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/cockpit/watchlist?code=${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      })
      const json = await res.json() as { error?: { message?: string } }
      if (!res.ok) {
        setError(json.error?.message || '移除失败。')
        return
      }
      await router.replace(router.asPath)
    } catch {
      setError('网络连接失败，未移除。')
    } finally {
      // 失败时保持确认态，否则错误提示会随按钮一起被卸载。
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <button
        className="ck-button ck-button-ghost ck-button-small"
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`从自选移除 ${name}`}
      >
        移除
      </button>
    )
  }
  return (
    <span className="ck-inline-actions">
      <button
        className="ck-button ck-button-danger ck-button-small"
        type="button"
        disabled={busy}
        onClick={() => void remove()}
      >
        {busy ? '移除中…' : `确认移除 ${name}`}
      </button>
      <button
        className="ck-button ck-button-ghost ck-button-small"
        type="button"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        取消
      </button>
      {error && <span className="ck-form-error" role="alert">{error}</span>}
    </span>
  )
}
