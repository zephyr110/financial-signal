import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BadgeCheck, ChevronDown, Loader2, Search, ShieldQuestion, ThumbsDown, ThumbsUp } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import type { AlertView, InvestigationFeedback, InvestigationView, JudgmentView } from '@/lib/desk/types'
import { deskApi } from './api'
import { ConfidenceBadge, SeverityBadge, StanceBadge } from './ui'

export type InvestigationTarget =
  | { kind: 'alert'; alert: AlertView }
  | { kind: 'judgment'; judgment: JudgmentView }

const STATUS_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '深挖中',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const STRENGTH_LABEL: Record<string, string> = {
  thin: '证据偏薄',
  moderate: '证据适中',
  strong: '证据较强',
}

function targetTitle(target: InvestigationTarget): string {
  return target.kind === 'alert' ? target.alert.title : target.judgment.headline
}

export function InvestigationSheet({
  target,
  onClose,
  onChanged,
}: {
  target: InvestigationTarget | null
  onClose: () => void
  onChanged?: () => void
}) {
  const [investigation, setInvestigation] = useState<InvestigationView | null>(null)
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const openedKey = useRef('')

  const match = useCallback(
    (item: InvestigationView) =>
      target?.kind === 'alert' ? item.alertId === target.alert.id : item.judgmentId === target.judgment.id,
    [target],
  )

  const load = useCallback(async () => {
    if (!target) return
    setLoading(true)
    setError('')
    try {
      const data = await deskApi<{ investigations: InvestigationView[] }>('/api/desk/investigations?limit=30')
      const found = data.investigations.find(match) || null
      setInvestigation(found)
      if (found?.status === 'queued' || found?.status === 'running') onChanged?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [target, match, onChanged])

  useEffect(() => {
    if (!target) {
      openedKey.current = ''
      setInvestigation(null)
      setError('')
      return
    }
    const key = target.kind === 'alert' ? `alert:${target.alert.id}` : `judgment:${target.judgment.id}`
    if (openedKey.current !== key) {
      openedKey.current = key
      setInvestigation(null)
      void load()
    }
  }, [target, load])

  // 只轮询尚未完成的调查；组件关闭或结论落地即停止
  useEffect(() => {
    if (!investigation || (investigation.status !== 'queued' && investigation.status !== 'running')) return
    const id = investigation.id
    let stopped = false
    const timer = window.setInterval(async () => {
      try {
        const next = await deskApi<InvestigationView>(`/api/desk/investigations?id=${encodeURIComponent(id)}`)
        if (stopped) return
        setInvestigation(next)
        if (next.status === 'succeeded') onChanged?.()
      } catch {
        // 单次轮询失败不打断；下次继续
      }
    }, 1800)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [investigation, onChanged])

  const start = async () => {
    if (!target) return
    setStarting(true)
    setError('')
    try {
      const payload = target.kind === 'alert'
        ? { alertId: target.alert.id }
        : { judgmentId: target.judgment.id }
      const data = await deskApi<{ investigation: InvestigationView }>('/api/desk/investigations', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      setInvestigation(data.investigation)
      onChanged?.()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setStarting(false)
    }
  }

  const sendFeedback = async (feedback: InvestigationFeedback) => {
    if (!investigation) return
    setFeedbackBusy(true)
    try {
      await deskApi('/api/desk/investigations', {
        method: 'PATCH',
        body: JSON.stringify({ id: investigation.id, feedback }),
      })
      setInvestigation({ ...investigation, feedback })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setFeedbackBusy(false)
    }
  }

  const open = Boolean(target)
  return (
    <Sheet open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <SheetHeader className="relative shrink-0 px-5 py-4 after:pointer-events-none after:absolute after:inset-x-5 after:bottom-0 after:h-px after:bg-border/60 after:content-['']">
          <div className="flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
            <ShieldQuestion className="size-3.5" />
            <span className="tracking-wide">{target?.kind === 'judgment' ? '判断深挖' : '预警深挖'}</span>
            {target?.kind === 'alert' && <SeverityBadge severity={target.alert.severity} />}
            {target?.kind === 'judgment' && <StanceBadge stance={target.judgment.stance} />}
          </div>
          <SheetTitle className="pr-8 text-[17px] font-semibold leading-6 tracking-tight">{target ? targetTitle(target) : ''}</SheetTitle>
          <SheetDescription className="line-clamp-2 text-[13px] leading-5">
            {target?.kind === 'alert' ? target.alert.whyNow : target?.judgment.summary}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />读取调查记录
            </div>
          )}

          {error && (
            <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!loading && !investigation && (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed px-4 py-5">
              <div>
                <p className="text-sm font-medium">这条{target?.kind === 'judgment' ? '判断' : '预警'}还没有深挖记录</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  深挖只读公告、行情与证据，最多 8 步 / 90 秒；结论会附上引用与置信度，不产生交易指令。
                </p>
              </div>
              <Button size="sm" onClick={start} disabled={starting || !target}>
                {starting ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                开始深挖
              </Button>
            </div>
          )}

          {investigation && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={investigation.status === 'succeeded' ? 'secondary' : 'outline'}>
                  {STATUS_LABEL[investigation.status] || investigation.status}
                </Badge>
                {investigation.confidence && <ConfidenceBadge confidence={investigation.confidence} />}
                {investigation.evidenceStrength && (
                  <Badge variant="outline">{STRENGTH_LABEL[investigation.evidenceStrength]}</Badge>
                )}
                <span className="text-[11px] text-muted-foreground">
                  {investigation.stepsUsed} 步 · {investigation.tokensUsed} tokens
                </span>
              </div>

              {(investigation.status === 'queued' || investigation.status === 'running') && (
                <div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-[width] duration-500"
                      style={{ width: `${Math.max(4, investigation.progress)}%` }}
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {investigation.progress}% · 排队或执行中，可关闭面板稍后回看
                  </p>
                </div>
              )}

              {investigation.status === 'failed' && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {investigation.errorMessage || '调查失败'}
                </p>
              )}

              {investigation.conclusion && (
                <div className="markdown-body rounded-lg bg-muted/30 px-4 py-3 text-[13px] leading-6">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{investigation.conclusion}</ReactMarkdown>
                </div>
              )}

              {investigation.steps.length > 0 && (
                <details className="group rounded-lg bg-muted/25">
                  <summary className="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
                    <ChevronDown className="size-3.5 transition-transform duration-200 group-open:rotate-180" />
                    证据与工具步骤（{investigation.steps.length}）
                  </summary>
                  <ol className="space-y-2 px-3 pb-3">
                    {investigation.steps.map((step) => (
                      <li key={step.stepNo} className="text-xs leading-5">
                        <span className="mr-1 text-muted-foreground">#{step.stepNo}</span>
                        <span className="font-medium">{step.tool || step.kind}</span>
                        {!step.ok && <span className="ml-1 text-destructive">失败</span>}
                        <p className="line-clamp-3 text-muted-foreground">{step.digest}</p>
                        {step.refs.length > 0 && (
                          <p className="mt-0.5 flex flex-wrap gap-1">
                            {step.refs.slice(0, 8).map((ref) => (
                              <span key={ref} className="rounded bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{ref}</span>
                            ))}
                          </p>
                        )}
                      </li>
                    ))}
                  </ol>
                </details>
              )}

              {investigation.status === 'succeeded' && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">这条调查有用吗？</span>
                  <Button
                    size="xs"
                    variant={investigation.feedback === 'useful' ? 'secondary' : 'ghost'}
                    disabled={feedbackBusy}
                    onClick={() => void sendFeedback('useful')}
                  >
                    <ThumbsUp className="size-3.5" />有用
                  </Button>
                  <Button
                    size="xs"
                    variant={investigation.feedback === 'wrong' ? 'secondary' : 'ghost'}
                    disabled={feedbackBusy}
                    onClick={() => void sendFeedback('wrong')}
                  >
                    <ThumbsDown className="size-3.5" />不准确
                  </Button>
                  <Button
                    size="xs"
                    variant={investigation.feedback === 'incomplete' ? 'secondary' : 'ghost'}
                    disabled={feedbackBusy}
                    onClick={() => void sendFeedback('incomplete')}
                  >
                    <BadgeCheck className="size-3.5" />不够完整
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
