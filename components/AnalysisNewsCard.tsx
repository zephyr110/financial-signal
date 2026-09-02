import Link from "next/link";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, CATEGORY_COLORS, SCORE_COLORS, sourceDisplayName } from "@/lib/constants";
import { parseItemTime, formatTime, formatDate } from "@/lib/format";
import { track } from "@/lib/track";

export default function AnalysisNewsCard({ item }) {
  const time = parseItemTime(item);
  const timeLabel = formatTime(time);
  const dateLabel = formatDate(time);

  const card = (
    <Card className="group cursor-pointer transition-all duration-200 hover:border-primary hover:shadow-sm h-full">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-start gap-3 sm:gap-4">
          <span className={cn(
            "inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold shrink-0",
            SCORE_COLORS[item.signal_score] || SCORE_COLORS[1]
          )}>
            {item.signal_score}
          </span>

          <div className="min-w-0 flex-1">
            <p className="text-sm lg:text-base leading-loose text-foreground font-medium">
              {item.summary}
            </p>

            <p className="mt-2.5 text-xs text-muted-foreground">
              {item.content}
            </p>

            <div className="mt-2.5 flex items-center gap-2 flex-wrap">
              <Badge className={cn("text-xs px-1.5 py-0", CATEGORY_COLORS[item.category])}>
                {CATEGORY_LABELS[item.category] || item.category}
              </Badge>

              {item.source && (
                <Badge variant="secondary" className="text-xs px-1.5 py-0">
                  {sourceDisplayName(item.source)}
                </Badge>
              )}

              {item.industries?.map((ind) => (
                <Badge key={ind} variant="outline" className="text-xs px-1.5 py-0">
                  {ind}
                </Badge>
              ))}

              <span className="text-xs text-muted-foreground ml-auto tabular-nums">
                {dateLabel} {timeLabel}
              </span>
            </div>
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
