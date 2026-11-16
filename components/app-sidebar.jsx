import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/router";
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
import { SIDEBAR_GROUPS } from "@/lib/nav";
import { track } from "@/lib/track";
import {
  SIDEBAR_FOOTER_ICON_ITEM,
  SIDEBAR_ICON_RAIL_MENU,
} from "@/lib/sidebar-footer-classes";

/**
 * 全局侧栏（sidebar-07 折叠分区模式）：
 * Header 品牌 → 导航分组 → 页面专属分组（sidebarExtra）→ Footer
 * （Footer 只有头像菜单：设置/GitHub/退出；主题切换在设置弹窗「外观」）。
 * 用户信息(username)在此统一拉取,设置弹窗与头像菜单共用。
 */
export default function AppSidebar({ sidebarExtra = null, ...props }) {
  const router = useRouter();
  const { setOpenMobile } = useSidebar();
  const closeOnMobile = () => setOpenMobile(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [username, setUsername] = useState("");

  // 打开设置顺带收起移动端侧栏；弹窗挂在 Sidebar 外，不会被 Sheet 卸载
  const openSettings = () => {
    closeOnMobile();
    setSettingsOpen(true);
  };

  // 命令面板打开设置：事件只触发一次打开，不需要随渲染重新绑定
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const openFromPalette = () => openSettings();
    window.addEventListener("app:open-settings", openFromPalette);
    return () => window.removeEventListener("app:open-settings", openFromPalette);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.username) setUsername(d.username);
      })
      .catch(() => {});
  }, []);

  return (
    <>
      <Sidebar collapsible="icon" {...props}>
        <SidebarHeader className="px-2 pb-1 pt-3 group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:py-2">
          <SidebarMenu className={SIDEBAR_ICON_RAIL_MENU}>
            <SidebarMenuItem className={SIDEBAR_FOOTER_ICON_ITEM}>
              <SidebarMenuButton
                size="lg"
                tooltip="财经信号"
                className="h-auto min-h-12 gap-2.5 rounded-lg px-2 py-1.5 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:p-0! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:items-center"
                render={<Link href="/" aria-label="财经信号 · 驾驶舱" className="no-underline" />}
              >
                <BrandLogo className="size-7 group-data-[collapsible=icon]:size-6" />
                <span className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
                  <span className="truncate text-[15px] font-semibold leading-5 tracking-tight text-sidebar-foreground">
                    财经信号
                  </span>
                  <span className="truncate text-[10px] font-medium uppercase leading-3 tracking-[0.16em] text-sidebar-foreground/45">
                    Financial Signal
                  </span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent className="gap-0">
          {SIDEBAR_GROUPS.map((group) => (
            <SidebarGroup className="gap-1 px-2 pb-1 pt-3 first:pt-1" key={group.label}>
              <SidebarGroupLabel className="mb-0.5 h-6 px-2 text-[11px] font-medium tracking-wide text-sidebar-foreground/55">
                {group.label}
              </SidebarGroupLabel>
              <SidebarMenu className="gap-0.5">
                {group.items.map((item) => {
                  const active = item.match(router.pathname);
                  // 只有 href 就是当前路径时才说“当前页”；子页面只标记所属分区。
                  const current = router.pathname === item.href;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        render={
                          <Link
                            href={item.href}
                            aria-current={active ? (current ? "page" : "true") : undefined}
                            className="no-underline"
                          />
                        }
                        isActive={active}
                        tooltip={item.label}
                        onClick={() => {
                          track("nav_click", { from: router.pathname, to: item.href, surface: "sidebar" });
                          closeOnMobile();
                        }}
                        className="h-9 gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-150 hover:bg-sidebar-accent/70 data-active:!bg-sidebar-primary/10 data-active:!text-sidebar-primary"
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
          <SidebarMenu className={cn("gap-1 px-2 pb-3 pt-2", SIDEBAR_ICON_RAIL_MENU, "group-data-[collapsible=icon]:gap-1")}>
            <AvatarMenu username={username} onOpenSettings={openSettings} />
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        username={username}
        onAccountChanged={setUsername}
      />
    </>
  );
}
