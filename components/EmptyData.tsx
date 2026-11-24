import type { ReactNode } from "react";
import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyDataProps {
  /** 提示文案，默认「暂无数据」 */
  message?: ReactNode;
  /** 可选操作（如手动抓取），放在提示语下方 */
  action?: ReactNode;
  /** 所在模块需要固定高度时传入（如与图表高度对齐） */
  className?: string;
}

/** 统一空态占位：inbox 图标 + 提示语，在所在模块内水平垂直居中。 */
export function EmptyData({ message = "暂无数据", action, className }: EmptyDataProps) {
  return (
    <div
      className={cn(
        "flex min-h-32 w-full flex-col items-center justify-center gap-2 px-4 py-6 text-center text-[13px] text-muted-foreground",
        className
      )}
    >
      <div role="status" className="flex flex-col items-center gap-2">
        <Inbox className="size-6 shrink-0 text-muted-foreground/60" aria-hidden="true" />
        <span className="max-w-sm leading-relaxed">{message}</span>
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export default EmptyData;
