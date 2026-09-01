/**
 * P2.1 客户端轻量埋点（无第三方 SDK）。
 *
 * 事件先入 localStorage 缓冲，批量 POST /api/events 落 event_log：
 * - 缓冲 ≥ 10 条立即 flush；否则每 15s 兜底 flush；页面卸载时 sendBeacon 兜底
 * - 上报失败不清空缓冲（下次重试），缓冲上限 100 条防膨胀
 * - session id 存 localStorage（30 天滚动续期），用于去重/独立访问统计
 *
 * 事件命名约定（白名单见 /api/events）：signal_click / thread_expand /
 * industry_drill / watchlist_add / watchlist_remove / search_query
 */

const SESSION_KEY = 'fn_session_id';
const BUFFER_KEY = 'fn_event_buffer';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_BUFFER = 100;
const FLUSH_THRESHOLD = 10;
const FLUSH_INTERVAL_MS = 15000;

let flushTimer: ReturnType<typeof setInterval> | null = null;

export function getSessionId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = localStorage.getItem(SESSION_KEY);
    const storedAt = Number(localStorage.getItem(`${SESSION_KEY}_at`) || 0);
    if (!id || Date.now() - storedAt > SESSION_TTL_MS) {
      id =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(SESSION_KEY, id);
      localStorage.setItem(`${SESSION_KEY}_at`, String(Date.now()));
    }
    return id;
  } catch {
    return '';
  }
}

function readBuffer(): Array<Record<string, unknown>> {
  try {
    const raw = localStorage.getItem(BUFFER_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeBuffer(buf: Array<Record<string, unknown>>): void {
  try {
    localStorage.setItem(BUFFER_KEY, JSON.stringify(buf.slice(-MAX_BUFFER)));
  } catch {
    // localStorage 满（隐私模式等）：静默丢弃，埋点不允许影响主流程
  }
}

/** 记录一条事件（入缓冲，达阈值立即上报）。 */
export function track(name: string, payload: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const buf = readBuffer();
  buf.push({
    name,
    payload,
    ts: new Date().toISOString(),
    session: getSessionId(),
  });
  writeBuffer(buf);
  if (buf.length >= FLUSH_THRESHOLD) void flush();
  ensureTimer();
}

/** 上报缓冲内全部事件；成功清空，失败保留。 */
export function flush(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  const buf = readBuffer();
  if (buf.length === 0) return Promise.resolve();

  const body = JSON.stringify({ events: buf });

  // 卸载场景优先 sendBeacon（不阻塞页面关闭）
  if (navigator.sendBeacon) {
    try {
      const ok = navigator.sendBeacon(
        '/api/events',
        new Blob([body], { type: 'application/json' })
      );
      if (ok) {
        writeBuffer([]);
        return Promise.resolve();
      }
    } catch {
      // fall through to fetch
    }
  }

  return fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  })
    .then((r) => {
      if (r.ok) writeBuffer([]);
    })
    .catch(() => {
      // 网络失败：保留缓冲，下次 flush 重试
    });
}

function ensureTimer(): void {
  if (flushTimer != null || typeof window === 'undefined') return;
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', () => void flush(), { once: true });
}
