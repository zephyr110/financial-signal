import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { CATEGORY_LABELS } from "@/lib/constants";

// A股惯例：红涨绿跌 → 看多红、看空绿
const SENTIMENT_COLORS = {
  positive: "#dc2626",
  negative: "#16a34a",
  neutral: "#6b7280",
  mixed: "#f97316",
};

const SENTIMENT_LABELS: Record<string, string> = {
  positive: "看多",
  negative: "看空",
  neutral: "中性",
  mixed: "混合",
};

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    fontSize: 12,
    color: "var(--foreground)",
  },
  labelStyle: { color: "var(--foreground)", fontWeight: 600 as const },
  itemStyle: { color: "var(--muted-foreground)" },
};

interface SentimentBreakdownItem {
  category: string;
  positive: number;
  negative: number;
  neutral: number;
  mixed: number;
}

interface SentimentChartProps {
  data: SentimentBreakdownItem[];
}

/**
 * Stacked bar chart — sentiment distribution by signal category.
 * Only includes signals with score >= 3.
 */
export default function SentimentChart({ data }: SentimentChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-[11px] sm:text-xs text-muted-foreground">
        暂无情感数据
      </div>
    );
  }

  // Compute overall sentiment summary
  let totalPositive = 0;
  let totalNegative = 0;
  let totalNeutral = 0;
  let totalMixed = 0;

  const chartData = data.map((d) => {
    totalPositive += d.positive;
    totalNegative += d.negative;
    totalNeutral += d.neutral;
    totalMixed += d.mixed;

    return {
      name: CATEGORY_LABELS[d.category] || d.category,
      positive: d.positive,
      negative: d.negative,
      neutral: d.neutral,
      mixed: d.mixed,
    };
  });

  const grandTotal = totalPositive + totalNegative + totalNeutral + totalMixed;
  const positivePct =
    grandTotal > 0 ? Math.round((totalPositive / grandTotal) * 100) : 0;
  const negativePct =
    grandTotal > 0 ? Math.round((totalNegative / grandTotal) * 100) : 0;
  const neutralPct =
    grandTotal > 0 ? Math.round((totalNeutral / grandTotal) * 100) : 0;
  const mixedPct =
    grandTotal > 0 ? Math.round((totalMixed / grandTotal) * 100) : 0;

  // 结论只看单向过半;中性/混合占多数时如实报「多空分歧」,不再用两两比较硬造方向
  let overallLabel = "多空分歧";
  if (positivePct >= 50) overallLabel = "偏积极 ↑";
  else if (negativePct >= 50) overallLabel = "偏消极 ↓";

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <BarChart
          data={chartData}
          margin={{ top: 4, right: 8, left: 8, bottom: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
            width={28}
          />
          <Tooltip
            {...TOOLTIP_STYLE}
            formatter={(value: number, name: string) => [
              `${value} 条`,
              SENTIMENT_LABELS[name] || name,
            ]}
          />
          <Bar dataKey="positive" stackId="sent" fill={SENTIMENT_COLORS.positive} name="positive" />
          <Bar dataKey="negative" stackId="sent" fill={SENTIMENT_COLORS.negative} name="negative" />
          <Bar dataKey="neutral" stackId="sent" fill={SENTIMENT_COLORS.neutral} name="neutral" />
          <Bar dataKey="mixed" stackId="sent" fill={SENTIMENT_COLORS.mixed} name="mixed" />
        </BarChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
        {Object.entries(SENTIMENT_LABELS).map(([key, label]) => (
          <div key={key} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: SENTIMENT_COLORS[key as keyof typeof SENTIMENT_COLORS] }}
            />
            <span className="text-[11px] sm:text-xs text-muted-foreground">
              {label}
            </span>
          </div>
        ))}
      </div>

      {/* Overall summary */}
      <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-1">
        整体情绪：{overallLabel}（看多 {positivePct}% · 看空 {negativePct}% · 中性 {neutralPct}% · 混合 {mixedPct}%）· 仅统计 ≥3 分信号（样本：当前页已加载批次）
      </p>
    </div>
  );
}
