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
import {
  summarizeOverallSentiment,
  type SentimentBreakdownRow,
} from "@/lib/sentiment";
import { CHART_TOOLTIP_CURSOR, chartTooltipContent } from "@/components/chart-tooltip";

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

const sentimentTooltip = chartTooltipContent({
  hideZero: true,
  formatter: (value, name) => [`${value} 条`, SENTIMENT_LABELS[name] || name],
  getColor: (entry) =>
    SENTIMENT_COLORS[String(entry.name) as keyof typeof SENTIMENT_COLORS] ?? "#6b7280",
});

interface SentimentChartProps {
  data: SentimentBreakdownRow[];
  /** 样本说明（如「近 24 小时全部 ≥3 分信号」） */
  sampleNote?: string;
}

/**
 * Stacked bar chart — sentiment distribution by signal category.
 * Only includes signals with score >= 3.
 */
export default function SentimentChart({ data, sampleNote }: SentimentChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-[11px] sm:text-xs text-muted-foreground">
        暂无情感数据
      </div>
    );
  }

  const chartData = data.map((d) => ({
    name: CATEGORY_LABELS[d.category] || d.category,
    positive: d.positive,
    negative: d.negative,
    neutral: d.neutral,
    mixed: d.mixed,
  }));

  const {
    label: overallLabel,
    positivePct,
    negativePct,
    neutralPct,
    mixedPct,
    total,
  } = summarizeOverallSentiment(data);

  const note =
    sampleNote ?? `近 24 小时全部 ≥3 分信号（共 ${total} 条）`;

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
          <Tooltip cursor={CHART_TOOLTIP_CURSOR} content={sentimentTooltip} />
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
        整体情绪：{overallLabel}（看多 {positivePct}% · 看空 {negativePct}% · 中性 {neutralPct}% · 混合 {mixedPct}%）· {note}
      </p>
    </div>
  );
}
