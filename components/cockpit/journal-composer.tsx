import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/router'
import { CalendarDays, ChevronDown } from 'lucide-react'
import { zhCN } from 'date-fns/locale'
import type { ThesisView } from '@/lib/cockpit/types'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

const ACTION_OPTIONS = [
  { value: 'watch', label: '继续观察' },
  { value: 'buy', label: '记录买入' },
  { value: 'sell', label: '记录卖出' },
  { value: 'hold', label: '继续持有' },
  { value: 'avoid', label: '选择回避' },
  { value: 'review', label: '复盘旧决定' },
]

const DATE_LABEL = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })

/** 用本地年月日构造，避免 Date 解析 UTC 字符串在非东八区把日期挪一天。 */
function parseDateValue(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return Number.isNaN(date.getTime()) ? undefined : date
}

function dateValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function JournalComposer({
  today,
  theses,
}: {
  today: string
  theses: ThesisView[]
}) {
  const router = useRouter()
  const [entryDate, setEntryDate] = useState(today)
  const [calendarOpen, setCalendarOpen] = useState(false)
  const [action, setAction] = useState('watch')
  const [code, setCode] = useState('')
  const [thesisId, setThesisId] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const entryDateValue = parseDateValue(entryDate)

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
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger
              render={
                <Button
                  className="w-full justify-start gap-2 text-base font-normal md:text-sm"
                  id="journal-date"
                  type="button"
                  variant="outline"
                />
              }
            >
              <CalendarDays className="text-muted-foreground" />
              {entryDateValue ? DATE_LABEL.format(entryDateValue) : '选择日期'}
              <ChevronDown className="ml-auto text-muted-foreground" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-auto p-0">
              <Calendar
                autoFocus
                defaultMonth={entryDateValue}
                locale={zhCN}
                mode="single"
                selected={entryDateValue}
                onSelect={(date) => {
                  if (!date) return
                  setEntryDate(dateValue(date))
                  setCalendarOpen(false)
                }}
              />
            </PopoverContent>
          </Popover>
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="journal-action">动作</label>
          <Select
            items={ACTION_OPTIONS}
            value={action}
            onValueChange={(value) => setAction(value)}
          >
            <SelectTrigger id="journal-action" className="text-base md:text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="journal-code">标的代码（可选）</label>
          <Input
            className="text-base md:text-sm"
            id="journal-code"
            value={code}
            maxLength={20}
            placeholder="例如 600519.SH"
            onChange={(event) => setCode(event.target.value)}
          />
        </div>
        <div className="ck-field">
          <label className="ck-label" htmlFor="journal-thesis">关联论点（可选）</label>
          <Select
            items={[
              { value: '', label: '不关联' },
              ...theses.map((thesis) => ({ value: thesis.id, label: `${thesis.code} · ${thesis.title}` })),
            ]}
            value={thesisId}
            onValueChange={(value) => setThesisId(value)}
          >
            <SelectTrigger id="journal-thesis" className="text-base md:text-sm">
              <SelectValue placeholder="不关联" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">不关联</SelectItem>
              {theses.map((thesis) => (
                <SelectItem key={thesis.id} value={thesis.id}>
                  {thesis.code} · {thesis.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="ck-field ck-field-full">
          <label className="ck-label" htmlFor="journal-reason">理由与当时看到的事实</label>
          <Textarea
            className="min-h-20 text-base md:text-sm"
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
        <Button type="submit" disabled={busy}>
          {busy ? '写入中…' : '写入日志'}
        </Button>
        <span className="ck-inline-meta">最多 500 字</span>
      </div>
      {error && <p className="ck-form-error" role="alert">{error}</p>}
      {success && <p className="ck-form-success" role="status">{success}</p>}
    </form>
  )
}
