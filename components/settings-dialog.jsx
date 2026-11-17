"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useTheme } from "next-themes";
import { CheckCircle2, Clock, Cpu, Database, Globe, Loader2, Monitor, Moon, Palette, RotateCcw, Save, Sun, UserRound, XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Hint } from "./ui/hint";
import { clearClientCaches, cn } from "@/lib/utils";

/**
 * 设置弹窗（头像菜单「设置」→ 弹窗）：
 * - 账号：修改登录名 / 密码（需当前密码）
 * - 外观：主题模式（next-themes，只存本机浏览器）
 * - 模型：LLM_MODEL / LLM_BASE_URL / LLM_API_KEY（30s 缓存热生效，无需重启）
 * - 联网搜索：WEB_SEARCH_PROVIDER / WEB_SEARCH_API_KEY（研究助手「联网」开关使用）
 * - 数据与存储：本地数据库（默认）/ Turso 云端（可选，重启生效）+ TUSHARE_TOKEN
 * - 自动刷新：桌面端内置调度（默认）或外部 Cron 的 CRON_SECRET
 * 布局参考 reelay-sensee：左栏标题+分组导航，右侧面板叠在同一 grid 格子里，
 * 非当前面板用 invisible 保留高度，切换时弹窗不抽动。
 * 文本类字段留空保存 = 清除该项（恢复环境变量默认）；密钥类留空 = 保持不变。
 */
const THEME_MODES = [
  ["light", Sun, "浅色"],
  ["dark", Moon, "深色"],
  ["system", Monitor, "系统"],
];

const PANELS = [
  { id: "account", label: "账号", group: "账号", icon: UserRound },
  { id: "appearance", label: "外观", group: "偏好", icon: Palette },
  { id: "model", label: "模型", group: "服务配置", icon: Cpu },
  { id: "websearch", label: "联网搜索", group: "服务配置", icon: Globe },
  { id: "turso", label: "数据与存储", group: "服务配置", icon: Database },
  { id: "cron", label: "自动刷新", group: "服务配置", icon: Clock },
];

