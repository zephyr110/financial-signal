import type { ReactNode } from "react";
import { useMemo } from "react";

/** Recharts Tooltip content 回调入参（精简类型，兼容 v3） */
export interface ChartTooltipEntry {
  name?: string | number;
  value?: number | string;
  color?: string;
  stroke?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

export interface ChartTooltipContentProps {
  active?: boolean;
  payload?: readonly ChartTooltipEntry[];
  label?: ReactNode;
}

export type ChartTooltipFormatter = (
  value: unknown,
  name: string,
  entry: ChartTooltipEntry,
) => [ReactNode, ReactNode] | ReactNode;

export interface ChartTooltipOptions {
  labelFormatter?: (label: unknown, payload: readonly ChartTooltipEntry[]) => ReactNode;
  formatter?: ChartTooltipFormatter;
  /** 自定义色块颜色（如 Cell 未透传 fill 时） */
  getColor?: (entry: ChartTooltipEntry) => string;
  /** 隐藏值为 0 的堆叠段（情感分布等） */
  hideZero?: boolean;
}

/** 从 Recharts payload 解析系列/扇区颜色 */
export function resolveTooltipColor(entry: ChartTooltipEntry): string {
  const fill = entry.payload?.fill;
  return (
    entry.color ||
    entry.stroke ||
    (typeof fill === "string" ? fill : undefined) ||
    "#6b7280"
  );
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  formatter,
  getColor,
  hideZero = false,
}: ChartTooltipContentProps & ChartTooltipOptions) {
  if (!active || !payload?.length) return null;

  const rows = hideZero
    ? payload.filter((e) => e.value != null && Number(e.value) !== 0)
    : payload;
  if (rows.length === 0) return null;

  const displayLabel = labelFormatter ? labelFormatter(label, payload) : label;

  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-sm">
      {displayLabel != null && displayLabel !== "" && (
        <p className="mb-1.5 font-semibold text-foreground">{displayLabel}</p>
      )}
      <ul className="space-y-1">
        {rows.map((entry, i) => {
          const color = getColor?.(entry) ?? resolveTooltipColor(entry);
          let valueNode: ReactNode = entry.value;
          let nameNode: ReactNode = entry.name;

          if (formatter) {
            const formatted = formatter(entry.value, String(entry.name ?? ""), entry);
            if (Array.isArray(formatted)) {
              [valueNode, nameNode] = formatted;
            } else {
              valueNode = formatted;
            }
          }

          return (
            <li key={`${String(entry.name)}-${i}`} className="flex items-center gap-2">
              <span
                className="size-2.5 shrink-0 rounded-sm ring-1 ring-foreground/10"
                style={{ backgroundColor: color }}
                aria-hidden
              />
              <span className="min-w-0 flex-1 text-muted-foreground">{nameNode}</span>
              <span className="shrink-0 font-medium tabular-nums text-foreground">{valueNode}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 工厂：避免在 render 中内联 content 导致重挂载 */
export function chartTooltipContent(options?: ChartTooltipOptions) {
  // Recharts TooltipContentProps 与精简 entry 类型不完全一致，此处做桥接
  return function ChartTooltip(props: ChartTooltipContentProps) {
    return <ChartTooltipContent {...props} {...options} />;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** 依赖变化时稳定 Tooltip content 引用 */
export function useChartTooltip(options: ChartTooltipOptions, deps: readonly unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式传入
  return useMemo(() => chartTooltipContent(options), deps);
}

export const CHART_TOOLTIP_CURSOR = { fill: "var(--muted)", fillOpacity: 0.25 };
