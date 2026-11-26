import Link from "next/link";
import { Card, CardContent } from "./ui/card";
import { Badge } from "./ui/badge";
import { Hint } from "./ui/hint";
import { cn } from "@/lib/utils";
import {
  CATEGORY_LABELS,
  SCORE_COLORS,
  SENTIMENT_LABELS,
  sourceDisplayName,
} from "@/lib/constants";
import { parseItemTime, formatTime, formatDate } from "@/lib/format";
import { track } from "@/lib/track";

// 分类沿用原色相，但改成和情绪标签相同的浅底描边，避免两类标签一重一轻
const CATEGORY_BADGE: Record<string, string> = {
  policy: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  geopolitics: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  industry: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  company: "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300",
  macro: "border-purple-500/30 bg-purple-500/10 text-purple-700 dark:text-purple-300",
  market_rumor: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

// 所有底部标签共用这套形状，只靠上面的语义色区分
const BADGE_BASE = "h-[18px] rounded-full px-1.5 py-0 text-[11px] font-medium";
const NEUTRAL_BADGE = "border-border text-muted-foreground";

// A股惯例：红涨绿跌；方向另有文字标签，不靠颜色单独传达
const SENTIMENT_BADGE: Record<string, string> = {
  positive: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  negative: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  // 不加 bg-muted：#6b7280 落在 #f3f4f6 上只有 4.39:1，11px 文字要 4.5。
  neutral: NEUTRAL_BADGE,
  mixed: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export default function AnalysisNewsCard({ item }) {
  const time = parseItemTime(item);
  const timeLabel = formatTime(time);
  const dateLabel = formatDate(time);
  const companies = item.companies || [];

  const card = (
    <Card className="group cursor-pointer py-0 transition-colors duration-200 hover:bg-muted/50">
      <CardContent className="px-3 py-2.5">
        <div className="flex items-start gap-2.5">
          <span className={cn(
            "inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold shrink-0",
            SCORE_COLORS[item.signal_score] || SCORE_COLORS[1]
          )}>
            {item.signal_score}
          </span>

          <div className="min-w-0 flex-1">
            <Hint content={item.summary}>
              <p className="text-sm leading-snug text-foreground font-medium line-clamp-2">
                {item.summary}
              </p>
            </Hint>

            {item.content && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground line-clamp-1">
                {item.content}
              </p>
            )}

            <div className="mt-1.5 flex items-center gap-x-1.5 gap-y-1 flex-wrap">
              <Badge
                variant="outline"
                className={cn(
                  BADGE_BASE,
                  CATEGORY_BADGE[item.category] || NEUTRAL_BADGE,
                )}
              >
                {CATEGORY_LABELS[item.category] || item.category}
              </Badge>

              {SENTIMENT_LABELS[item.sentiment] && (
                <Badge
                  variant="outline"
                  className={cn(
                    BADGE_BASE,
                    SENTIMENT_BADGE[item.sentiment] || NEUTRAL_BADGE,
                  )}
                >
                  {SENTIMENT_LABELS[item.sentiment]}
                </Badge>
              )}

              {item.source && (
                <Badge variant="outline" className={cn(BADGE_BASE, NEUTRAL_BADGE)}>
                  {sourceDisplayName(item.source)}
                </Badge>
              )}

              {item.industries?.map((ind) => (
                <Badge
                  key={ind}
                  variant="outline"
                  className={cn(BADGE_BASE, NEUTRAL_BADGE)}
                >
                  {ind}
                </Badge>
              ))}

              <span className="text-[11px] text-muted-foreground ml-auto tabular-nums whitespace-nowrap">
                {dateLabel} {timeLabel}
              </span>
            </div>

            {companies.length > 0 && (
              <Hint content={`个股：${companies.join("、")}`}>
                <p className="mt-1 text-[11px] text-muted-foreground truncate">
                  个股：{companies.join("、")}
                </p>
              </Hint>
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
