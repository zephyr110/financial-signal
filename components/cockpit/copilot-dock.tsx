import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { Bot, Check, ExternalLink, Loader2, Send, X } from 'lucide-react'
import { AgentMarkdown } from '@/components/agent-markdown'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  AGENT_STREAM_ERROR_COPY,
  consumeAgentEventStream,
  toAgentStreamError,
} from '@/lib/agent/sse'
import {
  COPILOT_SESSION_KEY,
  markCopilotSeen,
  readCopilotPrefs,
  resolveCopilotOpen,
  writeCopilotPrefs,
} from '@/lib/copilot-prefs'
import { track } from '@/lib/track'
import { cn } from '@/lib/utils'
import { useCockpitSelection } from './selection-context'

interface CopilotMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  tools?: string[]
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function readSessionId(): number | null {
  try {
    const raw = safeStorage()?.getItem(COPILOT_SESSION_KEY)
    return raw && /^\d+$/.test(raw) ? Number(raw) : null
  } catch {
    return null
  }
}

function persistSession(id: number): void {
  try {
    safeStorage()?.setItem(COPILOT_SESSION_KEY, String(id))
  } catch {
    // 存储不可用时本轮仍可用，只是刷新后另起会话
  }
}

/**
 * 常驻 Copilot：就地问答，会话与 /agent 共用同一个 sessionId。
 * 桌面为右侧浮层（不挤压面板），手机为底部 Sheet；同一时刻只保留一个 SSE 连接。
 */
