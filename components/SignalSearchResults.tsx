import Link from "next/link";
import { Loader2, SearchX } from "lucide-react";
import SignalBadge from "./SignalBadge";
import { CATEGORY_LABELS, sourceDisplayName } from "@/lib/constants";

interface SearchResultItem {
  id: number;
  signal_score: number;
  category: string;
  impact_level: string;
  industries: string[];
  companies: string[];
  summary: string;
  source: string;
  published_at: string;
}

interface SignalSearchResultsProps {
  results: SearchResultItem[];
  total: number;
  loading: boolean;
  query: string;
  hasMore: boolean;
  onLoadMore: () => void;
  loadingMore: boolean;
}

/**
 * Display search results as a list of signal cards.
 * Replaces the SignalTimeline area on the analysis page when search is active.
 */
export default function SignalSearchResults({
  results,
  total,
  loading,
  query,
  hasMore,
  onLoadMore,
  loadingMore,
}: SignalSearchResultsProps) {
  // Loading state
  if (loading) {
    return (
      <div className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-xs">搜索中…</span>
      </div>
    );
  }

  // Empty state
  if (!loading && query && results.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
        <SearchX className="h-8 w-8" />
        <p className="text-sm font-medium">
          未找到包含「{query}」的信号
        </p>
        <p className="text-xs">
          尝试更换关键词或放宽筛选条件
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Result count */}
      <div className="flex items-center gap-2 mb-3">
        <h3 className="text-sm font-semibold text-foreground">
          搜索结果 ({total})
        </h3>
        {query && (
          <span className="text-xs text-muted-foreground">
            「{query}」
          </span>
        )}
      </div>

      {/* Result list */}
      <div className="space-y-3">
        {results.map((item) => {
          const timeStr = formatSearchTime(item.published_at);
          return (
            <Link
              key={item.id}
              href={`/signal/${item.id}`}
              className="block border rounded-lg p-3 sm:p-4 hover:bg-accent/40 hover:border-primary/50 transition-colors group"
            >
              <div className="flex items-start gap-2.5">
                <SignalBadge score={item.signal_score} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground leading-relaxed line-clamp-2 group-hover:text-primary transition-colors">
                    {item.summary}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {item.category && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-accent text-accent-foreground">
                        {CATEGORY_LABELS[item.category] || item.category}
                      </span>
                    )}
                    {item.industries?.slice(0, 3).map((ind: string) => (
                      <span
                        key={ind}
                        className="text-xs text-muted-foreground truncate max-w-[80px]"
                      >
                        {ind}
                      </span>
                    ))}
                    {item.source && (
                      <span className="text-xs text-muted-foreground ml-auto">
                        {sourceDisplayName(item.source)}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {timeStr}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Load more */}
      {hasMore && (
        <div className="flex justify-center mt-4">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border text-xs text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-50"
          >
            {loadingMore ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                加载中…
              </>
            ) : (
              "加载更多"
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function formatSearchTime(isoString: string): string {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffH = Math.floor(diffMs / 3600000);
  if (diffH < 1) return "刚刚";
  if (diffH < 24) return `${diffH}h 前`;
  if (diffH < 720)
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  return (
    d.toLocaleDateString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
  );
}
