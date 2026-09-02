import Link from "next/link";
import { Zap } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";

interface TodaySignalSummaryProps {
  items: any[];
}

/**
 * Summary bar shown at the top of the home page.
 * Displays counts of today's AI-analyzed signals (shadcn card + badge style).
 * Only renders when at least 1 item has been analyzed.
 */
export default function TodaySignalSummary({ items }: TodaySignalSummaryProps) {
  if (!items || items.length === 0) return null;

  // Count analyzed items with scores >= 3
  const analyzed = items.filter(
    (item: any) => item.analysis && item.analysis.signal_score >= 3
  );

  if (analyzed.length === 0) return null;

  const criticalCount = analyzed.filter(
    (item: any) => item.analysis.signal_score === 5
  ).length;
  const significantCount = analyzed.filter(
    (item: any) => item.analysis.signal_score === 4
  ).length;
  const moderateCount = analyzed.filter(
    (item: any) => item.analysis.signal_score === 3
  ).length;

  const totalNews = items.length;

  return (
    <Link
      href="/analysis"
      className="block mx-auto max-w-[760px] lg:max-w-[880px] xl:max-w-[960px] 2xl:max-w-[1120px] px-4 sm:px-6 mb-6 no-underline"
    >
      <div className="group flex items-center gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10 transition-all hover:shadow-md hover:ring-primary/40">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Zap className="h-4 w-4" />
        </span>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 min-w-0">
          <span className="text-sm text-muted-foreground">
            {totalNews} 条快讯中，AI 识别{" "}
            <span className="font-semibold text-foreground">
              {analyzed.length} 条值得关注信号
            </span>
          </span>
          {criticalCount > 0 && (
            <Badge variant="destructive">{criticalCount} 重大</Badge>
          )}
          {significantCount > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                "text-orange-600 dark:text-orange-400",
                "border-orange-200/70 dark:border-orange-800/40"
              )}
            >
              {significantCount} 重要
            </Badge>
          )}
          {moderateCount > 0 && (
            <Badge
              variant="secondary"
              className={cn(
                "text-yellow-600 dark:text-yellow-400",
                "border-yellow-200/70 dark:border-yellow-800/40"
              )}
            >
              {moderateCount} 关注
            </Badge>
          )}
        </div>
        <span className="text-primary text-xs ml-auto shrink-0 transition-transform group-hover:translate-x-0.5">
          查看分析 →
        </span>
      </div>
    </Link>
  );
}
