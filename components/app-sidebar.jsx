import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
import {
  BookOpen,
  Bot,
  Briefcase,
  ListChecks,
  Newspaper,
  Settings,
  Star,
  SunMedium,
  TrendingUp,
} from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  SIDEBAR_FOOTER_ICON_BTN,
  SIDEBAR_FOOTER_ICON_ITEM,
  SIDEBAR_ICON_RAIL_MENU,
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

const COCKPIT_ITEMS = [
  { href: "/today", label: "今日收盘", icon: SunMedium, match: (p) => p === "/today" },
  {
    href: "/watchlist",
    label: "自选",
    icon: Star,
    match: (p) => p === "/watchlist" || p.startsWith("/stock/"),
  },
  { href: "/portfolio", label: "持仓", icon: Briefcase, match: (p) => p === "/portfolio" },
  { href: "/research", label: "研究", icon: BookOpen, match: (p) => p === "/research" },
  { href: "/tasks", label: "任务", icon: ListChecks, match: (p) => p === "/tasks" },
];

const NAV_GROUPS = [
  { label: "导航", items: NAV_ITEMS },
  { label: "收盘手记", items: COCKPIT_ITEMS },
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
      <SidebarHeader className="group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:py-2">
        <SidebarMenu className={SIDEBAR_ICON_RAIL_MENU}>
          <SidebarMenuItem className={SIDEBAR_FOOTER_ICON_ITEM}>
            <SidebarMenuButton
              size="lg"
              tooltip="收盘手记"
              className={SIDEBAR_FOOTER_ICON_BTN}
              render={<Link href="/today" className="no-underline" />}
            >
              <BrandLogo className="size-7 group-data-[collapsible=icon]:size-6" />
              <span className="truncate text-base font-semibold tracking-tight text-sidebar-foreground group-data-[collapsible=icon]:hidden">
                收盘手记
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="gap-1">
        {NAV_GROUPS.map((group) => (
          <SidebarGroup className="gap-1" key={group.label}>
            <SidebarGroupLabel className="mb-1">{group.label}</SidebarGroupLabel>
            <SidebarMenu className="gap-0.5">
              {group.items.map((item) => {
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
        ))}

        {sidebarExtra}
      </SidebarContent>

      <SidebarFooter className="gap-0 border-t-0 p-0">
        <SidebarMenu className={cn("gap-1 px-2 py-2", SIDEBAR_ICON_RAIL_MENU, "group-data-[collapsible=icon]:gap-1")}>
          <SidebarMenuItem className={SIDEBAR_FOOTER_ICON_ITEM}>
            {/* 应用级设置常驻入口(头像菜单外的第二入口已在菜单内移除) */}
            <SidebarMenuButton
              tooltip="设置"
              onClick={() => setSettingsOpen(true)}
              aria-label="设置"
              className={SIDEBAR_FOOTER_ICON_BTN}
            >
              <Settings />
              <span className="group-data-[collapsible=icon]:hidden">设置</span>
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