export default function SettingsDialog({ open, onOpenChange, username, onAccountChanged }) {
  // 表单状态（初始值在 open 时从 GET /api/settings 拉取）
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [panel, setPanel] = useState(PANELS[0].id);

  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [clearedKeys, setClearedKeys] = useState(new Set());

  const [tursoUrl, setTursoUrl] = useState("");
  const [tursoToken, setTursoToken] = useState("");
  const [tursoUrlSet, setTursoUrlSet] = useState(false);
  const [tursoTokenSet, setTursoTokenSet] = useState(false);
  const [storage, setStorage] = useState({
    backend: "local", source: "default", locked: false, urlSet: false, tokenSet: false,
    activeBackend: "local", restartRequired: false,
  });
  const [storageBackend, setStorageBackend] = useState("local");
  // 读取失败时不能按默认值保存，否则会用「本地库」覆盖已保存的 Turso 配置
  const [storageLoadFailed, setStorageLoadFailed] = useState(false);
  const [clearTursoToken, setClearTursoToken] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [scheduler, setScheduler] = useState(null);

  const [tushareToken, setTushareToken] = useState("");
  const [tushareTokenSet, setTushareTokenSet] = useState(false);

  const [cronSecret, setCronSecret] = useState("");
  const [cronSecretSet, setCronSecretSet] = useState(false);

  const [webSearchProvider, setWebSearchProvider] = useState("");
  const [webSearchKey, setWebSearchKey] = useState("");
  const [webSearchKeySet, setWebSearchKeySet] = useState(false);

  // 账号表单
  const [accUsername, setAccUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const { theme, setTheme } = useTheme();
  const router = useRouter();

  // 打开时拉取当前配置（仅在打开/关闭转换时重置；账号改名回调更新 username prop 时保持 okMsg 可见）
  const prevOpen = useRef(false);
  useEffect(() => {
    if (prevOpen.current === open) return;
    prevOpen.current = open;
    if (!open) return;
    setPanel(PANELS[0].id);
    setLoaded(false);
    setError(null);
    setOkMsg(null);
    setClearedKeys(new Set());
    setApiKey("");
    setTursoUrl("");
    setTursoToken("");
    setClearTursoToken(false);
    setStorageLoadFailed(false);
    setTushareToken("");
    setCronSecret("");
    setWebSearchKey("");
    setAccUsername(username || "");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setScheduler(null);
    const desktopBridge = typeof window !== "undefined" ? window.desktop : null;
    setIsDesktop(Boolean(desktopBridge?.getScheduler));
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        setModel(d.llm?.model ?? "");
        setBaseUrl(d.llm?.baseUrl ?? "");
        setApiKeySet(Boolean(d.llm?.apiKeySet));
        setStorage(d.storage || {});
        setStorageBackend(d.storage?.backend === "turso" ? "turso" : "local");
        setTursoUrlSet(Boolean(d.storage?.urlSet));
        setTursoTokenSet(Boolean(d.storage?.tokenSet));
        setTushareTokenSet(Boolean(d.tushare?.tokenSet));
        setCronSecretSet(Boolean(d.cronSecretSet));
        setWebSearchProvider(d.webSearch?.provider ?? "");
        setWebSearchKeySet(Boolean(d.webSearch?.apiKeySet));
        setStorageLoadFailed(false);
        setLoaded(true);
      })
      .catch(() => {
        setError("读取配置失败，请稍后重试");
        setStorageLoadFailed(true);
        setLoaded(true);
      });
    if (desktopBridge?.getScheduler) {
      desktopBridge.getScheduler()
        .then((r) => { if (r?.ok) setScheduler({ enabled: r.enabled, intervalMs: r.intervalMs }); })
        .catch(() => setScheduler(null));
    }
  }, [open, username]);

  const clearKey = (key) => {
    setClearedKeys((s) => new Set(s).add(key));
  };
  const restoreKey = (key) => {
    setClearedKeys((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
  };

  const secretInputProps = (key, value, setter, isSet) => ({
    value,
    onChange: (e) => {
      setter(e.target.value);
      if (e.target.value) restoreKey(key);
    },
    type: "password",
    autoComplete: "new-password",
    placeholder: isSet ? "已设置，留空保持不变" : "未设置",
  });

  const saveSettings = async () => {
    setSaving(true);
    setError(null);
    setOkMsg(null);
    const body = {
      llmModel: model,
      llmBaseUrl: baseUrl,
      ...(apiKey ? { llmApiKey: apiKey } : clearedKeys.has("llmApiKey") ? { llmApiKey: "" } : {}),
      ...(tushareToken ? { tushareToken } : clearedKeys.has("tushareToken") ? { tushareToken: "" } : {}),
      ...(cronSecret ? { cronSecret } : clearedKeys.has("cronSecret") ? { cronSecret: "" } : {}),
      webSearchProvider,
      ...(webSearchKey ? { webSearchApiKey: webSearchKey } : clearedKeys.has("webSearchApiKey") ? { webSearchApiKey: "" } : {}),
    };
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "保存失败，请重试");
        return;
      }
      // 刷新掩码状态
      const d = await fetch("/api/settings").then((r) => r.json());
      setApiKeySet(Boolean(d.llm?.apiKeySet));
      setTursoUrlSet(Boolean(d.storage?.urlSet));
      setTursoTokenSet(Boolean(d.storage?.tokenSet));
      setStorage(d.storage || {});
      setTushareTokenSet(Boolean(d.tushare?.tokenSet));
      setCronSecretSet(Boolean(d.cronSecretSet));
      setWebSearchProvider(d.webSearch?.provider ?? "");
      setWebSearchKeySet(Boolean(d.webSearch?.apiKeySet));
      setClearedKeys(new Set());
      setApiKey("");
      setTursoToken("");
      setTushareToken("");
      setCronSecret("");
      setWebSearchKey("");
      setOkMsg("已保存");
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  // 数据库后端在连库前就要确定，因此单独写启动配置，保存后必须重启
  const saveStorage = async () => {
    setSaving(true);
    setError(null);
    setOkMsg(null);
    const body = { storageBackend };
    if (storageBackend === "turso") {
      if (tursoUrl.trim()) body.tursoUrl = tursoUrl.trim();
      if (clearTursoToken) body.tursoToken = null;
      else if (tursoToken.trim()) body.tursoToken = tursoToken.trim();
    }
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(d.error || "保存失败，请重试");
        return;
      }
      const fresh = await fetch("/api/settings").then((r) => r.json()).catch(() => null);
      if (fresh?.storage) {
        setStorage(fresh.storage);
        setStorageBackend(fresh.storage.backend === "turso" ? "turso" : "local");
        setTursoUrlSet(Boolean(fresh.storage.urlSet));
        setTursoTokenSet(Boolean(fresh.storage.tokenSet));
      }
      setTursoUrl("");
      setTursoToken("");
      setClearTursoToken(false);
      setOkMsg(d.restartRequired ? "已保存，重启应用后生效" : "已保存");
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const saveScheduler = async () => {
    if (!scheduler || !window.desktop?.setScheduler) return;
    setSaving(true);
    setError(null);
    setOkMsg(null);
    try {
      const r = await window.desktop.setScheduler({
        enabled: scheduler.enabled,
        intervalMinutes: Math.round(scheduler.intervalMs / 60000),
      });
      if (!r?.ok) {
        setError(r?.error || "保存失败，请重试");
        return;
      }
      setScheduler({ enabled: r.enabled, intervalMs: r.intervalMs });
      setOkMsg("自动刷新设置已保存");
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const saveAccount = async () => {
    setSaving(true);
    setError(null);
    setOkMsg(null);
    if (newPassword !== confirmPassword) {
      setError("两次输入的新密码不一致");
      setSaving(false);
      return;
    }
    try {
      const res = await fetch("/api/auth/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword,
          ...(accUsername !== username ? { username: accUsername } : {}),
          ...(newPassword ? { password: newPassword } : {}),
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setError(d.error || "修改失败，请重试");
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (d.sessionRevoked) {
        // 改密/改名已吊销全部会话(含本会话)——先提示,再跳登录页重新登录
        setOkMsg("账号信息已更新，请重新登录");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setTimeout(async () => {
          await clearClientCaches();
          router.replace("/login");
        }, 1200);
        return;
      }
      setOkMsg("账号信息已更新");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      onAccountChanged?.(accUsername.trim() || username);
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const sectionClass = (id) =>
    cn("col-start-1 row-start-1 space-y-4", panel !== id && "invisible");

  const saveButton = (onClick, extraDisabled = false) => (
    <div className="flex justify-end">
      <Button size="sm" className="gap-1.5" onClick={onClick} disabled={saving || !loaded || extraDisabled}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
        保存
      </Button>
    </div>
  );

  // 纯图标按钮：tooltip 同时充当无障碍名
  const clearButton = (key, label = "清除已保存的值") => (
    <Hint content={label}>
      <Button type="button" variant="outline" size="icon" aria-label={label} onClick={() => clearKey(key)}>
        <RotateCcw className="size-4" />
      </Button>
    </Hint>
  );

  const accountInitial = (username || accUsername).trim().charAt(0).toUpperCase();
  const schedulerMinutes = scheduler ? Math.round(scheduler.intervalMs / 60000) : 30;
  const schedulerOptions = Array.from(new Set([15, 30, 60, 120, schedulerMinutes])).sort((a, b) => a - b);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
      >
        <div className="flex min-h-0 flex-1 max-sm:flex-col">
          {/* 左栏：标题与分组导航共处一列，标题同时充当弹窗无障碍名 */}
          <div className="w-44 shrink-0 border-r border-border p-3 pt-4 max-sm:w-full max-sm:border-r-0 max-sm:border-b">
            <DialogHeader className="h-10 justify-center gap-0 px-2.5 text-left">
              <DialogTitle>设置</DialogTitle>
              <DialogDescription className="sr-only">账号、外观与服务配置</DialogDescription>
            </DialogHeader>

            {/* 窄屏 5 项竖排太占高：改两列网格并省略分组标题（桌面仍是参考的纵向分组导航） */}
            <nav aria-label="设置" className="flex flex-col gap-0.5 max-sm:grid max-sm:grid-cols-2 max-sm:gap-1">
              {PANELS.map((item, index) => {
                const active = panel === item.id;
                return (
                  <Fragment key={item.id}>
                    {/* 分组标题整组只出一次 */}
                    {item.group !== PANELS[index - 1]?.group && (
                      <p className={cn("px-2.5 pb-1.5 text-xs font-medium text-muted-foreground max-sm:hidden", index > 0 && "pt-4")}>
                        {item.group}
                      </p>
                    )}
                    <button
                      type="button"
                      aria-current={active ? "true" : undefined}
                      onClick={() => setPanel(item.id)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "bg-accent font-medium text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      )}
                    >
                      <item.icon className="size-4 shrink-0" />
                      {item.label}
                    </button>
                  </Fragment>
                );
              })}
            </nav>
          </div>

          {/* 右侧：面板叠在同一个 grid 格子里，高度天然等于最高的面板，切换不抽动 */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
            <div className="p-6 sm:pt-10">
              {error && (
                <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
              )}
              {okMsg && (
                <div className="mb-4 flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-3.5 shrink-0" />
                  {okMsg}
                </div>
              )}

              <div className="grid">
                {/* ── 账号 ── */}
                <section className={sectionClass("account")}>
                  <div className="flex items-center gap-4 rounded-lg bg-muted p-4">
                    <Avatar className="size-14 shrink-0">
                      <AvatarFallback className="bg-primary text-xl font-semibold text-primary-foreground">
                        {accountInitial}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{username || "—"}</p>
                      <p className="mt-1 text-xs text-muted-foreground">当前登录账号</p>
                      <Badge variant="outline" className="mt-2 rounded-full px-2 py-0 text-[11px] font-normal text-muted-foreground">
                        单用户
                      </Badge>
                    </div>
                  </div>

                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <div className="space-y-2">
                      <label htmlFor="account-username" className="text-sm font-medium">登录名</label>
                      <Input
                        id="account-username"
                        value={accUsername}
                        onChange={(e) => setAccUsername(e.target.value)}
                        placeholder="当前登录名"
                        autoComplete="off"
                        disabled={!loaded}
                        className="bg-background"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2 sm:col-span-2">
                        <label htmlFor="account-current-password" className="text-sm font-medium">当前密码（必填）</label>
                        <Input
                          id="account-current-password"
                          type="password"
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          placeholder="输入当前密码以确认修改"
                          autoComplete="current-password"
                          disabled={!loaded}
                          className="bg-background"
                        />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="account-new-password" className="text-sm font-medium">新密码（可选）</label>
                        <Input
                          id="account-new-password"
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="至少 6 位；留空则不修改"
                          autoComplete="new-password"
                          disabled={!loaded}
                          className="bg-background"
                        />
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="account-confirm-password" className="text-sm font-medium">确认新密码</label>
                        <Input
                          id="account-confirm-password"
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          placeholder="再次输入新密码"
                          autoComplete="new-password"
                          disabled={!loaded}
                          className="bg-background"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">修改登录名或密码需验证当前密码；保存成功后会退出所有会话，需重新登录。</p>
                    {saveButton(saveAccount, !currentPassword)}
                  </div>
                </section>

                {/* ── 外观 ── */}
                <section className={sectionClass("appearance")}>
                  <div className="space-y-2.5 rounded-lg bg-muted p-4">
                    <label className="text-sm font-medium">主题</label>
                    <div className="grid grid-cols-3 gap-2" role="group" aria-label="主题">
                      {THEME_MODES.map(([mode, Icon, label]) => {
                        const active = theme === mode;
                        return (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setTheme(mode)}
                            aria-pressed={active}
                            className={cn(
                              "flex flex-col items-center gap-2 rounded-md border bg-background px-3 py-3 text-xs transition-colors",
                              active
                                ? "border-primary text-foreground shadow-sm"
                                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                            )}
                          >
                            <Icon className="size-5" />
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground">主题偏好保存在本机浏览器，不随账号同步；切换后立即生效。</p>
                  </div>
                </section>

                {/* ── 模型 ── */}
                <section className={sectionClass("model")}>
                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <div className="space-y-2">
                      <label htmlFor="llm-model" className="text-sm font-medium">模型 (LLM_MODEL)</label>
                      <Input
                        id="llm-model"
                        value={model}
                        onChange={(e) => setModel(e.target.value)}
                        placeholder="留空使用环境变量（默认 deepseek-v4-flash）"
                        disabled={!loaded}
                        className="bg-background"
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="llm-base-url" className="text-sm font-medium">接口地址 (LLM_BASE_URL)</label>
                      <Input
                        id="llm-base-url"
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder="留空使用环境变量（默认 https://api.deepseek.com/v1）"
                        disabled={!loaded}
                        className="bg-background"
                      />
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="llm-api-key" className="text-sm font-medium">API Key (LLM_API_KEY)</label>
                      <div className="flex gap-2">
                        <Input
                          id="llm-api-key"
                          {...secretInputProps("llmApiKey", apiKey, setApiKey, apiKeySet)}
                          className="flex-1 bg-background"
                          disabled={!loaded}
                        />
                        {apiKeySet && clearButton("llmApiKey", "清除已保存的 Key")}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">模型/接口/Key 保存在应用内（app_settings 表），保存后约 30 秒内热生效，无需重启。</p>
                    {saveButton(saveSettings)}
                  </div>
                </section>

                {/* ── 联网搜索 ── */}
                <section className={sectionClass("websearch")}>
                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <div className="space-y-2">
                      <span className="text-sm font-medium">服务商 (WEB_SEARCH_PROVIDER)</span>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          ["", "自动"],
                          ["bocha", "博查"],
                          ["tavily", "Tavily"],
                        ].map(([value, label]) => {
                          const active = webSearchProvider === value;
                          return (
                            <button
                              key={value || "auto"}
                              type="button"
                              onClick={() => setWebSearchProvider(value)}
                              aria-pressed={active}
                              disabled={!loaded}
                              className={cn(
                                "rounded-md border bg-background px-3 py-2 text-xs transition-colors",
                                active
                                  ? "border-primary text-foreground shadow-sm"
                                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                              )}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="web-search-key" className="text-sm font-medium">API Key (WEB_SEARCH_API_KEY)</label>
                      <div className="flex gap-2">
                        <Input
                          id="web-search-key"
                          {...secretInputProps("webSearchApiKey", webSearchKey, setWebSearchKey, webSearchKeySet)}
                          className="flex-1 bg-background"
                          disabled={!loaded}
                        />
                        {webSearchKeySet && clearButton("webSearchApiKey")}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      自动：按已配置的 BOCHA_API_KEY / TAVILY_API_KEY 推断（优先博查）。仅在研究助手打开「联网」开关后调用；保存后约 30 秒内热生效。
                    </p>
                    {saveButton(saveSettings)}
                  </div>
                </section>

                {/* ── 数据与存储 ── */}
                <section className={sectionClass("turso")}>
                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">数据库存储</span>
                      <Badge variant="outline" className="rounded-full px-2 py-0 text-[11px] font-normal text-muted-foreground">
                        当前：{storage.activeBackend === "turso" ? "Turso 云端" : "本地数据库"}
                      </Badge>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="数据库存储">
                      {[
                        ["local", "本地数据库", "默认 · 无云端用量限制"],
                        ["turso", "Turso 云端", "可选 · 多设备共享同一远端库"],
                      ].map(([value, title, desc]) => {
                        const active = storageBackend === value;
                        return (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setStorageBackend(value)}
                            aria-pressed={active}
                            disabled={!loaded || storage.locked || storageLoadFailed}
                            className={cn(
                              "rounded-md border bg-background px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                              active
                                ? "border-primary text-foreground shadow-sm"
                                : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                            )}
                          >
                            <span className="block text-sm font-medium">{title}</span>
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">{desc}</span>
                          </button>
                        );
                      })}
                    </div>
                    {storageBackend === "turso" && !storage.locked && (
                      <>
                        <div className="space-y-2">
                          <label htmlFor="turso-url" className="text-sm font-medium">数据库 URL</label>
                          <Input
                            id="turso-url"
                            value={tursoUrl}
                            onChange={(e) => setTursoUrl(e.target.value)}
                            placeholder={tursoUrlSet ? "已配置，留空保持不变" : "libsql://…"}
                            disabled={!loaded}
                            className="bg-background"
                          />
                        </div>
                        <div className="space-y-2">
                          <label htmlFor="turso-token" className="text-sm font-medium">鉴权 Token</label>
                          <Input
                            id="turso-token"
                            {...secretInputProps("tursoToken", tursoToken, (value) => {
                              setTursoToken(value);
                              if (value) setClearTursoToken(false);
                            }, tursoTokenSet)}
                            className="bg-background"
                            disabled={!loaded}
                          />
                          {tursoTokenSet && (clearTursoToken ? (
                            <p className="text-xs text-muted-foreground">保存后将清除已存 Token（URL 保留）。</p>
                          ) : (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="self-start"
                              onClick={() => {
                                setClearTursoToken(true);
                                setTursoToken("");
                              }}
                            >
                              清除已保存的 Token
                            </Button>
                          ))}
                        </div>
                      </>
                    )}
                    {storage.locked && (
                      <p className="text-xs text-muted-foreground">
                        当前后端由环境变量（DB_BACKEND / Vercel）控制，设置中不可切换。
                      </p>
                    )}
                    {storageLoadFailed && (
                      <p className="text-xs text-destructive">
                        读取存储配置失败，保存已锁定以免覆盖现有 Turso 凭据；请关闭设置后重试。
                      </p>
                    )}
                    {storage.restartRequired && (
                      <p className="text-xs text-amber-600 dark:text-amber-400">存储选择已保存，重启应用后生效。</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      默认使用本地 SQLite（news_archive.db），不消耗云端额度。切换到 Turso 后需重启；云端是独立空库，不会自动迁移或同步本地数据。
                    </p>
                    {saveButton(saveStorage, storage.locked || storageLoadFailed)}
                  </div>

                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <div className="space-y-2">
                      <label htmlFor="tushare-token" className="text-sm font-medium">Tushare Pro Token (TUSHARE_TOKEN)</label>
                      <div className="flex gap-2">
                        <Input
                          id="tushare-token"
                          {...secretInputProps("tushareToken", tushareToken, setTushareToken, tushareTokenSet)}
                          className="flex-1 bg-background"
                          disabled={!loaded}
                        />
                        {tushareTokenSet && clearButton("tushareToken")}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">Tushare 只提供 T1 行情/交易日历；官方公告与政策直接取交易所、巨潮、证监会页面。Token 保存后约 30 秒热生效。</p>
                    {saveButton(saveSettings)}
                  </div>
                </section>

                {/* ── 自动刷新 ── */}
                <section className={sectionClass("cron")}>
                  {isDesktop && scheduler ? (
                    <div className="space-y-3 rounded-lg bg-muted p-4">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">内置调度</span>
                        <Badge variant="outline" className="rounded-full px-2 py-0 text-[11px] font-normal text-muted-foreground">
                          {scheduler.enabled ? "已开启" : "已暂停"}
                        </Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2" role="group" aria-label="内置调度">
                        {[
                          [true, "开启", "按间隔自动抓取与分析"],
                          [false, "暂停", "仅保留手动刷新"],
                        ].map(([value, title, desc]) => {
                          const active = scheduler.enabled === value;
                          return (
                            <button
                              key={String(value)}
                              type="button"
                              onClick={() => setScheduler((s) => ({ ...s, enabled: value }))}
                              aria-pressed={active}
                              disabled={!loaded}
                              className={cn(
                                "rounded-md border bg-background px-3 py-2 text-left transition-colors",
                                active
                                  ? "border-primary text-foreground shadow-sm"
                                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                              )}
                            >
                              <span className="block text-sm font-medium">{title}</span>
                              <span className="mt-0.5 block text-[11px] text-muted-foreground">{desc}</span>
                            </button>
                          );
                        })}
                      </div>
                      <div className="space-y-2">
                        <label htmlFor="scheduler-interval" className="text-sm font-medium">检查间隔</label>
                        <select
                          id="scheduler-interval"
                          value={schedulerMinutes}
                          onChange={(e) => setScheduler((s) => ({ ...s, intervalMs: Number(e.target.value) * 60000 }))}
                          disabled={!loaded || !scheduler.enabled}
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                        >
                          {schedulerOptions.map((m) => (
                            <option key={m} value={m}>{m} 分钟</option>
                          ))}
                        </select>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        每轮依次触发抓取、分析、事件线索与行情；各接口自身按交易日和任务节流，未配置模型 Key 时只抓取不分析。保存后立即重启内置调度。
                      </p>
                      {saveButton(saveScheduler)}
                    </div>
                  ) : isDesktop ? (
                    <div className="rounded-lg bg-muted p-4">
                      <p className="text-sm font-medium">内置调度配置不可用</p>
                      <p className="mt-1 text-xs text-muted-foreground">重启应用后再试；不影响手动刷新。</p>
                    </div>
                  ) : (
                    <div className="rounded-lg bg-muted p-4">
                      <p className="text-sm font-medium">Web 部署无常驻调度</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        请用外部 Cron 调用 /api/cron/*，或在桌面版使用内置调度。数据库仍默认存本地（Vercel 除外）。
                      </p>
                    </div>
                  )}

                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <p className="text-sm font-medium">外部 Cron（可选）</p>
                    <div className="space-y-2">
                      <label htmlFor="cron-secret" className="text-sm font-medium">CRON_SECRET</label>
                      <div className="flex gap-2">
                        <Input
                          id="cron-secret"
                          {...secretInputProps("cronSecret", cronSecret, setCronSecret, cronSecretSet)}
                          className="flex-1 bg-background"
                          disabled={!loaded}
                        />
                        {cronSecretSet && clearButton("cronSecret")}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      仅在使用 Vercel Cron / QStash / GitHub Actions 触发时需要；桌面端内置调度无需填写。保存在应用内，约 30 秒内热生效。
                    </p>
                    {saveButton(saveSettings)}
                  </div>
                </section>
              </div>
            </div>
          </div>
        </div>

        <DialogClose
          render={
            <Button variant="ghost" size="icon-sm" className="absolute top-4 right-4" aria-label="关闭" />
          }
        >
          <XIcon />
          <span className="sr-only">关闭</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
