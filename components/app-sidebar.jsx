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
  useSidebar,
} from "./ui/sidebar";
import BrandLogo from "./BrandLogo";
import AvatarMenu from "./avatar-menu";
import SettingsDialog from "./settings-dialog";
import {
  SIDEBAR_FOOTER_ICON_BTN,
  SIDEBAR_FOOTER_ICON_ITEM,
} from "@/lib/sidebar-footer-classes";

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
 * （应用操作：设置 gear 行 + 头像菜单：主题/GitHub/退出）。
 * 用户信息(username)在此统一拉取,设置弹窗与头像菜单共用。
 */
export default function AppSidebar({ sidebarExtra = null, ...props }) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const closeOnMobile = () => setOpenMobile(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [username, setUsername] = useState("");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.username) setUsername(d.username);
      })
      .catch(() => {});
  }, []);

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

      <SidebarFooter className="gap-0 border-t-0 p-0">
        <SidebarMenu className="gap-1 px-2 py-2 group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:gap-1 group-data-[collapsible=icon]:px-0">
          <SidebarMenuItem className={SIDEBAR_FOOTER_ICON_ITEM}>
            {/* 应用级设置常驻入口(头像菜单外的第二入口已在菜单内移除) */}
            <SidebarMenuButton
              tooltip="设置"
              onClick={() => setSettingsOpen(true)}
              aria-label="设置"
              className={SIDEBAR_FOOTER_ICON_BTN}
            >
              <Settings />
              <span>设置</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <AvatarMenu username={username} />
        </SidebarMenu>
        <SettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          username={username}
          onAccountChanged={setUsername}
        />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