export function CopilotDock() {
  const { symbol } = useCockpitSelection()
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<CopilotMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sessionId, setSessionId] = useState<number | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composingRef = useRef(false)
  const initializedRef = useRef(false)
  const inputId = useId()

  const setOpenPersisted = useCallback((next: boolean) => {
    setOpen(next)
    writeCopilotPrefs(safeStorage(), next)
  }, [])

  // 首次进入桌面默认展开一次；之后遵循显式偏好。手机默认关闭，读的是真实媒体查询而非水合期快照。
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    const mobileNow = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches
    const storage = safeStorage()
    const prefs = readCopilotPrefs(storage)
    const shouldOpen = resolveCopilotOpen(prefs.stored, prefs.firstVisit, mobileNow)
    if (shouldOpen) {
      setOpen(true)
      if (prefs.firstVisit) markCopilotSeen(storage)
    }
    setSessionId(readSessionId())
  }, [])

  useEffect(() => {
    const openHandler = () => {
      setOpen(true)
      writeCopilotPrefs(safeStorage(), true)
      window.setTimeout(() => inputRef.current?.focus(), 60)
    }
    const toggleHandler = () => setOpenPersisted(!open)
    window.addEventListener('cockpit:copilot-open', openHandler)
    window.addEventListener('app:copilot-toggle', toggleHandler)
    return () => {
      window.removeEventListener('cockpit:copilot-open', openHandler)
      window.removeEventListener('app:copilot-toggle', toggleHandler)
    }
  }, [open, setOpenPersisted])

  useEffect(() => () => abortRef.current?.abort(), [])

  useEffect(() => {
    if (!open) return
    track('copilot_open', { surface: isMobile ? 'mobile' : 'desktop' })
    const timer = window.setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [open, isMobile])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || loading) return
    track('copilot_send', { hasContext: Boolean(symbol) })
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const assistantId = `a-${Date.now()}`
    setInput('')
    setError('')
    setLoading(true)
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '', streaming: true, tools: [] },
    ])

    try {
      const res = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: sessionId ?? undefined,
          message: text,
          stream: true,
          context: symbol ? `当前选中标的：${symbol}` : undefined,
        }),
      })
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}))
        if (data.sessionId) {
          setSessionId(data.sessionId)
          persistSession(data.sessionId)
        }
        throw new Error(data.error || `请求失败（HTTP ${res.status}）`)
      }

      await consumeAgentEventStream(res.body, (event, payload) => {
        if (event === 'delta') {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId
                ? { ...message, content: message.content + (payload.text ?? '') }
                : message,
            ),
          )
        } else if (event === 'tool_start') {
          setMessages((prev) =>
            prev.map((message) => {
              if (message.id !== assistantId || !payload.tool) return message
              const tools = new Set(message.tools ?? [])
              tools.add(payload.tool)
              return { ...message, tools: [...tools] }
            }),
          )
        } else if (event === 'tool_end') {
          setMessages((prev) =>
            prev.map((message) => {
              if (message.id !== assistantId || !payload.tool) return message
              const tools = new Set(message.tools ?? [])
              tools.delete(payload.tool)
              tools.add(`${payload.tool}${payload.ok ? ' ✓' : ' ✗'}`)
              return { ...message, tools: [...tools] }
            }),
          )
        } else if (event === 'done') {
          if (payload.sessionId) {
            setSessionId(payload.sessionId)
            persistSession(payload.sessionId)
          }
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId
                ? { ...message, content: payload.reply ?? message.content, streaming: false }
                : message,
            ),
          )
        }
      })
    } catch (err) {
      if (controller.signal.aborted) return
      const streamError = toAgentStreamError(err)
      setError(streamError.detail || AGENT_STREAM_ERROR_COPY[streamError.kind].description)
      setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId ? { ...message, streaming: false } : message,
        ),
      )
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setLoading(false)
    }
  }, [input, loading, sessionId, symbol])

  const body = (
    <>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 [scrollbar-gutter:stable]"
        aria-live="polite"
      >
        {messages.length === 0 && (
          <div className="rounded-lg border bg-muted/30 p-3 text-xs leading-5 text-muted-foreground">
            <p className="font-medium text-foreground">围绕当前界面提问</p>
            <p className="mt-1">
              选中标的或线索后，Copilot 会带上上下文去查信号、公告与行业数据。
              需要长对话和分支时去
              <Link href="/agent" className="mx-1 underline underline-offset-2 hover:text-foreground">研究助手</Link>
              ，会话是同一个。
            </p>
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={cn('flex flex-col', message.role === 'user' ? 'items-end' : 'items-start')}>
            {message.role === 'user' ? (
              <p className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-secondary px-3 py-2 text-xs leading-5 text-secondary-foreground">
                {message.content}
              </p>
            ) : (
              <div className="w-full">
                {message.tools && message.tools.length > 0 && (
                  <ul className="mb-1.5 flex flex-wrap gap-1" aria-label="已调用工具">
                    {message.tools.map((tool) => (
                      <li key={tool} className="flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        <Check className="size-2.5" aria-hidden="true" />{tool}
                      </li>
                    ))}
                  </ul>
                )}
                {message.content ? (
                  <AgentMarkdown content={message.content} streaming={message.streaming} />
                ) : (
                  <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />正在收集证据…
                  </p>
                )}
              </div>
            )}
          </div>
        ))}
        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[11px] leading-4 text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t p-2.5">
        <label htmlFor={inputId} className="sr-only">向 Copilot 提问</label>
        <div className="flex items-end gap-1.5">
          <textarea
            id={inputId}
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onCompositionStart={() => { composingRef.current = true }}
            onCompositionEnd={() => { composingRef.current = false }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey) return
              if (composingRef.current || event.nativeEvent.isComposing) return
              event.preventDefault()
              void send()
            }}
            placeholder={symbol ? `就 ${symbol} 提问…` : '问研究助手…'}
            className="min-h-10 flex-1 resize-none rounded-md border bg-background px-2.5 py-2 text-xs leading-5 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button size="icon" aria-label="发送" disabled={loading || !input.trim()} onClick={() => void send()}>
            {loading
              ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              : <Send className="size-4" />}
          </Button>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{symbol ? `跟随 ${symbol}` : '未选中标的'}</span>
          <Link href="/agent" className="flex items-center gap-0.5 hover:text-foreground">
            在 /agent 继续<ExternalLink className="size-3" />
          </Link>
        </div>
      </div>
    </>
  )

  const header = (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-[13px] font-semibold">Copilot</span>
      </div>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="收起 Copilot"
        onClick={() => setOpenPersisted(false)}
      >
        <X className="size-4" />
      </Button>
    </>
  )

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpenPersisted(true)}
          aria-label="打开 Copilot"
          className="fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-3 z-30 flex items-center gap-1.5 rounded-full border bg-background px-3 py-2 text-xs font-medium shadow-lg transition-transform hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none lg:bottom-4"
        >
          <Bot className="size-4" aria-hidden="true" />
          Copilot
        </button>
      )}

      {!isMobile && open && (
        <aside
          aria-label="Copilot 研究助手"
          className="fixed bottom-0 right-0 top-14 z-30 flex w-[360px] max-w-[92vw] flex-col border-l bg-background shadow-xl"
        >
          <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">{header}</div>
          {body}
        </aside>
      )}

      {isMobile && (
        <Sheet open={open} onOpenChange={(next) => { if (!next) setOpenPersisted(false) }}>
          <SheetContent side="bottom" className="h-[85dvh] gap-0 p-0 motion-reduce:transition-none" showCloseButton={false}>
            <SheetHeader className="flex flex-row items-center justify-between space-y-0 border-b px-3 py-2">
              <div>
                <SheetTitle className="text-sm">Copilot</SheetTitle>
                <SheetDescription className="text-[10px]">
                  {symbol ? `跟随 ${symbol}` : '就当前界面提问'}
                </SheetDescription>
              </div>
              <Button size="icon-sm" variant="ghost" aria-label="收起 Copilot" onClick={() => setOpenPersisted(false)}>
                <X className="size-4" />
              </Button>
            </SheetHeader>
            {body}
          </SheetContent>
        </Sheet>
      )}
    </>
  )
}
