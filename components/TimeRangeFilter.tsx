import { cn } from "@/lib/utils";

/**
 * 趋势图时间跨度选择（「最近 N 天」诚实口径）。
 * 说明:曾经提供「自定义日期区间」,但底层只消费区间长度(距当前最近 N 小时),
 * 所选起止点并不会出现在图上——误导性强,已移除;需绝对区间展示时请先改接口。
 */
const PRESETS = [
  { label: "1天", hours: 24 },
  { label: "7天", hours: 168 },
  { label: "30天", hours: 720 },
  { label: "365天", hours: 8760 },
];

export default function TimeRangeFilter({ value, onChange }) {
  const activePreset = PRESETS.find((p) => p.hours === value);

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs text-muted-foreground shrink-0">
        时间跨度：
      </span>
      <div className="flex items-center gap-1">
        {PRESETS.map(({ label, hours }) => {
          const active = activePreset?.hours === hours;
          return (
            <button
              key={hours}
              type="button"
              onClick={() => onChange(hours)}
              className={cn(
                "px-2.5 h-8 rounded-full text-xs font-medium transition-all border",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"
              )}
            >
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
