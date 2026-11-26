import { useState } from "react";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export interface FocusStockReason {
  text: string;
  stance: "positive" | "negative" | "neutral" | "mixed" | string;
}

export interface FocusStock {
  name: string;
  code: string | null;
  reasons?: FocusStockReason[];
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
  },
  bearish: {
    label: "看跌",
    labelClass: "text-emerald-600 dark:text-emerald-400",
  },
  watch: {
    label: "待观察",
    labelClass: "text-muted-foreground",
  },
} as const;

type Tone = keyof typeof TONE;

const REASON_TONE: Record<string, { label: string; className: string }> = {
  positive: { label: "偏多", className: "text-red-600 dark:text-red-400" },
  negative: { label: "偏空", className: "text-emerald-600 dark:text-emerald-400" },
  neutral: { label: "中性", className: "text-muted-foreground" },
  mixed: { label: "多空交织", className: "text-amber-600 dark:text-amber-400" },
};

function FocusStockItem({ tone, stock }: { tone: Tone; stock: FocusStock }) {
  const reasons = stock.reasons || [];
  return (
    <li className="text-xs leading-relaxed">
      <div className="flex flex-wrap items-baseline gap-1.5">
        {stock.code ? (
          <Link
            href={`/stock/${encodeURIComponent(stock.code)}`}
            className="font-medium text-foreground hover:text-primary hover:underline"
          >
            {stock.name}
          </Link>
        ) : (
          <span className="font-medium text-foreground">{stock.name}</span>
        )}
        {stock.code && (
          <span className="text-[10px] font-normal tabular-nums text-muted-foreground">
            {stock.code}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-muted-foreground">
        <span className="font-medium text-foreground/70">依据：</span>
        {reasons.length > 0 ? (
          reasons.map((reason, index) => (
            <span key={`${reason.stance}-${index}`}>
              {index > 0 && "；"}
              {tone === "watch" && REASON_TONE[reason.stance] && (
                <span className={cn("mr-0.5", REASON_TONE[reason.stance].className)}>
                  {REASON_TONE[reason.stance].label}
                </span>
              )}
              {reason.text}
            </span>
          ))
        ) : (
          <span>暂无分析摘要，依据成员新闻情绪加权判定。</span>
        )}
      </p>
    </li>
  );
}

export default function FocusStocks({
  stocks,
  className,
  defaultOpen = false,
}: {
  stocks?: FocusStocksData;
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const groups = (["bullish", "bearish", "watch"] as const)
    .map((tone) => ({ tone, stocks: stocks?.[tone] || [] }))
    .filter((group) => group.stocks.length > 0);
  if (groups.length === 0) return null;
  const summary = groups
    .map((group) => `${TONE[group.tone].label} ${group.stocks.length}`)
    .join(" · ");

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("overflow-hidden rounded-lg border", className)}
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
        <span className="shrink-0 text-xs font-medium text-foreground">重点个股</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{summary}</span>
        <ChevronDown
          className={cn(
            "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-t px-3 py-2.5">
          {groups.map(({ tone, stocks: groupStocks }) => (
            <section key={tone}>
              <h4 className={cn("text-xs font-medium", TONE[tone].labelClass)}>
                {TONE[tone].label}
              </h4>
              <ol className="mt-1 list-decimal space-y-2 pl-5 marker:text-muted-foreground">
                {groupStocks.map((stock) => (
                  <FocusStockItem key={stock.code || stock.name} tone={tone} stock={stock} />
                ))}
              </ol>
            </section>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
