import { useState, useEffect } from "react";
import Link from "next/link";
import { Star, X, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { getAllWatchlist, subscribeWatchlist, toggleWatchlist, type WatchlistItem } from "@/lib/watchlist";

interface Props {
  /** analysis 页现有信号数据（按 id 匹配 watchlist 条目） */
  items: any[];
  /** analysis 页现有线索数据 */
  threads: any[];
  /** 行业信号计数(heatmap 口径:24h 全窗口 ≥3 分)——与 IndustrySelector 徽标同源 */
  heatmap?: { industry: string; signalCount: number }[] | null;
}

/**
 * P2.2 「我的跟踪」面板（analysis 页顶部）：
 * - 跟踪行业：chips 带信号计数，点击取消跟踪
 * - 跟踪信号：标题列表（链接详情页）
 * - 跟踪线索：标题列表（链接线索页）
 * 空状态不渲染。数据来自 watchlist 服务 + 现有页面数据匹配（无额外请求）。
 */
export default function WatchlistPanel({ items, threads, heatmap = null }: Props) {
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);

  useEffect(() => {
    setWatchlist(getAllWatchlist());
    return subscribeWatchlist(() => setWatchlist(getAllWatchlist()));
  }, []);

  // heatmap 口径计数表(全窗口 ≥3 分);watchlist 行业不在 heatmap 中 = 无高分信号,不显示数字
  const heatmapCounts = new Map(
    (heatmap || []).map((h) => [h.industry, h.signalCount])
  );

  const industries = watchlist.filter((w) => w.type === "industry");
  const signals = watchlist.filter((w) => w.type === "signal");
  const threadItems = watchlist.filter((w) => w.type === "thread");

  const hasAny = industries.length + signals.length + threadItems.length > 0;
  if (!hasAny) return null;

  // 按 id 匹配页面数据（倒序取最新）
  const signalMeta = new Map(
    [...items].reverse().map((it) => [String(it.analysis_id), it])
  );
  const threadMeta = new Map(threads.map((t) => [String(t.id), t]));

  return (
    <div className="bg-card border rounded-xl p-4 sm:p-5 mb-5">
      <div className="flex items-center gap-2 mb-3">
        <Star className="h-4 w-4 fill-amber-400 text-amber-500" />
        <h3 className="text-sm font-semibold text-foreground">我的跟踪</h3>
      </div>

      {industries.length > 0 && (
        <div className="mb-3">
          <span className="text-xs text-muted-foreground block mb-1.5">跟踪行业</span>
          <div className="flex flex-wrap gap-1.5">
            {industries.map((w) => {
              const count = heatmapCounts.get(w.id) ?? 0;
              return (
                <button
                  key={`industry-${w.id}`}
                  type="button"
                  onClick={() => toggleWatchlist("industry", w.id)}
                  className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-accent text-accent-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                >
                  <TrendingUp className="h-3 w-3" />
                  {w.id}
                  {count > 0 && (
                    <span className="text-xs text-muted-foreground">({count})</span>
                  )}
                  <X className="h-3 w-3" />
                </button>
              );
            })}
          </div>
        </div>
      )}

      {signals.length > 0 && (
        <div className="mb-3">
          <span className="text-xs text-muted-foreground block mb-1.5">跟踪信号</span>
          <ul className="space-y-1">
            {signals.map((w) => {
              const sig = signalMeta.get(w.id);
              return (
                <li key={`signal-${w.id}`} className="flex items-center gap-2">
                  <Link
                    href={`/signal/${w.id}`}
                    className="text-sm text-foreground hover:text-primary truncate flex-1"
                  >
                    {sig?.summary || `信号 #${w.id}`}
                  </Link>
                  <button
                    type="button"
                    aria-label="取消跟踪"
                    onClick={() => toggleWatchlist("signal", w.id)}
                    className="text-muted-foreground hover:text-amber-500 shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {threadItems.length > 0 && (
        <div>
          <span className="text-xs text-muted-foreground block mb-1.5">跟踪线索</span>
          <ul className="space-y-1">
            {threadItems.map((w) => {
              const t = threadMeta.get(w.id);
              return (
                <li key={`thread-${w.id}`} className="flex items-center gap-2">
                  <Link
                    href={`/thread/${w.id}`}
                    className={cn(
                      "text-sm text-foreground hover:text-primary truncate flex-1",
                      !t && "text-muted-foreground"
                    )}
                  >
                    {t?.title || `线索 #${w.id}`}
                  </Link>
                  <button
                    type="button"
                    aria-label="取消跟踪"
                    onClick={() => toggleWatchlist("thread", w.id)}
                    className="text-muted-foreground hover:text-amber-500 shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
