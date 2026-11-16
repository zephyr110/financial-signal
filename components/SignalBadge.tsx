import { cn } from "@/lib/utils";
import { Hint } from "@/components/ui/hint";

const SCORE_STYLES: Record<number, string> = {
  5: "bg-red-600 text-white",
  4: "bg-orange-500 text-white",
  3: "bg-yellow-500 text-white",
  2: "bg-gray-400 text-white",
  1: "bg-gray-300 text-gray-600",
};

const SIZE_CLASSES = {
  sm: "w-5 h-5 text-[10px]",
  md: "w-6 h-6 text-xs",
  lg: "w-8 h-8 text-xs",
};

interface SignalBadgeProps {
  score: number;
  size?: "sm" | "md" | "lg";
  clickable?: boolean;
  /** 为 true 时展示 1–2 分（虚线圆 + 数字）；默认隐藏以减少噪声 */
  showLowScores?: boolean;
  className?: string;
}

/**
 * 信号分圆形徽章，与 lib/constants SCORE_COLORS 配色一致。
 *
 * - 3–5 分：实心彩色圆 + 数字
 * - 1–2 分：虚线圆 + 数字（需 showLowScores）
 * - 0 / null / NaN：点线空圆，表示待分析
 */
export default function SignalBadge({
  score,
  size = "md",
  clickable = false,
  showLowScores = false,
  className,
}: SignalBadgeProps) {
  const isUnanalyzed = score == null || score === 0 || Number.isNaN(score);

  if (isUnanalyzed) {
    return (
      <Hint content="待分析">
        <span
          className={cn(
            "inline-block shrink-0 rounded-full border border-dotted border-muted-foreground/35 bg-muted/20",
            SIZE_CLASSES[size],
            className
          )}
          aria-label="待分析"
        />
      </Hint>
    );
  }

  if (score <= 2) {
    if (!showLowScores) return null;
    return (
      <Hint content={`低分信号（${score} 分）`}>
        <span
          className={cn(
            "inline-flex items-center justify-center rounded-full border border-dashed border-muted-foreground/40 font-medium text-muted-foreground shrink-0",
            SIZE_CLASSES[size],
            className
          )}
          aria-label={`低分信号 ${score} 分`}
        >
          {score}
        </span>
      </Hint>
    );
  }

  const style = SCORE_STYLES[score] || SCORE_STYLES[3];

  return (
    <Hint content={`信号强度 ${score}`}>
      <span
        className={cn(
          "inline-flex items-center justify-center rounded-full font-bold shrink-0 select-none",
          style,
          SIZE_CLASSES[size],
          clickable && "cursor-pointer hover:scale-110 active:scale-95 transition-transform",
          className
        )}
        aria-label={`信号强度 ${score}`}
      >
        {score}
      </span>
    </Hint>
  );
}
