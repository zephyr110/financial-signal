import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/router'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function PortfolioEditor() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [shares, setShares] = useState('')
  const [cost, setCost] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setSuccess(null)
    const shareText = shares.trim()
    const shareCount = Number(shareText)
    if (!/^\d+$/.test(shareText) || !Number.isSafeInteger(shareCount) || shareCount <= 0) {
      setError('股数需为正整数。')
      return
    }
    const costText = cost.trim()
    if (!/^\d+(?:\.\d{1,2})?$/.test(costText)) {
      setError('成本价需为不小于 0 的数字，最多两位小数。')
      return
    }
    const [yuan, fraction = ''] = costText.split('.')
    const avgCostCents = Number(yuan) * 100 + Number(fraction.padEnd(2, '0'))
    if (!Number.isSafeInteger(avgCostCents)) {
      setError('成本价超出可记录范围。')
      return
    }
    setBusy(true)
    try {
      const res = await fetch('/api/cockpit/portfolio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code: code.trim(), shares: shareCount, avgCostCents }),
      })
      const json = await res.json() as { error?: { message?: string } }
      if (!res.ok) {
        setError(json.error?.message || '保存持仓失败。')
        return
      }
      setCode('')
      setShares('')
      setCost('')
      setSuccess('已写入持仓；最新价与盈亏等行情入库后补齐。')
      await router.replace(router.asPath)
    } catch {
      setError('网络连接失败，未写入持仓。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="ck-card ck-form" onSubmit={(event) => void submit(event)}>
      <h2 className="ck-form-title">录入或更新持仓</h2>
      <p className="ck-form-hint">
        同一代码再次提交会覆盖股数与成本。真实持仓写入独立账户，不会与示例数据混用。
      </p>
      <div className="ck-form-row">
        <div className="ck-field">
          <label className="ck-label" htmlFor="position-code">股票代码</label>
          <Input
            className="text-base md:text-sm"
            id="position-code"
            value={code}
            required
            maxLength={12}
            placeholder="例如 600519.SH"
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="position-shares">股数</label>
          <Input
            className="text-base md:text-sm"
            id="position-shares"
            value={shares}
            required
            inputMode="numeric"
            placeholder="100"
            onChange={(event) => setShares(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="position-cost">成本价（元）</label>
          <Input
            className="text-base md:text-sm"
            id="position-cost"
            value={cost}
            required
            inputMode="decimal"
            placeholder="例如 1420.50"
            onChange={(event) => setCost(event.target.value)}
          />
        </div>
      </div>
      <div className="ck-form-actions">
        <Button type="submit" disabled={busy}>
          {busy ? '写入中…' : '保存持仓'}
        </Button>
        <span className="ck-inline-meta">成本最多保留两位小数</span>
      </div>
      {error && <p className="ck-form-error" role="alert">{error}</p>}
      {success && <p className="ck-form-success" role="status">{success}</p>}
    </form>
  )
}

export function PortfolioRemove({ code, name }: { code: string; name: string }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/cockpit/portfolio?code=${encodeURIComponent(code)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      })
      const json = await res.json() as { error?: { message?: string } }
      if (!res.ok) {
        setError(json.error?.message || '移除持仓失败。')
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
      <Button
        variant="ghost"
        size="icon-sm"
        className="ck-row-action"
        type="button"
        onClick={() => setConfirming(true)}
        aria-label={`移除持仓 ${name}`}
        title="移除持仓"
      >
        <Trash2 aria-hidden="true" />
      </Button>
    )
  }
  return (
    <span className="ck-inline-actions">
      <Button
        variant="destructive"
        size="sm"
        type="button"
        disabled={busy}
        onClick={() => void remove()}
      >
        {busy ? '移除中…' : '确认移除'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        取消
      </Button>
      {error && <span className="ck-form-error" role="alert">{error}</span>}
    </span>
  )
}
