import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";

const COLORS = ["#2563eb", "#e11d48", "#16a34a", "#f97316", "#7c3aed", "#ca8a04"];

const TOOLTIP_STYLE = {
  contentStyle: {
    background: "var(--card)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    fontSize: 12,
    color: "var(--foreground)",
  },
  labelStyle: { color: "var(--foreground)", fontWeight: 600 },
  itemStyle: { color: "var(--muted-foreground)" },
};

/**
 * Multi-line trend chart — industry signal count over time (2-hour buckets).
 * Shows which industries are gaining attention over the time window.
 */
export default function IndustryTrendChart({ data, watched }) {
  if (!data || data.length < 2) {
    return (
      <div className="text-center py-8 text-[11px] sm:text-xs text-muted-foreground">
        数据不足，需要至少 2 个时间点才能绘制趋势
      </div>
    );
  }

  // Discover industry keys from data (skip 'time' key)。
  // 取所有时间桶的并集而非 data[0]:后出现的行业(首个桶无信号)若只取首桶会被整行漏掉,
  // 导致「行业信号分布」有该行业而趋势图没有/关注该行业时误报「暂无行业趋势数据」
  const industryKeySet = new Set<string>();
  for (const row of data) {
    for (const k of Object.keys(row)) {
      if (k !== "time") industryKeySet.add(k);
    }
  }
  const industryKeys = Array.from(industryKeySet);

  let topKeys: string[];
  if (watched && watched.length > 0) {
    // Only show watched industries that exist in the data
    topKeys = watched.filter(k => industryKeys.includes(k));
  } else {
    // Show only top 5 industries by total count
    const totals = new Map<string, number>();
    for (const row of data) {
      for (const key of industryKeys) {
        totals.set(key, (totals.get(key) || 0) + (row[key] || 0));
      }
    }
    topKeys = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k]) => k);
  }

  if (topKeys.length === 0) {
    return (
      <div className="text-center py-8 text-[11px] sm:text-xs text-muted-foreground">
        暂无行业趋势数据
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis
          dataKey="time"
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          label={{ value: "时间", position: "insideBottomRight", offset: -4, style: { fontSize: 11, fill: "var(--muted-foreground)" } }}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
          width={40}
          label={{ value: "信号数", angle: -90, position: "center", offset: -28, style: { fontSize: 11, fill: "var(--muted-foreground)" } }}
        />
        <Tooltip {...TOOLTIP_STYLE} />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "var(--muted-foreground)" }}
        />
        {topKeys.map((key, i) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            name={key}
            stroke={COLORS[i % COLORS.length]}
            strokeWidth={2}
            dot={{ r: 2 }}
            activeDot={{ r: 4 }}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
