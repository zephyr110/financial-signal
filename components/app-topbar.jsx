import Link from "next/link";
import { useRouter } from "next/router";
import { LayoutGrid, RefreshCw, SunMedium } from "lucide-react";
import { SidebarTrigger } from "./ui/sidebar";
import { Button, buttonVariants } from "./ui/button";
import { Separator } from "./ui/separator";
import { isCockpitPath } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { NotificationBell } from "./cockpit/notification-bell";

/**
 * 右侧列顶栏：左侧触发按钮（折叠 rail / 移动端抽屉）+ 页面标题 + 右侧操作区。
 * 位于滚动容器之外，固定高度，无 sticky/滚动监听。
 */
export default function AppTopbar({ title, subtitle = null, actions = null }) {
  const router = useRouter();
  const cockpit = isCockpitPath(router.pathname);
  const switchHref = cockpit ? "/" : "/today";
  const switchLabel = cockpit ? "打开财经信号工作台" : "打开收盘手记";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 sm:px-4">
      {/* 交互色：默认 muted，hover 高亮 + accent 底，与刷新按钮一致 */}
      <SidebarTrigger
        className="-ml-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="切换侧栏"
      />
      <div className="flex min-w-0 items-center gap-2">
        {/* 顶栏标题用 p：页面内容区有自己的 h1，避免每页双 h1（SEO/层级） */}
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
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
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {actions}
        <Link
          href={switchHref}
          aria-label={switchLabel}
          title={switchLabel}
          className={cn(
            buttonVariants({ variant: "ghost", size: "icon" }),
            "text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          )}
        >
          {cockpit ? <LayoutGrid className="size-4" /> : <SunMedium className="size-4" />}
        </Link>
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
