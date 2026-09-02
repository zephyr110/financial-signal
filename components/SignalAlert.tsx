import { useEffect, useRef, useState, useCallback } from "react";
import { Bell, BellOff, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "signal-alert-enabled";
const LAST_NOTIFIED_KEY = "signal-alert-last-id";

/**
 * 重要信号浏览器通知。
 *
 * 浏览器要求通知权限只能由用户手势（点击/按键）触发请求，
 * 因此不在挂载时自动 requestPermission，而是提供开关按钮，
 * 用户点击后才请求权限（手势满足后首次请求成功率最高）。
 *
 * items 由调用方传入（分析页为 watchedItems，天然按关注行业定向）。
 * 已提醒的最大信号 id 持久化到 localStorage：刷新页面不会对同一批信号重复弹通知。
 */
export default function SignalAlert({ items }: { items: any[] }) {
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const lastNotifiedRef = useRef(0);

  // 初始状态：读取本地开关 + 当前权限 + 已提醒游标
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    setPermission(Notification.permission);
    try {
      if (localStorage.getItem(STORAGE_KEY) === "1") setEnabled(true);
      const saved = Number(localStorage.getItem(LAST_NOTIFIED_KEY) || 0);
      if (Number.isFinite(saved) && saved > 0) lastNotifiedRef.current = saved;
    } catch {
      // localStorage 不可用则默认关闭
    }
  }, []);

  // 开关为开且权限已授予时，监测 ≥4 分信号（每个 id 只提醒一次）
  useEffect(() => {
    if (!enabled || permission !== "granted") return;
    if (!items || items.length === 0) return;

    const critical = items.filter((i) => i.signal_score >= 4);
    if (critical.length === 0) return;

    const latestId = critical[0]?.id || 0;
    if (latestId <= lastNotifiedRef.current) return;
    lastNotifiedRef.current = latestId;

    showNotification(critical);
    try {
      localStorage.setItem(LAST_NOTIFIED_KEY, String(latestId));
    } catch {
      // 持久化失败不影响本次提醒
    }
  }, [items, enabled, permission]);

  const handleToggle = useCallback(() => {
    if (permission === "unsupported") return;
    if (permission === "denied") {
      // 已被浏览器阻止：引导用户在站点设置中开启
      return;
    }
    if (!enabled) {
      // 用户手势内请求权限（浏览器要求）
      if (permission === "default" || permission === "granted") {
        Notification.requestPermission().then((perm) => {
          setPermission(perm);
          if (perm === "granted") {
            setEnabled(true);
            try { localStorage.setItem(STORAGE_KEY, "1"); } catch { /* ignore */ }
          }
        });
      }
    } else {
      setEnabled(false);
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    }
  }, [enabled, permission]);

  if (permission === "unsupported") return null;

  const denied = permission === "denied";
  const active = enabled && permission === "granted";

  // 无包裹容器：按钮由页头操作区（与关注行业选择器并排）布局；
  // denied 横幅 w-full 在 flex-wrap 页头中自动换行为整行警告条。
  return (
    <>
      {denied ? (
        <div className="flex w-full items-center gap-1.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
          浏览器已阻止通知权限，请在站点设置中允许后重试
        </div>
      ) : (
        <button
          type="button"
          onClick={handleToggle}
          aria-pressed={active}
          title={active ? "点击关闭高分信号提醒" : "开启后，关注行业 ≥4 分（重要/重大）信号将通过浏览器通知提醒"}
          className={cn(
            // 与 IndustrySelector 同款胶囊按钮
            "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium transition-colors",
            active
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-primary/40"
          )}
        >
          {active ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
          {active ? "高分信号提醒已开启" : "开启高分信号提醒"}
        </button>
      )}
    </>
  );
}

function showNotification(critical: any[]) {
  const top = critical.slice(0, 3);
  const body = top.map((i) => `[${i.signal_score}分] ${i.summary}`).join("\n");
  try {
    new Notification(`财经信号 · ${critical.length} 条 ≥4 分信号`, {
      body,
      icon: "/favicon-light.png",
      tag: "financial-signals-alert",
    });
  } catch {
    // 浏览器可能阻止构造
  }
}
