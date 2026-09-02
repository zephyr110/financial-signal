import { AlertTriangle, TrendingUp, Zap, BarChart3 } from "lucide-react";
import { cn } from "@/lib/utils";
import TrendDelta from "./TrendDelta";
import { Badge } from "./ui/badge";

const CARDS = [
  {
    key: "overall",
    icon: Zap,
    label: "信号强度",
    gradient: "from-blue-600 to-blue-500 dark:from-blue-700 dark:to-blue-600",
    textColor: "text-white",
    mutedColor: "text-blue-50",
    ringColor: "ring-blue-400/40",
    badgeClass:
      "border-blue-200/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm dark:border-blue-400/25",
  },
  {
    key: "critical",
    icon: AlertTriangle,
    label: "重大信号",
    gradient: "from-rose-600 to-rose-500 dark:from-rose-700 dark:to-rose-600",
    textColor: "text-white",
    mutedColor: "text-rose-50",
    ringColor: "ring-rose-400/40",
    badgeClass:
      "border-rose-200/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm dark:border-rose-400/25",
  },
  {
    key: "significant",
    icon: TrendingUp,
    label: "重要信号",
    gradient: "from-amber-500 to-amber-400 dark:from-amber-600 dark:to-amber-500",
    textColor: "text-white",
    mutedColor: "text-amber-50",
    ringColor: "ring-amber-400/40",
    badgeClass:
      "border-amber-200/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm dark:border-amber-400/25",
  },
  {
    key: "max",
    icon: BarChart3,
    label: "最高分",
    gradient: "from-emerald-600 to-emerald-500 dark:from-emerald-700 dark:to-emerald-600",
    textColor: "text-white",
    mutedColor: "text-emerald-50",
    ringColor: "ring-emerald-400/40",
    badgeClass:
      "border-emerald-200/70 bg-background/95 text-foreground shadow-sm backdrop-blur-sm dark:border-emerald-400/25",
  },
];

interface AnalysisOverviewProps {
  stats: {
    total_signals?: number;
    critical_count?: number;
    significant_count?: number;
    max_score?: number;
    previous?: {
      total_signals?: number;
      critical_count?: number;
      significant_count?: number;
      max_score?: number;
    } | null;
  } | null;
  items: Array<{ signal_score: number }>;
  loading: boolean;
  filter: string | null;
  onFilterChange: (key: string | null) => void;
}

export default function AnalysisOverview({ stats, items, loading, filter, onFilterChange }: AnalysisOverviewProps) {
  const total = stats?.total_signals ?? 0;
  const prev = stats?.previous;
  const prevTotal = prev?.total_signals;

  const avgScore = total > 0 && items?.length
    ? (items.reduce((s, i) => s + i.signal_score, 0) / items.length).toFixed(1)
    : "—";

  const values = {
    overall: {
      value: avgScore,
      sub: `共 ${total} 条信号`,
      trendCurrent: total,
      trendPrevious: prevTotal ?? null,
    },
    critical: {
      value: stats?.critical_count ?? 0,
      sub: "需立即关注",
      trendCurrent: stats?.critical_count ?? 0,
      trendPrevious: prev?.critical_count ?? null,
    },
    significant: {
      value: stats?.significant_count ?? 0,
      sub: "含重要变化",
      trendCurrent: stats?.significant_count ?? 0,
      trendPrevious: prev?.significant_count ?? null,
    },
    max: {
      value: stats?.max_score ?? 0,
      sub: "今日峰值",
      trendCurrent: stats?.max_score ?? 0,
      trendPrevious: prev?.max_score ?? null,
    },
  };

  return (
    <div className="grid grid-cols-2 sm:flex sm:flex-row gap-3 mb-6">
      {CARDS.map(({ key, icon: Icon, label, gradient, textColor, mutedColor, ringColor, badgeClass }) => {
        const active = filter === key;
        const { value, sub, trendCurrent, trendPrevious } = values[key];

        return (
          <button
            key={label}
            type="button"
            onClick={() => onFilterChange?.(active ? null : (key === "overall" ? null : key))}
            className={cn(
              "relative overflow-hidden rounded-xl p-3 sm:p-4 text-left transition-all duration-200",
              "bg-gradient-to-br", gradient, "sm:flex-1",
              active
                ? `ring-2 ring-offset-1 ring-offset-background ${ringColor} scale-[1.02]`
                : "hover:shadow-lg hover:scale-[1.01]"
            )}
          >
            <div className="absolute -top-3 -right-3 w-16 h-16 rounded-full bg-white/10" />

            <div className="relative flex items-center gap-1.5 mb-2">
              <Icon className={cn("h-3.5 w-3.5", mutedColor)} />
              <span className={cn("text-xs font-semibold", mutedColor)}>
                {label}
              </span>
            </div>

            {loading ? (
              <div className="relative">
                <div className="h-7 w-14 rounded bg-white/20 animate-pulse" />
              </div>
            ) : (
              <div className={cn(
                "relative text-2xl sm:text-3xl font-bold tabular-nums tracking-tight mb-1",
                textColor
              )}>
                {value}
              </div>
            )}

            <div className={cn(
              "relative text-xs font-medium",
              mutedColor
            )}>
              {sub}
            </div>

            {/* Trend delta — 中性底 + 卡片色系描边，与渐变背景区分；涨跌色由 TrendDelta 语义着色 */}
            {trendCurrent != null && trendPrevious != null && (
              <div className="relative mt-1.5">
                <Badge variant="outline" className={badgeClass}>
                  <TrendDelta
                    current={trendCurrent as number}
                    previous={trendPrevious as number}
                    label="昨日"
                  />
                </Badge>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
