import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/router'
import type { ThesisView } from '@/lib/cockpit/types'

const ACTION_OPTIONS = [
  { value: 'watch', label: '继续观察' },
  { value: 'buy', label: '记录买入' },
  { value: 'sell', label: '记录卖出' },
  { value: 'hold', label: '继续持有' },
  { value: 'avoid', label: '选择回避' },
  { value: 'review', label: '复盘旧决定' },
]

export function JournalComposer({
  today,
  theses,
}: {
  today: string
  theses: ThesisView[]
}) {
  const router = useRouter()
  const [entryDate, setEntryDate] = useState(today)
  const [action, setAction] = useState('watch')
  const [code, setCode] = useState('')
  const [thesisId, setThesisId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSuccess(null)
    const text = reason.trim()
    if (!text) {
      setError('请写下做出这个决定时看到的事实。')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/cockpit/journal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          entryDate,
          action,
          code: code.trim() || undefined,
          thesisId: thesisId || undefined,
          reason: text,
        }),
      })
      const json = await res.json() as { error?: { message?: string } }
      if (!res.ok) {
        setError(json.error?.message || '写入失败，请稍后再试。')
        return
      }
      setReason('')
      setCode('')
      setThesisId('')
      setSuccess('已写入研究日志。')
      await router.replace(router.asPath)
    } catch {
      setError('网络连接失败，记录未保存。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ck-card ck-form" onSubmit={(event) => void submit(event)}>
      <h2 className="ck-form-title">记录今天的决定</h2>
      <p className="ck-form-hint">写清当时的依据与反证。日志是给自己看的事实，不是给市场看的结论。</p>
      <div className="ck-form-row">
        <div className="ck-field">
          <label className="ck-label" htmlFor="journal-date">日期</label>
          <input
            className="ck-input"
            id="journal-date"
            type="date"
            value={entryDate}
            required
            onChange={(event) => setEntryDate(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="journal-action">动作</label>
          <select
            className="ck-select"
            id="journal-action"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          >
            {ACTION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="journal-code">标的代码（可选）</label>
          <input
            className="ck-input"
            id="journal-code"
            value={code}
            maxLength={20}
            placeholder="例如 600519.SH"
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="journal-thesis">关联论点（可选）</label>
          <select
            className="ck-select"
            id="journal-thesis"
            value={thesisId}
            onChange={(event) => setThesisId(event.target.value)}
          >
            <option value="">不关联</option>
            {theses.map((thesis) => (
              <option key={thesis.id} value={thesis.id}>
                {thesis.code} · {thesis.title}
              </option>
            ))}
          </select>
        </div>
        <div className="ck-field ck-field-full">
          <label className="ck-label" htmlFor="journal-reason">理由与当时看到的事实</label>
          <textarea
            className="ck-textarea"
            id="journal-reason"
            value={reason}
            required
            maxLength={500}
            placeholder="我看到了什么？哪些证据支持？最有力的反证是什么？"
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
      </div>
      <div className="ck-form-actions">
        <button className="ck-button ck-button-primary" type="submit" disabled={busy}>
          {busy ? '写入中…' : '写入日志'}
        </button>
        <span className="ck-inline-meta">最多 500 字</span>
      </div>
      {error && <p className="ck-form-error" role="alert">{error}</p>}
      {success && <p className="ck-form-success" role="status">{success}</p>}
    </form>
  )
}
