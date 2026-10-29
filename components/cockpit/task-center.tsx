import { useEffect, useState } from 'react'
import {
  CalendarRange,
  Database,
  FileText,
  ListChecks,
  RefreshCw,
  type LucideIcon,
} from 'lucide-react'
import type { TaskRecord } from '@/lib/cockpit/types'
import { formatCost, formatTime, taskStatusLabel, thesisStatusLabel } from '@/lib/cockpit/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Disclosure, closeDisclosure } from './bits'

const TYPE_LABEL: Record<string, string> = {
  daily_brief: '收盘简报',
  daily_close: '收盘全链路',
  market_ingest: '行情入库',
  akshare_ingest: 'T2 补充入库',
  thesis_review: '论点复核',
  ask: '向简报提问',
  weekly_review: '周度复盘',
  symbol_deep_dive: '个股深挖',
}

const QUICK_ACTIONS: Array<{
  type: string
  params: Record<string, unknown>
  title: string
  hint: string
  icon: LucideIcon
}> = [
  {
    type: 'daily_brief',
    params: {},
    title: '生成今日简报',
    hint: '事实→校验→版本',
    icon: FileText,
  },
  {
    type: 'thesis_review',
    params: {},
    title: '复核全部论点',
    hint: '更新复核时间与反证',
    icon: ListChecks,
  },
  {
    type: 'weekly_review',
    params: {},
    title: '生成周度复盘',
    hint: '持仓、论点汇总',
    icon: CalendarRange,
  },
  {
    type: 'daily_brief',
    params: { force: true },
    title: '重算并发布新版本',
    hint: '旧版保留，版本递增',
    icon: RefreshCw,
  },
  {
    type: 'akshare_ingest',
    params: {},
    title: '补充 T2 行情',
    hint: 'AKShare 侧车 · 不覆盖 T0/T1',
    icon: Database,
  },
]

function warningsText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).filter(Boolean).join('\n') : ''
}

interface TaskResultView {
  title: string
  body: string
}

function resultView(task: TaskRecord): TaskResultView | null {
  const result = task.result
  if (!result) return null
  switch (task.type) {
    case 'daily_brief':
      return {
        title: `简报 v${String(result.version ?? '—')} · ${String(result.tradeDate ?? '')}`,
        body: [result.claim, result.confidence ? `置信度：${String(result.confidence)}` : '']
          .filter(Boolean)
          .join('\n'),
      }
    case 'daily_close': {
      const ingest = result.ingest && typeof result.ingest === 'object'
        ? result.ingest as Record<string, unknown>
        : {}
      return {
        title: `简报 v${String(result.version ?? '—')} · ${String(result.tradeDate ?? '')}`,
        body: [
          result.claim ? String(result.claim) : '',
          `行情 ${String(ingest.bars ?? 0)} 根日线 · 公告 ${String(result.documents ?? 0)} 条`,
          warningsText(result.warnings),
        ].filter(Boolean).join('\n'),
      }
    }
    case 'market_ingest':
      return {
        title: `行情入库 ${String(result.tradeDate ?? '')}`,
        body: [
          `${String(result.bars ?? 0)} 根日线 · ${String(result.indices ?? 0)} 个指数`,
          result.limitUpDownAvailable === false ? '涨跌停统计不可用' : '',
          warningsText(result.warnings),
        ].filter(Boolean).join('\n'),
      }
    case 'akshare_ingest':
      return {
        title: `T2 补充入库 ${String(result.tradeDate ?? '')}`,
        body: result.configured === false
          ? '未配置侧车：设置 AKSHARE_SIDECAR_URL 与 AKSHARE_SIDECAR_TOKEN 后重试。'
          : [
            `${String(result.insertedBars ?? 0)}/${String(result.bars ?? 0)} 根日线新增 · 涨停池 ${String(result.limitPoolWritten ?? 0)} 条`,
            warningsText(result.warnings),
          ].filter(Boolean).join('\n'),
      }
    case 'thesis_review':
      return {
        title: `已复核 ${String(result.reviewed ?? 0)} 条论点`,
        body: [
          result.weakened ? `其中 ${String(result.weakened)} 条出现反证` : '未发现新的反证',
          Array.isArray(result.codes) && result.codes.length ? `涉及：${result.codes.join('、')}` : '',
        ].filter(Boolean).join('\n'),
      }
    case 'ask':
      return {
        title: String(result.question || '简报问答'),
        body: [
          String(result.answer || ''),
          Array.isArray(result.citations) && result.citations.length
            ? `引用：${result.citations.map((citation) => {
              if (citation && typeof citation === 'object' && 'name' in citation) return String(citation.name)
              return String(citation)
            }).join('、')}`
            : '',
        ].filter(Boolean).join('\n'),
      }
    case 'weekly_review':
      return {
        title: '周度结构汇总',
        body: [
          result.note ? String(result.note) : '',
          `持仓 ${String(result.positions ?? 0)} 只 · 论点 ${String(result.theses ?? 0)} 条 · 日志 ${String(result.journalEntries ?? 0)} 条`,
        ].filter(Boolean).join('\n'),
      }
    case 'symbol_deep_dive':
      return {
        title: `${String(result.name ?? '')} ${String(result.code ?? '')}`,
        body: [
          result.price !== null && result.price !== undefined ? `最新价 ${String(result.price)}` : '暂无最新行情',
          result.thesisStatus ? `论点状态：${thesisStatusLabel(String(result.thesisStatus))}` : '',
          Array.isArray(result.evidence) ? `${result.evidence.length} 条证据已归档。` : '',
        ].filter(Boolean).join('\n'),
      }
    default:
      return { title: '任务完成', body: JSON.stringify(result, null, 2).slice(0, 600) }
  }
}

