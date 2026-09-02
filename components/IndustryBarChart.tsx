import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList } from "recharts";
import { track } from "@/lib/track";
import { CHART_TOOLTIP_CURSOR, chartTooltipContent } from "@/components/chart-tooltip";

const industryBarTooltip = chartTooltipContent({
  labelFormatter: (_, payload) => String(payload?.[0]?.payload?.fullName ?? ""),
  formatter: (value, name) => {
    if (name === "count") return [`${value} 条`, "信号数"];
    return [String(value), name];
  },
  getColor: (entry) =>
    avgScoreToColor(Number((entry.payload as { score?: number })?.score ?? 3)),
});

interface IndustryBarChartProps {
  data: any[];
  /** 点击行业柱回调（用于切换行业关注） */
  onIndustryClick?: (industry: string) => void;
}

export default function IndustryBarChart({ data, onIndustryClick }: IndustryBarChartProps) {
  const [hoverIndex, setHoverIndex] = useState(-1);

  if (!data || data.length === 0) {
    return (
      <div className="text-center py-8 text-[11px] sm:text-xs text-muted-foreground">
        暂无行业数据
      </div>
    );
  }

  const chartData = data.slice(0, 8).map((d) => {
    const name = (d.industry || "未知").slice(0, 6) + (d.industry && d.industry.length > 6 ? "…" : "");
    return {
      name,
      fullName: d.industry || "未知",
      count: d.signalCount || 0,
      score: d.avgScore || 0,
    };
  });

  const handleClick = (entry: any) => {
    if (entry?.fullName && onIndustryClick) {
      track('industry_drill', { industry: entry.fullName });
      onIndustryClick(entry.fullName);
    }
  };

  return (
    <div>
      <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 36)}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
          onMouseLeave={() => setHoverIndex(-1)}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
          <XAxis
            type="number"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            axisLine={false}
            tickLine={false}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fontSize: 11, fill: "var(--foreground)" }}
            axisLine={false}
            tickLine={false}
            width={56}
          />
          <Tooltip cursor={CHART_TOOLTIP_CURSOR} content={industryBarTooltip} />
          <Bar
            dataKey="count"
            radius={[0, 4, 4, 0]}
            maxBarSize={20}
            cursor={onIndustryClick ? "pointer" : undefined}
            onClick={(entry: any) => handleClick(entry)}
            onMouseEnter={(_, i) => setHoverIndex(i)}
          >
            {chartData.map((entry, i) => {
              const isHovered = hoverIndex === i;
              return (
                <Cell
                  key={entry.fullName}
                  fill={avgScoreToColor(entry.score)}
                  fillOpacity={hoverIndex === -1 || isHovered ? 1 : 0.4}
                />
              );
            })}
            <LabelList
              dataKey="count"
              position="right"
              style={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      {/* 图例：色阶含义 + 点击提示 */}
      <div className="flex items-center justify-between flex-wrap gap-1 mt-1">
        <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] text-muted-foreground">
          <span>柱色</span>
          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: avgScoreToColor(3) }} />
          <span>3 分</span>
          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: avgScoreToColor(4) }} />
          <span>4 分</span>
          <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: avgScoreToColor(5) }} />
          <span>5 分（平均信号强度）</span>
        </div>
        {onIndustryClick && (
          <span className="text-[10px] text-muted-foreground">点击柱条切换关注</span>
        )}
      </div>
    </div>
  );
}

/**
 * Map average signal score (3-5) to a color — 与 CompanyHeatmap 同一色阶：
 * 分数越高越偏红/暖色，越低越偏蓝/冷色。
 */
function avgScoreToColor(score: number): string {
  // Clamp between 3 and 5
  const clamped = Math.max(3, Math.min(5, score));
  // t = 0 at score 3, t = 1 at score 5
  const t = (clamped - 3) / 2;
  // hue: red (0) to blue (220), saturation: 65%, lightness: 45-55%
  const h = Math.round(220 * (1 - t));
  return `hsl(${h}, 65%, ${45 + t * 10}%)`;
}
