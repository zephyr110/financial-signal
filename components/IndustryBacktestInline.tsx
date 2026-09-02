import { TrendingUp, TrendingDown, Minus, BarChart3, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { getBacktestTier, tierProgress, TIER_LABELS } from "@/lib/backtest";

interface BacktestIndustryRow {
  industry: string;
  samples: number;
  avg_d1: number | null;
  avg_d3: number | null;
  avg_d7: number | null;
  win_rate: number | null;
  directional_count?: number | null;
}

interface IndustryBacktestInlineProps {
  industries: string[];
  backtestData: BacktestIndustryRow[];
  onViewDetail?: (industry: string) => void;
  className?: string;
}

/**
 * Inline backtest summary shown on signal cards.
 * Displays the best-matching industry's backtest stats on one line.
 *
 * Used by: AnalysisNewsCard (F7), SignalDetail page (F2)
 */
export default function IndustryBacktestInline({
  industries,
  backtestData,
  onViewDetail,
  className,
}: IndustryBacktestInlineProps) {
  if (!industries || industries.length === 0) return null;
  if (!backtestData || backtestData.length === 0) return null;

  // Find the best match: exact match first, then fuzzy
  let match: BacktestIndustryRow | undefined;
  for (const ind of industries) {
    match = backtestData.find(
      (b) => b.industry === ind || b.industry.includes(ind) || ind.includes(b.industry)
    );
    if (match) break;
  }

  if (!match) return null;

  // P2.3 可信度分层:以方向样本数(命中率分母)为准——总事件含中性/混合会虚高精度
  const dirCount = match.directional_count ?? match.samples;
  const tier = getBacktestTier(dirCount);
  if (tier === 'accumulating') {
    return (
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5 pt-1.5 border-t border-border/50",
          onViewDetail && "cursor-pointer hover:text-foreground transition-colors",
          className
        )}
        onClick={() => onViewDetail?.(match!.industry)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onViewDetail?.(match!.industry);
          }
        }}
        role={onViewDetail ? "button" : undefined}
        tabIndex={onViewDetail ? 0 : undefined}
        title={`${match.industry} · 近30天回测 · ${tierProgress(dirCount)}`}
      >
        <Loader2 className="h-3 w-3 shrink-0 animate-pulse" />
        <span className="font-medium">{match.industry}</span>
        <span>·</span>
        <span className="text-muted-foreground/80">{tierProgress(dirCount)} · 数据积累中</span>
      </div>
    );
  }

  // day_3_return 可能为 NULL（该行业窗口内后续行情不足 3 天，AVG 结果为 NULL）
  const d3 = match.avg_d3;
  const hasD3 = d3 != null && !Number.isNaN(d3);
  const isPositive = hasD3 && d3 > 0;
  const isNegative = hasD3 && d3 < 0;
  const isReference = tier === 'reference'; // 仅供参考：数字加 ~ 前缀浅提示

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-xs text-muted-foreground mt-1.5 pt-1.5 border-t border-border/50",
        onViewDetail && "cursor-pointer hover:text-foreground transition-colors",
        className
      )}
      onClick={() => onViewDetail?.(match!.industry)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onViewDetail?.(match!.industry);
        }
      }}
      role={onViewDetail ? "button" : undefined}
      tabIndex={onViewDetail ? 0 : undefined}
      title={`${match.industry} · 近30天回测 · 方向样本 ${dirCount}${dirCount !== match.samples ? `（总事件 ${match.samples}）` : ""}${isReference ? ` · ${TIER_LABELS.reference}` : ""}`}
    >
      <BarChart3 className="h-3 w-3 shrink-0" />
      <span className="font-medium">{match.industry}</span>
      {isReference && (
        <>
          <span>·</span>
          <span className="text-muted-foreground/80">{TIER_LABELS.reference}</span>
        </>
      )}
      <span>·</span>
      {/* 方向命中率:看多次日涨/看空次日跌为命中;中性/混合不计(match.win_rate 可能为 NULL) */}
      <span title="方向命中率 = 看多信号次日板块上涨 / 看空信号次日下跌的比例;中性/混合事件不计入分母">
        命中率{" "}
        {match.win_rate == null
          ? "—"
          : `${isReference ? "~" : ""}${match.win_rate}%`}
      </span>
      <span>·</span>
      {/* A股惯例：红涨绿跌 */}
      <span className="inline-flex items-center gap-0.5">
        T+3
        {isPositive ? (
          <TrendingUp className="h-3 w-3 text-red-500" />
        ) : isNegative ? (
          <TrendingDown className="h-3 w-3 text-emerald-500" />
        ) : (
          <Minus className="h-3 w-3" />
        )}
        <span
          className={cn(
            "font-medium",
            isPositive && "text-red-600 dark:text-red-400",
            isNegative && "text-emerald-600 dark:text-emerald-400"
          )}
        >
          {hasD3 ? `${isReference ? "~" : ""}${d3 > 0 ? "+" : ""}${d3.toFixed(2)}%` : "—"}
        </span>
      </span>
    </div>
  );
}