export function TaskCenter({ initialTasks }: { initialTasks: TaskRecord[] }) {
  const [tasks, setTasks] = useState<TaskRecord[]>(initialTasks)
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [code, setCode] = useState('')
  const hasActive = tasks.some((task) => task.status === 'queued' || task.status === 'running')

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let controller: AbortController | null = null
    let failures = 0
    let idleTicks = 0
    // 空闲也要轮询，否则页面打开后 cron 入队的任务永远不会出现。
    let previousActive = new Set(
      initialTasks.filter((task) => task.status === 'queued' || task.status === 'running').map((task) => task.id),
    )

    const loadFull = async () => {
      const res = await fetch('/api/cockpit/tasks?limit=50', { headers: { Accept: 'application/json' } })
      if (!res.ok) throw new Error('task list failed')
      const json = await res.json() as { data?: TaskRecord[] }
      if (!cancelled && Array.isArray(json.data)) setTasks(json.data)
    }

    const tick = async () => {
      controller = new AbortController()
      try {
        const res = await fetch('/api/cockpit/tasks?active=1', {
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('active task poll failed')
        const json = await res.json() as { data?: TaskRecord[] }
        if (cancelled) return
        failures = 0
        const active = Array.isArray(json.data) ? json.data : []
        const activeIds = new Set(active.map((task) => task.id))
        // 已知活跃任务消失说明它已完成/失败，需全量刷新拿到最终结果。
        const disappeared = [...previousActive].some((id) => !activeIds.has(id))
        previousActive = activeIds

        if (active.length > 0) {
          idleTicks = 0
          setTasks((current) => {
            const merged = new Map(current.map((task) => [task.id, task]))
            for (const task of active) merged.set(task.id, task)
            return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          })
          if (disappeared) await loadFull()
          if (cancelled) return
          timer = setTimeout(tick, 2500)
          return
        }

        idleTicks += 1
        // 空闲低频刷新兜底：任务可能在两次轮询之间完成，也要出现在流水里。
        if (disappeared || idleTicks % 4 === 0) await loadFull()
        if (cancelled) return
        timer = setTimeout(tick, 15000)
      } catch (err) {
        if (cancelled || (err instanceof Error && err.name === 'AbortError')) return
        failures += 1
        if (failures >= 5) {
          setError('自动刷新连续失败，正在降低刷新频率。')
          failures = 0
          timer = setTimeout(tick, 60000)
          return
        }
        timer = setTimeout(tick, Math.min(3000 * 2 ** failures, 30000))
      }
    }

    timer = setTimeout(tick, 800)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      controller?.abort()
    }
    // initialTasks 只用于初始化活跃集合；后续状态由轮询接管。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function run(
    type: string,
    params: Record<string, unknown> = {},
    form?: HTMLFormElement | null,
  ) {
    setBusy(type)
    setError(null)
    setMessage(null)
    try {
      const res = await fetch('/api/cockpit/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ type, params }),
      })
      const json = await res.json() as { data?: TaskRecord; error?: { message?: string } }
      if (!res.ok || !json.data) {
        setError(json.error?.message || '任务派发失败，请稍后再试。')
        return
      }
      const created = json.data
      setTasks((current) => {
        const existing = current.findIndex((task) => task.id === created.id)
        if (existing >= 0) {
          const copy = [...current]
          copy[existing] = created
          return copy
        }
        return [created, ...current]
      })
      if (created.status === 'succeeded') {
        setMessage('相同参数的任务已完成，未重复执行；结果见下方流水。')
      } else if (created.status === 'running') {
        setMessage('相同参数的任务正在执行，完成后可在此查看结果。')
      } else {
        setMessage('任务已进入队列，完成后可在此查看结果。')
      }
      if (type === 'ask') setQuestion('')
      if (type === 'symbol_deep_dive') setCode('')
      // 只收起刚提交的表单，并让键盘焦点回到它的标题；其它展开的表单保持原样。
      if (form) closeDisclosure(form)
    } catch {
      setError('网络连接失败，任务未派发。')
    } finally {
      setBusy(null)
    }
  }

  async function cancel(id: string) {
    setBusy(id)
    setError(null)
    try {
      const res = await fetch(`/api/cockpit/tasks/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      })
      const json = await res.json() as { data?: TaskRecord; error?: { message?: string } }
      if (!res.ok || !json.data) {
        setError(json.error?.message || '取消失败。')
        return
      }
      setTasks((current) => current.map((task) => (task.id === id ? json.data! : task)))
    } catch {
      setError('网络连接失败，未能取消。')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <section className="ck-card ck-task-composer" aria-labelledby="task-composer-title">
        <div className="ck-task-composer-head">
          <h2 className="ck-task-composer-title" id="task-composer-title">快速派发</h2>
          <p className="ck-task-composer-hint">串行执行，结果写入研究记录；同参数不会重复计费。</p>
        </div>
        <div className="ck-task-grid">
          {QUICK_ACTIONS.map((action) => {
            const Icon = action.icon
            return (
              <Button
                key={`${action.type}:${action.title}`}
                variant="outline"
                className="ck-task-quick"
                type="button"
                disabled={Boolean(busy)}
                onClick={() => run(action.type, action.params)}
              >
                <span className="ck-task-quick-icon">
                  <Icon aria-hidden="true" />
                </span>
                <span className="ck-task-quick-copy">
                  <strong>{action.title}</strong>
                  <span>{action.hint}</span>
                </span>
              </Button>
            )
          })}
        </div>

        <div className="ck-task-forms">
          <Disclosure title="向最新简报提问" hint="只引用已校验证据" headingLevel={3}>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const value = question.trim()
                if (!value) {
                  setError('请先写下问题。')
                  return
                }
                void run('ask', { question: value }, event.currentTarget)
              }}
            >
              <div className="ck-field">
                <label className="ck-label" htmlFor="task-question">问题</label>
                <Textarea
                  className="min-h-20 text-base md:text-sm"
                  id="task-question"
                  value={question}
                  maxLength={2000}
                  placeholder="例如：今天指数上涨，但上涨家数偏少，这个背离意味着什么？"
                  onChange={(event) => setQuestion(event.target.value)}
                />
              </div>
              <div className="ck-form-actions">
                <Button type="submit" disabled={Boolean(busy)}>
                  {busy === 'ask' ? '派发中…' : '提交问题'}
                </Button>
              </div>
            </form>
          </Disclosure>

          <Disclosure title="个股深挖" hint="读取已入库的行情、公告与论点" headingLevel={3}>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                const value = code.trim().toUpperCase()
                if (!value) {
                  setError('请填写股票代码。')
                  return
                }
                void run('symbol_deep_dive', { code: value }, event.currentTarget)
              }}
            >
              <div className="ck-field">
                <label className="ck-label" htmlFor="task-code">股票代码</label>
                <Input
                  className="text-base md:text-sm"
                  id="task-code"
                  value={code}
                  maxLength={20}
                  placeholder="例如 600519.SH"
                  onChange={(event) => setCode(event.target.value)}
                />
              </div>
              <div className="ck-form-actions">
                <Button variant="outline" type="submit" disabled={Boolean(busy)}>
                  {busy === 'symbol_deep_dive' ? '派发中…' : '开始深挖'}
                </Button>
              </div>
            </form>
          </Disclosure>
        </div>

        {error && <p className="ck-form-error" role="alert">{error}</p>}
        {message && <p className="ck-form-success" role="status">{message}</p>}
      </section>

      <section className="ck-section" aria-labelledby="task-list-title">
        <div className="ck-section-head">
          <div className="ck-section-head-main">
            <h2 className="ck-section-title" id="task-list-title">
              任务流水 <span className="ck-section-count">{tasks.length}</span>
            </h2>
            <p className="ck-section-detail">
              {hasActive ? '有任务正在执行，列表会自动刷新。' : '最近 50 条，含失败与取消记录。'}
            </p>
          </div>
        </div>
        <div className="ck-task-list" aria-live="polite">
          {tasks.length === 0 ? (
            <div className="ck-card ck-task-empty">还没有任务。先运行一次收盘简报。</div>
          ) : (
            tasks.map((task) => {
              const view = resultView(task)
              const progress = Math.max(0, Math.min(100, Math.round(task.progress || 0)))
              const active = task.status === 'queued' || task.status === 'running'
              const canCancel = task.status === 'queued' && busy !== task.id
              return (
                <article
                  className={`ck-card ck-task is-${task.status}`}
                  key={task.id}
                >
                  <div className="ck-task-head">
                    <span className="ck-task-type">{TYPE_LABEL[task.type] || task.type}</span>
                    <Badge
                      variant="outline"
                      className={`ck-task-status is-${task.status}`}
                    >
                      {taskStatusLabel(task.status)}
                    </Badge>
                  </div>
                  {active && (
                    <div className="ck-task-body">
                      <div className="ck-task-step">
                        <span>{task.step || (task.status === 'queued' ? '等待执行' : '执行中')}</span>
                        <span>{progress}%</span>
                      </div>
                      <div
                        className="ck-task-progress"
                        role="progressbar"
                        aria-label={`${TYPE_LABEL[task.type] || task.type}进度`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress}
                      >
                        <div className="ck-task-progress-fill" style={{ width: `${progress}%` }} />
                      </div>
                    </div>
                  )}
                  {view && (
                    <div className="ck-task-result">
                      <strong>{view.title}</strong>
                      {view.body}
                    </div>
                  )}
                  {task.error && <p className="ck-task-error">{task.error}</p>}
                  <div className="ck-task-meta">
                    <span>{formatTime(task.createdAt)}</span>
                    <span className="ck-sep">·</span>
                    <code>{task.id.slice(0, 8)}</code>
                    {task.attempts > 1 && (
                      <>
                        <span className="ck-sep">·</span>
                        <span>第 {task.attempts} 次尝试</span>
                      </>
                    )}
                    {task.costMicros > 0 && (
                      <>
                        <span className="ck-sep">·</span>
                        <span>{formatCost(task.costMicros)}</span>
                      </>
                    )}
                  </div>
                  {canCancel && (
                    <div className="ck-task-actions">
                      <Button
                        variant="destructive"
                        size="sm"
                        type="button"
                        disabled={busy === task.id}
                        onClick={() => void cancel(task.id)}
                      >
                        取消任务
                      </Button>
                    </div>
                  )}
                </article>
              )
            })
          )}
        </div>
      </section>
    </>
  )
}
