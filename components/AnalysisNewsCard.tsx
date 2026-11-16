import Link from "next/link";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABELS,
  CATEGORY_COLORS,
  SCORE_COLORS,
  SENTIMENT_LABELS,
  sourceDisplayName,
} from "@/lib/constants";
import { parseItemTime, formatTime, formatDate } from "@/lib/format";
import { track } from "@/lib/track";

// A股惯例：红涨绿跌；方向另有文字标签，不靠颜色单独传达
const SENTIMENT_TONE: Record<string, string> = {
  positive: "text-red-600 dark:text-red-400",
  negative: "text-emerald-600 dark:text-emerald-400",
  neutral: "text-muted-foreground",
  mixed: "text-amber-600 dark:text-amber-400",
};

export default function AnalysisNewsCard({ item }) {
  const time = parseItemTime(item);
  const timeLabel = formatTime(time);
  const dateLabel = formatDate(time);
  const companies = item.companies || [];

  const card = (
    <Card className="group cursor-pointer py-0 transition-colors duration-200 hover:ring-primary hover:shadow-sm">
      <CardContent className="px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <span className={cn(
            "inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold shrink-0",
            SCORE_COLORS[item.signal_score] || SCORE_COLORS[1]
          )}>
            {item.signal_score}
          </span>

          <div className="min-w-0 flex-1">
            <p
              className="text-sm leading-snug text-foreground font-medium line-clamp-2"
              title={item.summary}
            >
              {item.summary}
            </p>

            {item.content && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-1">
                {item.content}
              </p>
            )}

            <div className="mt-1.5 flex items-center gap-x-1.5 gap-y-1 flex-wrap">
              <Badge className={cn("h-[18px] text-[11px] px-1.5 py-0", CATEGORY_COLORS[item.category])}>
                {CATEGORY_LABELS[item.category] || item.category}
              </Badge>

              {SENTIMENT_LABELS[item.sentiment] && (
                <span className={cn("text-[11px] font-medium", SENTIMENT_TONE[item.sentiment])}>
                  {SENTIMENT_LABELS[item.sentiment]}
                </span>
              )}

              {item.source && (
                <Badge variant="secondary" className="h-[18px] text-[11px] px-1.5 py-0">
                  {sourceDisplayName(item.source)}
                </Badge>
              )}

              {item.industries?.map((ind) => (
                <Badge key={ind} variant="outline" className="h-[18px] text-[11px] px-1.5 py-0">
                  {ind}
                </Badge>
              ))}

              <span className="text-[11px] text-muted-foreground ml-auto tabular-nums whitespace-nowrap">
                {dateLabel} {timeLabel}
              </span>
            </div>

            {companies.length > 0 && (
              <p
                className="mt-1 text-[11px] text-muted-foreground truncate"
                title={`个股：${companies.join("、")}`}
              >
                个股：{companies.join("、")}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );

  // 卡片整体可点击 → 跳转信号详情页（analysis_id 为 analysis_result 主键）
  if (!item.analysis_id) return card;
  return (
    <Link
      href={`/signal/${item.analysis_id}`}
      className="block h-full"
      onClick={() => track('signal_click', { id: item.analysis_id })}
    >
      {card}
    </Link>
  );
}
