"use client";

import { useState } from "react";
import { useRouter } from "next/router";
import { ChevronRight, GitBranch, LogOut, Settings } from "lucide-react";
import { Avatar, AvatarFallback } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "./ui/sidebar";
import { clearClientCaches, cn } from "@/lib/utils";
import { http } from "@/lib/http/client";
import {
  SIDEBAR_FOOTER_ICON_BTN,
  SIDEBAR_FOOTER_ICON_ITEM,
} from "@/lib/sidebar-footer-classes";

/**
 * 侧栏底部头像菜单（参考 zlog admin-sidebar）：
 * 用户信息卡 + 设置 / GitHub / 退出登录。
 * 设置弹窗是应用配置的唯一入口；主题切换在其「外观」面板里。
 * 折叠为 icon rail 时仅显示头像。
 * username 由 AppSidebar 统一拉取后传入(设置弹窗与头像共用一份用户信息)。
 */
export default function AvatarMenu({ username = "", onOpenSettings = undefined }) {
  const router = useRouter();
  const { isMobile } = useSidebar();
  const displayName = username;
  const avatarInitial = displayName ? displayName.charAt(0).toUpperCase() : "";
  const [loggingOut, setLoggingOut] = useState(false);

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await http.post("/api/auth/logout");
    } finally {
      await clearClientCaches();
      router.replace("/login");
    }
  };

  return (
    <>
      <SidebarMenuItem className={SIDEBAR_FOOTER_ICON_ITEM}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                tooltip={displayName || "账户"}
                className={cn(SIDEBAR_FOOTER_ICON_BTN, "data-open:bg-sidebar-accent")}
              >
                <Avatar
                  size="sm"
                  className="size-8 shrink-0 group-data-[collapsible=icon]:size-4 group-data-[collapsible=icon]:after:border-0"
                >
                  <AvatarFallback className="bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
                    {avatarInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-[13px] font-medium">{displayName || "…"}</p>
                </div>
                <ChevronRight
                  size={14}
                  className="shrink-0 text-muted-foreground transition-transform duration-200 group-aria-expanded:rotate-90 group-data-[collapsible=icon]:hidden"
                />
              </SidebarMenuButton>
            }
          />
          <DropdownMenuContent
            align="start"
            side={isMobile ? "top" : "right"}
            sideOffset={isMobile ? 6 : 8}
            className={cn("p-2", isMobile ? "w-(--anchor-width) max-w-[calc(100vw-1rem)]" : "w-64")}
          >
            {/* 用户信息 */}
            <div className="flex items-center gap-2.5 rounded-lg bg-muted px-3 py-2.5">
              <Avatar className="size-10 shrink-0">
                <AvatarFallback className="bg-primary text-sm font-bold text-primary-foreground">
                  {avatarInitial}
                </AvatarFallback>
              </Avatar>
              <p className="min-w-0 flex-1 truncate text-sm font-medium">{displayName || "…"}</p>
            </div>

            <DropdownMenuSeparator className="mx-0 my-2" />

            {/* 设置 / GitHub / 退出 */}
            <div className="flex flex-col gap-0.5">
              <DropdownMenuItem
                className="cursor-pointer gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent hover:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                onClick={() => onOpenSettings?.()}
              >
                <Settings size={16} className="shrink-0 opacity-60" />
                设置
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent hover:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                onClick={() => window.open("https://github.com/zephyr110/financial-signal", "_blank", "noopener")}
              >
                <GitBranch size={16} className="shrink-0 opacity-60" />
                GitHub
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                className="cursor-pointer gap-2.5 rounded-md px-2.5 py-2 hover:bg-destructive/10 dark:hover:bg-destructive/20 data-highlighted:bg-destructive/10 dark:data-highlighted:bg-destructive/20"
                onClick={logout}
                disabled={loggingOut}
              >
                <LogOut size={16} className="shrink-0 opacity-60" />
                退出登录
              </DropdownMenuItem>
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </>
  );
}
