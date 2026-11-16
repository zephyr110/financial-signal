import Link from "next/link";
import { Card, CardContent } from "./ui/card";
import { cn } from "@/lib/utils";
import { parseItemTime, formatTime } from "@/lib/format";
import SignalBadge from "./SignalBadge";

interface NewsCardProps {
  item: {
    id?: number | string;
    rich_text?: string;
    content?: string;
    docurl?: string;
    published_at?: string;
    create_time?: string;
    analysis?: {
      id: number;
      signal_score: number;
      category: string;
    } | null;
  };
  index: number;
}

export default function NewsCard({ item, index }: NewsCardProps) {
  const isAnimated = index < 10;
  const time = parseItemTime(item);
  const text = item.rich_text || item.content || "";
  const analysis = item.analysis;
  const hasSignal = analysis && analysis.signal_score >= 3;

  return (
    <Card
      className={cn(
        isAnimated && "news-card",
        analysis && !hasSignal && "opacity-80"
      )}
      style={isAnimated ? { animationDelay: `${index * 50}ms` } : undefined}
    >
      <CardContent className="p-4 sm:p-5 flex gap-3 sm:gap-4">
        <span className="text-xs lg:text-sm text-muted-foreground tabular-nums shrink-0 mt-[5px] font-medium">
          {formatTime(time)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm lg:text-base leading-loose text-foreground">
            {text}
          </p>
          {(item.docurl || analysis) && (
            <div className="flex items-center gap-2 pt-1.5">
              {item.docurl && (
                <a
                  href={item.docurl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary no-underline"
                >
                  阅读原文
                </a>
              )}
              {analysis && (
                <span className="text-xs text-muted-foreground">
                  {analysis.category || ""}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Signal badge: 3+ 可点进详情；低分/待分析用 showLowScores 区分样式 */}
        <div className="shrink-0 flex items-start mt-[3px]">
          {hasSignal ? (
            // 徽章自身带 tooltip；再套一层会被 base-ui 的嵌套触发抑制，永远弹不出来
            <Link
              href={`/signal/${analysis.id}`}
              aria-label={`查看信号分析（信号强度 ${analysis.signal_score}）`}
            >
              <SignalBadge score={analysis.signal_score} size="sm" />
            </Link>
          ) : (
            <SignalBadge
              score={analysis?.signal_score ?? 0}
              size="sm"
              showLowScores
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}
