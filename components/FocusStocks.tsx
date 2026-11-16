import Link from "next/link";
import { cn } from "@/lib/utils";

export interface FocusStock {
  name: string;
  code: string | null;
}

export interface FocusStocksData {
  bullish?: FocusStock[];
  bearish?: FocusStock[];
  watch?: FocusStock[];
}

// A股惯例：红涨绿跌；方向同时有文字标签，不靠颜色单独传达
const TONE = {
  bullish: {
    label: "看涨",
    labelClass: "text-red-600 dark:text-red-400",
    chipClass:
      "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950 dark:text-red-300 dark:hover:bg-red-900",
  },
  bearish: {
    label: "看跌",
    labelClass: "text-emerald-600 dark:text-emerald-400",
    chipClass:
      "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300 dark:hover:bg-emerald-900",
  },
  watch: {
    label: "待观察",
    labelClass: "text-muted-foreground",
    chipClass:
      "bg-accent text-accent-foreground hover:bg-accent/80",
  },
};

function StockRow({
  tone,
  stocks,
}: {
  tone: "bullish" | "bearish" | "watch";
  stocks: FocusStock[];
}) {
  const style = TONE[tone];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={cn("text-xs font-medium shrink-0", style.labelClass)}>
        {style.label}
      </span>
      {stocks.length === 0 ? (
        <span className="text-xs text-muted-foreground">暂无</span>
      ) : (
        stocks.map((stock) =>
          stock.code ? (
            <Link
              key={stock.code}
              href={`/stock/${encodeURIComponent(stock.code)}`}
              className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-xs transition-colors",
                style.chipClass
              )}
            >
              {stock.name}
            </Link>
          ) : (
            <span
              key={stock.name}
              className="inline-flex items-center rounded bg-accent px-1.5 py-0.5 text-xs text-accent-foreground"
            >
              {stock.name}
            </span>
          )
        )
      )}
    </div>
  );
}

export default function FocusStocks({
  stocks,
  className,
}: {
  stocks?: FocusStocksData;
  className?: string;
}) {
  const bullish = stocks?.bullish || [];
  const bearish = stocks?.bearish || [];
  const watch = stocks?.watch || [];
  if (bullish.length === 0 && bearish.length === 0 && watch.length === 0) return null;
  return (
    <div className={cn("space-y-1", className)}>
      <StockRow tone="bullish" stocks={bullish} />
      <StockRow tone="bearish" stocks={bearish} />
      {watch.length > 0 && <StockRow tone="watch" stocks={watch} />}
    </div>
  );
}
