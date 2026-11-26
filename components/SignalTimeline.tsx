import { useEffect, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import EmptyData from "@/components/EmptyData";
import AnalysisNewsCard from './AnalysisNewsCard';

interface Props {
  items: any[];
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
  emptyMessage?: ReactNode;
  emptyAction?: ReactNode;
}

export default function SignalTimeline({ items, hasMore, loading, onLoadMore, emptyMessage, emptyAction }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(true);
  const itemCountRef = useRef(items?.length ?? 0);
  const itemCount = items?.length ?? 0;

  // 追加成功就重新武装；加载失败时列表长度不变，不能原地反复重试。
  useEffect(() => {
    if (itemCount > itemCountRef.current) readyRef.current = true;
    itemCountRef.current = itemCount;
  }, [itemCount]);

  useEffect(() => {
    if (!hasMore || loading || !onLoadMore) return;
    const root = scrollRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) {
          // 离开底部后重新武装，下次滚回才允许再取一页
          readyRef.current = true;
          return;
        }
        if (!readyRef.current) return;
        readyRef.current = false;
        onLoadMore();
      },
      // 提前一屏取数据，滚到底部时列表已接上
      { root, rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore]);

  if (!items || items.length === 0) {
    return (
      <div className="bg-card border rounded-xl p-4 sm:p-5 mb-6">
        <EmptyData
          message={emptyMessage ?? "暂无信号数据，等待新闻归档和分析完成…"}
          action={emptyAction}
          className="min-h-[240px]"
        />
      </div>
    );
  }

  return (
    <div className="bg-card border rounded-xl p-4 sm:p-5 mb-6">
      <div
        ref={scrollRef}
        className="max-h-[min(70vh,40rem)] overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]"
      >
        <ul className="space-y-2.5 list-none">
          {items.map((item) => (
            <li key={item.id}><AnalysisNewsCard item={item} /></li>
          ))}
        </ul>

        {hasMore && <div ref={sentinelRef} className="h-px w-full" aria-hidden="true" />}
        {loading && (
          <div
            role="status"
            className="flex items-center justify-center gap-1.5 pt-4 pb-2 text-xs text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            加载中…
          </div>
        )}
      </div>
    </div>
  );
}
