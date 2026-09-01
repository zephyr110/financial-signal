import { useState } from "react";
import Link from "next/link";
import { ChevronDown, TrendingUp, AlertCircle, Zap, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { track } from "@/lib/track";

const stageLabels = {
  early: "早期",
  brewing: "发酵中",
  spreading: "全面扩散",
  priced_in: "成熟定价",
};

const stageColors = {
  early: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  brewing: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  spreading: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  priced_in: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

const confidenceIcons = {
  high: { icon: Zap, color: "text-amber-500" },
  medium: { icon: AlertCircle, color: "text-muted-foreground" },
};

export default function EventThreadList({ threads }) {
  return (
    <div className="bg-card border rounded-xl p-4 sm:p-5 mb-6">
      {!threads || threads.length === 0 ? (
        <p className="text-xs text-muted-foreground text-center py-8">
          暂无事件线索，数据分析完成后自动生成
        </p>
      ) : (
        <div className="space-y-3">
          {threads.map((thread) => (
            <EventThreadCard key={thread.id} thread={thread} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventThreadCard({ thread }) {
  const [open, setOpen] = useState(false);
  const ConfidenceIcon = confidenceIcons[thread.confidence]?.icon || AlertCircle;

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 p-3 text-left hover:bg-accent/50 transition-colors"
      >
        <ConfidenceIcon
          className={cn("h-4 w-4 shrink-0", confidenceIcons[thread.confidence]?.color)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">
              {thread.title}
            </span>
            <span className={cn(
              "text-xs px-1.5 py-0.5 rounded-full font-medium",
              stageColors[thread.stage] || stageColors.early
            )}>
              {stageLabels[thread.stage] || thread.stage}
            </span>
          </div>
          {!open && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
              {thread.narrative}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
          <span>{thread.news_ids?.length || 0} 条</span>
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
          />
        </div>
      </button>

      <div
        inert={open ? undefined : true}
        className={cn(
          "grid transition-all duration-300 ease-in-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="overflow-hidden min-h-0">
        <div className="px-3 pb-3 border-t pt-2 space-y-2">
          <p className="text-sm text-foreground leading-relaxed">
            {thread.narrative}
          </p>
          {thread.industries?.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs text-muted-foreground">涉及行业：</span>
              {thread.industries.map((ind: string) => (
                <span
                  key={ind}
                  className="text-xs px-1.5 py-0.5 rounded bg-accent text-accent-foreground"
                >
                  {ind}
                </span>
              ))}
            </div>
          )}
          {thread.watch_points?.length > 0 && (
            <div>
              <span className="text-xs text-muted-foreground">后续关注：</span>
              <ul className="mt-1 space-y-0.5">
                {thread.watch_points.map((p: string, i: number) => (
                  <li key={i} className="text-xs text-muted-foreground flex items-start gap-1">
                    <span className="text-primary mt-0.5">•</span>
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {thread.id != null && (
            <div className="pt-1.5">
              <Link
                href={`/thread/${thread.id}`}
                className="text-xs text-primary hover:underline inline-flex items-center gap-1"
                onClick={() => track('thread_expand', { id: thread.id })}
              >
                查看完整线索 <ExternalLink className="h-3 w-3" />
              </Link>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}
