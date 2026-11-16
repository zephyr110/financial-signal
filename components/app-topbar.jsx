import { RefreshCw, Search } from "lucide-react";
import { SidebarTrigger } from "./ui/sidebar";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./cockpit/notification-bell";

/**
 * 右侧列顶栏：左侧触发按钮（折叠 rail / 移动端抽屉）+ 页面标题 + 右侧操作区。
 * 位于滚动容器之外，固定高度，无 sticky/滚动监听。
 */
export default function AppTopbar({ title, subtitle = null, actions = null }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/70 bg-background px-3 sm:px-4">
      {/* 交互色：默认 muted，hover 高亮 + accent 底，与刷新按钮一致 */}
      <SidebarTrigger
        className="-ml-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="切换侧栏"
      />
      <div className="flex min-w-0 items-center gap-2">
        {/* 顶栏标题用 p：页面内容区有自己的 h1，避免每页双 h1（SEO/层级） */}
        <p className="truncate text-[15px] font-semibold leading-5 tracking-tight text-foreground">{title}</p>
        {subtitle && (
          <>
            <Separator
              orientation="vertical"
              className="hidden md:block h-3.5"
            />
            <span className="hidden md:inline truncate text-xs text-muted-foreground">
              {subtitle}
            </span>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={() => window.dispatchEvent(new Event("app:command-open"))}
        aria-label="搜索与命令（⌘K）"
        className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/70 bg-muted/40 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-40 sm:justify-start sm:px-2 md:w-52"
      >
        <Search className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="hidden flex-1 truncate text-left sm:inline">搜索页面、标的…</span>
        <kbd className="hidden shrink-0 rounded border bg-background px-1 text-[10px] md:inline">⌘K</kbd>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <NotificationBell />
      </div>
    </header>
  );
}

export function TopbarRefreshButton({ onClick, refreshing, label = "刷新数据" }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onClick}
      disabled={refreshing}
      className={cn(
        "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        !refreshing && "active:scale-95"
      )}
      title={label}
      aria-label={label}
    >
      <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
    </Button>
  );
}
