import { createContext, useContext, useEffect, useRef } from "react";
import { useRouter } from "next/router";
import { SidebarInset, SidebarProvider } from "./ui/sidebar";
import AppSidebar from "./app-sidebar";
import AppTopbar from "./app-topbar";
import { MobileBottomNav } from "./mobile-bottom-nav";

// 内容滚动容器 ref——首页下拉刷新读 scrollTop、区块导航 IntersectionObserver 传 root
const AppShellScrollContext = createContext(null);
export function useAppShellScroll() {
  return useContext(AppShellScrollContext);
}

/**
 * 全局 App 壳（shadcn sidebar-07 模式）：
 * 左侧全局侧栏（导航分组 + 页面专属分组）+ 右侧列（顶栏 + 内容滚动区）。
 * 滚动容器内为 mx-auto 内容列，由各页面自行排布。
 * scrollable=false 时（agent 页）滚动容器改为 flex-col 透传，页面管理自身滚动。
 */
export default function AppShell({
  title,
  subtitle = null,
  actions = null,
  sidebarExtra = null,
  scrollable = true,
  children,
}) {
  const scrollRef = useRef(null);
  const router = useRouter();

  // PWA 离线壳是产品级能力，注册放在共用壳里，旧工作台直接进入时也能装上。
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* 离线能力不可用时不影响在线使用 */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  // 会话过期兜底：middleware 只在导航时校验，页面停留期间会话失效时由这里跳回登录页
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => {
        if (r.status === 401) {
          router.replace(`/login?next=${encodeURIComponent(router.asPath)}`);
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SidebarProvider className="flex h-dvh min-h-0 w-full overflow-hidden">
      <a
        href="#app-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        跳到主要内容
      </a>
      <AppSidebar sidebarExtra={sidebarExtra} />
      <SidebarInset className="min-w-0 flex-1 overflow-hidden">
        <AppTopbar title={title} subtitle={subtitle} actions={actions} />
        <AppShellScrollContext.Provider value={scrollRef}>
          {scrollable ? (
            <div
              ref={scrollRef}
              id="app-content"
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-y-auto overscroll-none pb-[calc(3.5rem+env(safe-area-inset-bottom))] outline-none lg:pb-0"
            >
              {children}
            </div>
          ) : (
            <div
              ref={scrollRef}
              id="app-content"
              tabIndex={-1}
              className="flex min-h-0 flex-1 flex-col pb-[calc(3.5rem+env(safe-area-inset-bottom))] outline-none lg:pb-0"
            >
              {children}
            </div>
          )}
        </AppShellScrollContext.Provider>
      </SidebarInset>
      <MobileBottomNav />
    </SidebarProvider>
  );
}
