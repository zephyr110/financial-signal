import { useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/router'
import type { ThesisStatus, ThesisView } from '@/lib/cockpit/types'
import { thesisStatusLabel } from '@/lib/cockpit/format'

const STATUS_OPTIONS: ThesisStatus[] = ['active', 'strengthened', 'weakened', 'broken', 'review_due']

interface ApiErrorBody {
  error?: {
    message?: string
    details?: { issues?: Array<{ message?: string }> } | null
  }
}

function apiErrorMessage(json: ApiErrorBody, fallback: string): string {
  const issues = json.error?.details?.issues
    ?.map((issue) => issue.message)
    .filter((message): message is string => Boolean(message))
  const base = json.error?.message || fallback
  return issues && issues.length > 0 ? `${base}：${issues.join('；')}` : base
}

export function ThesisComposer({ initial }: { initial?: ThesisView }) {
  const router = useRouter()
  const editing = Boolean(initial)
  const formRef = useRef<HTMLFormElement>(null)
  const [code, setCode] = useState(initial?.code || '')
  const [title, setTitle] = useState(initial?.title || '')
  const [claim, setClaim] = useState(initial?.claim || '')
  const [horizon, setHorizon] = useState(initial?.horizon || '')
  const [status, setStatus] = useState<ThesisStatus>(initial?.status || 'active')
  const [confidence, setConfidence] = useState(initial?.confidence || '中')
  const [invalidation, setInvalidation] = useState((initial?.invalidation || []).join('\n'))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function resetForm() {
    setCode('')
    setTitle('')
    setClaim('')
    setHorizon('')
    setStatus('active')
    setConfidence('中')
    setInvalidation('')
    setError(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const lines = invalidation.split('\n').map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      setError('至少写一条失效条件。')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/cockpit/theses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          id: initial?.id,
          code: code.trim(),
          title: title.trim(),
          claim: claim.trim(),
          horizon: horizon.trim(),
          status,
          confidence,
          invalidation: lines,
        }),
      })
      const json = await res.json() as ApiErrorBody
      if (!res.ok) {
        setError(apiErrorMessage(json, '保存论点失败。'))
        return
      }
      // 表单收在 Disclosure 里；保存后收起并清空草稿，避免误重复提交。
      if (!editing) resetForm()
      if (formRef.current?.closest('details')) {
        (formRef.current.closest('details') as HTMLDetailsElement).open = false
      }
      await router.replace('/research')
    } catch {
      setError('网络连接失败，未保存论点。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="ck-card ck-form"
      id="thesis-composer"
      ref={formRef}
      onSubmit={(event) => void submit(event)}
    >
      <h2 className="ck-form-title">{editing ? '编辑研究论点' : '新建研究论点'}</h2>
      <p className="ck-form-hint">模型只能引用已入库的证据；数字、来源与置信度不由表单以外的内容改写。</p>
      <div className="ck-form-row">
        <div className="ck-field">
          <label className="ck-label" htmlFor="thesis-code">股票代码</label>
          <input
            className="ck-input"
            id="thesis-code"
            value={code}
            required
            maxLength={12}
            placeholder="例如 600519.SH"
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="thesis-title">论点名称</label>
          <input
            className="ck-input"
            id="thesis-title"
            value={title}
            required
            maxLength={80}
            placeholder="例如 高端白酒需求韧性"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="thesis-horizon">时间范围</label>
          <input
            className="ck-input"
            id="thesis-horizon"
            value={horizon}
            required
            maxLength={40}
            placeholder="例如 未来两个季度"
            onChange={(event) => setHorizon(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="thesis-status">状态</label>
          <select
            className="ck-select"
            id="thesis-status"
            value={status}
            onChange={(event) => setStatus(event.target.value as ThesisStatus)}
          >
            {STATUS_OPTIONS.map((option) => (
              <option value={option} key={option}>{thesisStatusLabel(option)}</option>
            ))}
          </select>
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="thesis-confidence">置信度</label>
          <select
            className="ck-select"
            id="thesis-confidence"
            value={confidence}
            onChange={(event) => setConfidence(event.target.value as '低' | '中' | '高')}
          >
            <option value="低">低</option>
            <option value="中">中</option>
            <option value="高">高</option>
          </select>
        </div>
        <div className="ck-field ck-field-full">
          <label className="ck-label" htmlFor="thesis-claim">主张</label>
          <textarea
            className="ck-textarea"
            id="thesis-claim"
            value={claim}
            required
            maxLength={300}
            placeholder="一句话写明你认为会发生什么，以及为什么。"
            onChange={(event) => setClaim(event.target.value)}
          />
        </div>
        <div className="ck-field ck-field-full">
          <label className="ck-label" htmlFor="thesis-invalidation">失效条件（每行一条）</label>
          <textarea
            className="ck-textarea"
            id="thesis-invalidation"
            value={invalidation}
            required
            placeholder={'例如：连续两个季度毛利率低于 60%\n例如：核心产品批价跌破 800 元'}
            onChange={(event) => setInvalidation(event.target.value)}
          />
        </div>
      </div>
      <div className="ck-form-actions">
        <button className="ck-button ck-button-primary" type="submit" disabled={busy}>
          {busy ? '保存中…' : editing ? '保存修改' : '建立论点'}
        </button>
        <button
          className="ck-button ck-button-ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            if (editing) {
              void router.replace('/research')
              return
            }
            if (formRef.current?.closest('details')) {
              (formRef.current.closest('details') as HTMLDetailsElement).open = false
            }
          }}
        >
          取消
        </button>
      </div>
      {error && <p className="ck-form-error" role="alert">{error}</p>}
    </form>
  )
}

const DEMO_THESIS = 'thesis-demo-'

export function ThesisActions({ thesis }: { thesis: ThesisView }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (thesis.id.startsWith(DEMO_THESIS)) {
    return <span className="ck-inline-meta">示例论点只读</span>
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/cockpit/theses?id=${encodeURIComponent(thesis.id)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      })
      const json = await res.json() as ApiErrorBody
      if (!res.ok) {
        // 保持确认态，否则错误提示会随按钮一起被卸载。
        setError(apiErrorMessage(json, '删除论点失败。'))
        return
      }
      await router.replace('/research')
    } catch {
      setError('网络连接失败，未删除。')
    } finally {
      setBusy(false)
    }
  }

  if (!confirming) {
    return (
      <span className="ck-inline-actions">
        <Link className="ck-button ck-button-ghost ck-button-small" href={`/research?edit=${encodeURIComponent(thesis.id)}`}>
          编辑
        </Link>
        <button
          className="ck-button ck-button-ghost ck-button-small"
          type="button"
          onClick={() => setConfirming(true)}
        >
          删除
        </button>
      </span>
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
        {busy ? '删除中…' : '确认删除'}
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
