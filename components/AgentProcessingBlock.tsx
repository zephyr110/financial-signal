import { useEffect, useState } from "react";
import {
  Wrench,
  Loader2,
  CheckCircle2,
  XCircle,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import type { ProcessingBlock, ToolCallInfo } from "@/types/agent-chat";
import { getToolLabel } from "@/lib/agent/tool-labels";

interface AgentProcessingBlockProps {
  processing: ProcessingBlock;
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-0.5 pl-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1 rounded-full bg-muted-foreground/50 animate-bounce"
          style={{ animationDelay: `${i * 0.15}s`, animationDuration: "0.9s" }}
        />
      ))}
    </span>
  );
}

function StatusBadge({ tool }: { tool: ToolCallInfo }) {
  if (tool.status === "done") {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 border-positive/25 bg-positive/5 text-positive"
      >
        <CheckCircle2 data-icon="inline-start" />
        完成
      </Badge>
    );
  }
  if (tool.status === "error") {
    return (
      <Badge variant="destructive" className="h-5 gap-1">
        <XCircle data-icon="inline-start" />
        失败
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="h-5 gap-1 text-muted-foreground">
      <Loader2 data-icon="inline-start" className="animate-spin" />
      执行中
    </Badge>
  );
}

/** 单轮思考 + 工具调用：进行中展开，完成后自动折叠（shadcn Collapsible + 过渡动画） */
export function AgentProcessingBlock({ processing }: AgentProcessingBlockProps) {
  const { tools, active, thinking } = processing;
  const [open, setOpen] = useState(active);

  useEffect(() => {
    if (active) {
      setOpen(true);
      return;
    }
    const timer = window.setTimeout(() => setOpen(false), 600);
    return () => window.clearTimeout(timer);
  }, [active]);

  const doneCount = tools.filter((t) => t.status === "done").length;
  const errorCount = tools.filter((t) => t.status === "error").length;
  const runningCount = tools.filter(
    (t) => t.status !== "done" && t.status !== "error"
  ).length;

  const summaryLabel = active
    ? thinking && tools.length === 0
      ? "思考中"
      : runningCount > 0
        ? `调用工具中`
        : thinking
          ? "思考中"
          : `已调用 ${tools.length} 个工具`
    : tools.length > 0
      ? `已调用 ${tools.length} 个工具`
      : "思考过程";

  return (
    <div className="w-full min-w-0">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "overflow-hidden rounded-xl bg-card text-card-foreground ring-1 ring-foreground/10 transition-[box-shadow,ring-color] duration-300",
            active && "ring-primary/20 shadow-sm",
            open && !active && "shadow-xs"
          )}
        >
          <CollapsibleTrigger
            className={cn(
              "flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-left text-sm outline-none",
              "transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset",
              open && "bg-muted/30"
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{summaryLabel}</span>
              {active && (thinking || runningCount > 0) && (
                <span className="ml-1.5 inline-flex items-center text-muted-foreground">
                  <ThinkingDots />
                </span>
              )}
            </span>

            {!active && tools.length > 0 && (
              <Badge
                variant="outline"
                className={cn(
                  "hidden h-5 shrink-0 sm:inline-flex",
                  errorCount > 0
                    ? "border-destructive/30 bg-destructive/5 text-destructive"
                    : "border-positive/25 bg-positive/5 text-positive"
                )}
              >
                {errorCount > 0 ? `${errorCount} 失败` : `${doneCount} 完成`}
              </Badge>
            )}

            <ChevronDown
              className={cn(
                "size-4 shrink-0 text-muted-foreground transition-transform duration-300",
                open && "rotate-180"
              )}
            />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-300 ease-in-out",
                open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              )}
            >
              <div className="overflow-hidden">
                <Separator className="" />
                <div className="space-y-0 px-3.5 py-3">
                  {thinking && (
                    <div className="relative flex items-start gap-3 pb-3">
                      <span className="relative z-10 mt-1.5 flex size-2 shrink-0 rounded-full bg-primary/80 ring-4 ring-card" />
                      <div className="min-w-0 flex-1 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-2">
                          正在分析并规划下一步
                          {active && <ThinkingDots />}
                        </span>
                      </div>
                    </div>
                  )}

                  {tools.length > 0 && (
                    <div
                      className={cn(
                        "relative space-y-2",
                        (thinking || tools.length > 1) &&
                          "before:absolute before:top-1 before:bottom-1 before:left-[3px] before:w-px before:bg-border"
                      )}
                    >
                      {tools.map((tool, i) => (
                        <ToolStepRow
                          key={`${tool.name}-${i}`}
                          tool={tool}
                          isLast={i === tools.length - 1}
                          showTimeline={tools.length > 1 || thinking}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}

function ToolStepRow({
  tool,
  isLast,
  showTimeline,
}: {
  tool: ToolCallInfo;
  isLast: boolean;
  showTimeline: boolean;
}) {
  const [argsOpen, setArgsOpen] = useState(tool.status === "running");

  useEffect(() => {
    if (tool.status === "running") setArgsOpen(true);
  }, [tool.status]);

  return (
    <Collapsible open={argsOpen} onOpenChange={setArgsOpen}>
      <div className={cn("relative", showTimeline && "pl-5", !isLast && "pb-1")}>
        {showTimeline && (
          <span
            className={cn(
              "absolute top-2.5 left-0 z-10 size-2 rounded-full ring-4 ring-card",
              tool.status === "done"
                ? "bg-positive"
                : tool.status === "error"
                  ? "bg-destructive"
                  : "bg-muted-foreground/40"
            )}
          />
        )}

        <div className="overflow-hidden rounded-lg ring-1 ring-foreground/8">
          <CollapsibleTrigger
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-xs outline-none",
              "transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
              argsOpen && "bg-muted/25"
            )}
          >
            <Wrench className="size-3 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">
              {getToolLabel(tool.name)}
            </span>
            <StatusBadge tool={tool} />
            <ChevronDown
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                argsOpen && "rotate-180"
              )}
            />
          </CollapsibleTrigger>

          <CollapsibleContent>
            <div
              className={cn(
                "grid transition-[grid-template-rows,opacity] duration-200 ease-in-out",
                argsOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
              )}
            >
              <div className="overflow-hidden">
                <Separator className="" />
                <div className="space-y-2 bg-muted/20 p-3">
                  <div>
                    <p className="mb-1 font-mono text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      参数
                    </p>
                    <pre className="overflow-x-auto rounded-md bg-background/80 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-foreground/6 whitespace-pre-wrap">
                      {JSON.stringify(tool.args, null, 2)}
                    </pre>
                  </div>
                  {tool.summary && (
                    <div>
                      <p className="mb-1 font-mono text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                        结果摘要
                      </p>
                      <p className="rounded-md bg-background/80 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground ring-1 ring-foreground/6 whitespace-pre-wrap break-all">
                        {tool.summary}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </div>
    </Collapsible>
  );
}
