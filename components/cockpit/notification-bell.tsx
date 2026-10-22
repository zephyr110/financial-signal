import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/router'
import { Bell, CheckCheck } from 'lucide-react'
import type { NotificationRecord } from '@/lib/cockpit/types'
import { formatTime } from '@/lib/cockpit/format'

interface NotificationPayload {
  items: NotificationRecord[]
  unread: number
}

async function showBrowserNotification(item: NotificationRecord): Promise<void> {
  if (typeof window === 'undefined' || !('Notification' in window)) return
  if (window.Notification.permission !== 'granted') return
  const options: NotificationOptions = {
    body: item.body || '',
    tag: item.id,
    icon: '/cockpit-192.png',
    data: { url: item.deepLink || '/tasks' },
  }
  try {
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration) await registration.showNotification(item.title, options)
    else new window.Notification(item.title, options)
  } catch {
    /* 浏览器通知不可用时，站内通知仍然可见 */
  }
}

export function NotificationBell() {
  const router = useRouter()
  const [items, setItems] = useState<NotificationRecord[]>([])
  const [unread, setUnread] = useState(0)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<NotificationPermission>('default')
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const knownIds = useRef<Set<string>>(new Set())

  const apply = useCallback((payload: NotificationPayload, notify: boolean) => {
    const fresh = payload.items.filter((item) => !item.readAt && !knownIds.current.has(item.id))
    for (const item of payload.items) knownIds.current.add(item.id)
    setItems(payload.items)
    setUnread(payload.unread)
    if (notify && document.hidden) {
      const latest = fresh[0]
      if (latest) void showBrowserNotification(latest)
    }
  }, [])

  const load = useCallback(async (notify = false) => {
    try {
      const res = await fetch('/api/cockpit/notifications?limit=20', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      })
      if (!res.ok) return
      const json = await res.json() as { data?: NotificationPayload }
      if (json.data?.items) apply(json.data, notify)
    } catch {
      /* 顶栏通知轮询失败不打断页面 */
    }
  }, [apply])

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPermission(window.Notification.permission)
    }
    void load(false)
    const timer = setInterval(() => { void load(true) }, 30_000)
    const onVisibility = () => {
      if (!document.hidden) void load(true)
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function mark(id: string, deepLink?: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/cockpit/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ id }),
      })
      const json = await res.json() as { data?: NotificationPayload; error?: { message?: string } }
      if (!res.ok || !json.data) {
        setError(json.error?.message || '标记已读失败。')
        return
      }
      apply(json.data, false)
      setOpen(false)
      if (deepLink) await router.push(deepLink)
    } catch {
      setError('网络连接失败，通知状态未更新。')
    } finally {
      setBusy(false)
    }
  }

  async function markAll() {
    if (unread === 0) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/cockpit/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ all: true }),
      })
      const json = await res.json() as { data?: NotificationPayload; error?: { message?: string } }
      if (!res.ok || !json.data) {
        setError(json.error?.message || '全部已读失败。')
        return
      }
      apply(json.data, false)
    } catch {
      setError('网络连接失败，通知状态未更新。')
    } finally {
      setBusy(false)
    }
  }

  async function enableBrowserNotifications() {
    if (typeof window === 'undefined' || !('Notification' in window)) return
    const result = await window.Notification.requestPermission()
    setPermission(result)
    if (result === 'granted') void showBrowserNotification({
      id: 'permission-test',
      kind: 'system',
      severity: 'info',
      title: '收盘手记通知已开启',
      body: '任务完成或简报生成后，即使页面在后台也会提醒。',
      deepLink: '/tasks',
      createdAt: new Date().toISOString(),
    })
  }

  return (
    <div className="ck-notify-wrap" ref={wrapRef}>
      <button
        className="ck-theme-toggle ck-notify-button"
        type="button"
        aria-label={unread > 0 ? `通知，${unread} 条未读` : '通知'}
        aria-expanded={open}
        aria-controls="ck-notification-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <Bell aria-hidden="true" />
        {unread > 0 && <span className="ck-notify-badge" aria-hidden="true">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <section className="ck-notify-panel" id="ck-notification-panel" aria-label="通知中心">
          <div className="ck-notify-head">
            <div>
              <h2 className="ck-notify-title">通知</h2>
              <p className="ck-notify-sub">{unread > 0 ? `${unread} 条未读` : '全部已读'}</p>
            </div>
            <button
              className="ck-button ck-button-ghost ck-button-small"
              type="button"
              disabled={busy || unread === 0}
              onClick={() => void markAll()}
            >
              <CheckCheck aria-hidden="true" />
              全部已读
            </button>
          </div>
          {permission === 'default' && (
            <button
              className="ck-button ck-button-small ck-notify-enable"
              type="button"
              onClick={() => void enableBrowserNotifications()}
            >
              同时开启浏览器通知
            </button>
          )}
          {items.length === 0 ? (
            <p className="ck-notify-empty">还没有通知。简报生成或任务结束后会出现在这里。</p>
          ) : (
            <ul className="ck-notify-list">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    className={`ck-notify-item${item.readAt ? '' : ' is-unread'}`}
                    type="button"
                    disabled={busy}
                    onClick={() => void mark(item.id, item.deepLink)}
                  >
                    <span className={`ck-notify-dot is-${item.severity}`} aria-hidden="true" />
                    <span className="ck-notify-copy">
                      <strong>{item.title}</strong>
                      {item.body && <span>{item.body}</span>}
                      <time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="ck-form-error" role="alert">{error}</p>}
        </section>
      )}
    </div>
  )
}
