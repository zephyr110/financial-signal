"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { useTheme } from "next-themes";
import { ChevronRight, LogOut, Monitor, Moon, Settings, Sun } from "lucide-react";
import { Avatar, AvatarFallback } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "./ui/sidebar";
import SettingsDialog from "./settings-dialog";
import { cn } from "@/lib/utils";

function GithubIcon() {
  return (
    <svg className="size-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

const THEME_MODES = [
  ["light", Sun, "浅色"],
  ["dark", Moon, "深色"],
  ["system", Monitor, "系统"],
];

/**
 * 侧栏底部头像菜单（参考 zlog admin-sidebar）：
 * 用户信息卡 + 主题切换（segmented 按钮组）+ 设置 / GitHub / 退出登录。
 * 折叠为 icon rail 时仅显示头像。
 */
export default function AvatarMenu() {
  const router = useRouter();
  const { isMobile } = useSidebar();
  const { theme, setTheme } = useTheme();
  const [username, setUsername] = useState("");
  const avatarInitial = username ? username.charAt(0).toUpperCase() : "";
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.username) setUsername(d.username);
      })
      .catch(() => {});
  }, []);

  const logout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      router.replace("/login");
    }
  };

  return (
    <>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <SidebarMenuButton
                tooltip={username || "账户"}
                className="h-10 w-full gap-2.5 py-2.5 data-open:bg-sidebar-accent"
              >
                <Avatar size="sm" className="size-8 shrink-0">
                  <AvatarFallback className="bg-sidebar-primary text-xs font-bold text-sidebar-primary-foreground">
                    {avatarInitial}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-medium">{username || "…"}</p>
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
              <p className="min-w-0 flex-1 truncate text-sm font-medium">{username || "…"}</p>
            </div>

            <DropdownMenuSeparator className="mx-0 my-2" />

            {/* 主题切换：segmented 按钮组（与 zlog 一致，非子菜单） */}
            <div className="flex flex-col gap-1.5 px-0.5">
              <p className="px-1.5 text-xs font-medium text-muted-foreground">
                主题
              </p>
              <div className="inline-flex w-full rounded-lg bg-muted p-1">
                {THEME_MODES.map(([mode, Icon, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setTheme(mode)}
                    aria-label={label}
                    className={cn(
                      "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all duration-200",
                      theme === mode
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    )}
                  >
                    <Icon size={14} />
                    <span className="hidden sm:inline">{label}</span>
                  </button>
                ))}
              </div>
            </div>

            <DropdownMenuSeparator className="mx-0 my-2" />

            {/* 设置 / GitHub / 退出 */}
            <div className="flex flex-col gap-0.5">
              <DropdownMenuItem
                className="cursor-pointer gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent hover:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={16} className="shrink-0 opacity-60" />
                设置
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer gap-2.5 rounded-md px-2.5 py-2 hover:bg-accent hover:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                onClick={() => window.open("https://github.com/zephyr110/financial-signal", "_blank", "noopener")}
              >
                <GithubIcon />
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

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        username={username}
        onAccountChanged={setUsername}
      />
    </>
  );
}
