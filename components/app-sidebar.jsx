import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import { Newspaper, TrendingUp, Bot, Settings } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar";
import BrandLogo from "./BrandLogo";
import AvatarMenu from "./avatar-menu";
import SettingsDialog from "./settings-dialog";

const NAV_ITEMS = [
  { href: "/", label: "新闻快讯", icon: Newspaper, match: (p) => p === "/" },
  {
    href: "/analysis",
    label: "信号分析",
    icon: TrendingUp,
    match: (p) =>
      p === "/analysis" || p.startsWith("/signal/") || p.startsWith("/thread/") || p === "/analytics/value",
  },
  { href: "/agent", label: "研究助手", icon: Bot, match: (p) => p === "/agent" },
];

/**
 * 全局侧栏（sidebar-07 折叠分区模式）：
 * Header 品牌 → 导航分组 → 页面专属分组（sidebarExtra）→ Footer
 * （应用操作：设置 gear 行 + 分隔线 + 头像菜单：主题/GitHub/退出）。
 * 用户信息(username/desktop)在此统一拉取,设置弹窗与头像菜单共用。
 */
export default function AppSidebar({ sidebarExtra = null, ...props }) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const closeOnMobile = () => setOpenMobile(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [username, setUsername] = useState("");
  // 桌面模式标记:与 pages/index.tsx 一致,同步读 preload 注入的 window.desktop
  // (不再经 /api/auth/me 异步探测——首帧会闪现"退出登录"与空用户名)
  const [desktop, setDesktop] = useState(
    typeof window !== "undefined" && !!window.desktop
  );

  // 会话用户信息(设置弹窗「账户」面板与头像显示共用):桌面模式无会话,me.ts 也不返回 username
  useEffect(() => {
    if (desktop) return;
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.username) setUsername(d.username);
        if (d?.desktop) setDesktop(true);
      })
      .catch(() => {});
  }, [desktop]);

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" className="no-underline" />}>
              <BrandLogo className="size-7" />
              <span className="truncate text-base font-semibold tracking-tight text-sidebar-foreground">
                财经信号
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-1">
        <SidebarGroup className="gap-1">
          <SidebarGroupLabel className="mb-1">导航</SidebarGroupLabel>
          <SidebarMenu className="gap-0.5">
            {NAV_ITEMS.map((item) => {
              const active = item.match(router.pathname);
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    render={
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className="no-underline"
                      />
                    }
                    isActive={active}
                    tooltip={item.label}
                    onClick={closeOnMobile}
                    className="py-2.5 data-active:!bg-sidebar-primary/10 data-active:!text-sidebar-primary"
                  >
                    <item.icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>

        {sidebarExtra}
      </SidebarContent>

      <SidebarFooter className="gap-0 p-0">
        <SidebarMenu className="gap-0.5 px-2 py-2">
          <SidebarMenuItem>
            {/* 应用级设置常驻入口(头像菜单外的第二入口已在菜单内移除) */}
            <SidebarMenuButton
              tooltip="设置"
              onClick={() => setSettingsOpen(true)}
              aria-label="设置"
              className="h-10 w-full gap-2.5 py-2.5"
            >
              <Settings />
              <span>设置</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {/* 应用操作区与身份区之间的分割线(shadcn SidebarSeparator):
              展开态两端各留 8px(叠加容器 px-2 共 16px);
              折叠 icon rail 态归零内缩,线宽对齐 32px 图标列。 */}
          <SidebarMenuItem aria-hidden="true">
            <SidebarSeparator className="mx-2 my-0.5 group-data-[collapsible=icon]:mx-0" />
          </SidebarMenuItem>
          <AvatarMenu username={username} desktop={desktop} />
        </SidebarMenu>
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          username={username}
          onAccountChanged={setUsername}
          desktop={desktop}
        />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
