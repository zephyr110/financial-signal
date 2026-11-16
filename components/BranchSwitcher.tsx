import { ChevronLeft, ChevronRight } from "lucide-react";
import type { MessageVersions } from "@/types/agent-chat";
import { cn } from "@/lib/utils";

interface BranchSwitcherProps {
  versions: MessageVersions;
  disabled?: boolean;
  onSelect: (id: string) => void;
  className?: string;
}

/** 消息版本切换：左右箭头 + 序号，单版本时由调用方直接不渲染 */
export function BranchSwitcher({ versions, disabled = false, onSelect, className }: BranchSwitcherProps) {
  const { ids, index } = versions;
  if (ids.length <= 1) return null;
  const hasPrev = index > 0;
  const hasNext = index < ids.length - 1;

  return (
    <span
      role="group"
      aria-label="消息版本"
      className={cn("inline-flex items-center gap-0.5 text-xs text-muted-foreground", className)}
    >
      <button
        type="button"
        aria-label="上一版本"
        disabled={disabled || !hasPrev}
        onClick={() => onSelect(ids[index - 1])}
        className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
      >
        <ChevronLeft className="size-3.5" />
      </button>
      <span className="min-w-9 text-center tabular-nums" aria-live="polite">
        {index + 1} / {ids.length}
      </span>
      <button
        type="button"
        aria-label="下一版本"
        disabled={disabled || !hasNext}
        onClick={() => onSelect(ids[index + 1])}
        className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
      >
        <ChevronRight className="size-3.5" />
      </button>
    </span>
  );
}
