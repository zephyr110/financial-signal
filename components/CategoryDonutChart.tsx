import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from "recharts";
import { CATEGORY_LABELS } from "@/lib/constants";
import { chartTooltipContent, useChartTooltip } from "@/components/chart-tooltip";

const COLORS: Record<string, string> = {
  policy: "#e11d48",
  geopolitics: "#f97316",
  industry: "#2563eb",
  company: "#16a34a",
  macro: "#7c3aed",
  market_rumor: "#ca8a04",
};
const FALLBACK = "#6b7280";

/**
 * Donut chart — category distribution of quality signals (score ≥ 3).
 */
export default function CategoryDonutChart({ items }) {
  if (!items || items.length === 0) {
    return (
      <div className="text-center py-8 text-[11px] sm:text-xs text-muted-foreground">
        暂无分类数据
      </div>
    );
  }

  const qualityItems = items.filter(i => i.signal_score >= 3);

  if (qualityItems.length === 0) {
    return (
      <div className="text-center py-8 text-[11px] sm:text-xs text-muted-foreground">
        暂无高质量信号（≥3分）
      </div>
    );
  }

  const total = qualityItems.length;

  const countMap = new Map();
  for (const item of qualityItems) {
    const cat = item.category || "macro";
    countMap.set(cat, (countMap.get(cat) || 0) + 1);
  }

  const chartData = Array.from(countMap.entries())
    .map(([cat, count]) => ({
      name: CATEGORY_LABELS[cat] || cat,
      key: cat,
      value: count,
      pct: ((count / total) * 100).toFixed(0),
    }))
    .sort((a, b) => b.value - a.value);

  const tooltipContent = useChartTooltip(
    {
      formatter: (value, _name, entry) => {
        const label = String((entry.payload as { name?: string })?.name ?? "");
        return [`${value} 条 (${((Number(value) / total) * 100).toFixed(0)}%)`, label];
      },
      getColor: (entry) => {
        const key = (entry.payload as { key?: string })?.key;
        return (key && COLORS[key]) || FALLBACK;
      },
    },
    [total],
  );

  return (
    <div>
      <ResponsiveContainer width="100%" height={220}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            innerRadius={50}
            outerRadius={80}
            paddingAngle={2}
            dataKey="value"
            nameKey="name"
            stroke="none"
          >
            {chartData.map((entry, i) => (
              <Cell key={i} fill={COLORS[entry.key] || FALLBACK} />
            ))}
          </Pie>
          <Tooltip content={tooltipContent} />
          <text
            x="50%"
            y="50%"
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-foreground"
            style={{ fontSize: 20, fontWeight: 700 }}
          >
            {total}
          </text>
          <text
            x="50%"
            y="50%"
            dy={18}
            textAnchor="middle"
            dominantBaseline="middle"
            className="fill-muted-foreground"
            style={{ fontSize: 11 }}
          >
            条信号
          </text>
        </PieChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
        {chartData.map((d) => (
          <div key={d.key} className="flex items-center gap-1.5">
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: COLORS[d.key] || FALLBACK }}
            />
            <span className="text-[11px] sm:text-xs text-muted-foreground">
              {d.name} {d.value}
            </span>
          </div>
        ))}
      </div>

      <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-1">
        仅统计 ≥3 分的高质量信号，共 {total} 条
      </p>
    </div>
  );
}
