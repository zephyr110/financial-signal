import { Loader2 } from "lucide-react";
import AnalysisNewsCard from './AnalysisNewsCard';

interface Props {
  items: any[];
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
}

export default function SignalTimeline({ items, hasMore, loading, onLoadMore }: Props) {
  if (!items || items.length === 0) {
    return (
      <div className="text-center py-10 text-muted-foreground text-sm">
        暂无信号数据，等待新闻归档和分析完成...
      </div>
    );
  }

  return (
    <div className="max-h-[min(70vh,40rem)] overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]">
      <ul className="space-y-2.5 list-none">
        {items.map((item) => (
          <li key={item.id}><AnalysisNewsCard item={item} /></li>
        ))}
      </ul>

      {hasMore && (
        <div className="flex justify-center pt-4 pb-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground bg-card border hover:border-primary/50 transition-all disabled:opacity-50"
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin" />}
            {loading ? '加载中…' : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
