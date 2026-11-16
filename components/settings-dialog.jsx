"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { useTheme } from "next-themes";
import { CheckCircle2, Clock, Cpu, Database, Loader2, Monitor, Moon, Palette, RotateCcw, Save, Sun, UserRound, XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Avatar, AvatarFallback } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { clearClientCaches, cn } from "@/lib/utils";

/**
 * 设置弹窗（头像菜单「设置」→ 弹窗）：
 * - 账号：修改登录名 / 密码（需当前密码）
 * - 外观：主题模式（next-themes，只存本机浏览器）
 * - 模型：LLM_MODEL / LLM_BASE_URL / LLM_API_KEY（30s 缓存热生效，无需重启）
 * - 数据源：TURSO_DATABASE_URL / TURSO_AUTH_TOKEN / TUSHARE_TOKEN（Turso 改动需重启）
 * - 定时任务：CRON_SECRET（30s 缓存热生效）
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
  { id: "turso", label: "数据源", group: "服务配置", icon: Database },
  { id: "cron", label: "定时任务", group: "服务配置", icon: Clock },
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

  const [tushareToken, setTushareToken] = useState("");
  const [tushareTokenSet, setTushareTokenSet] = useState(false);

  const [cronSecret, setCronSecret] = useState("");
  const [cronSecretSet, setCronSecretSet] = useState(false);

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
    setTursoToken("");
    setTushareToken("");
    setCronSecret("");
    setAccUsername(username || "");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        setModel(d.llm?.model ?? "");
        setBaseUrl(d.llm?.baseUrl ?? "");
        setApiKeySet(Boolean(d.llm?.apiKeySet));
        setTursoUrlSet(Boolean(d.turso?.urlSet));
        setTursoTokenSet(Boolean(d.turso?.tokenSet));
        setTushareTokenSet(Boolean(d.tushare?.tokenSet));
        setCronSecretSet(Boolean(d.cronSecretSet));
        setLoaded(true);
      })
      .catch(() => {
        setError("读取配置失败，请稍后重试");
        setLoaded(true);
      });
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
      ...(tursoUrl ? { tursoUrl } : clearedKeys.has("tursoUrl") ? { tursoUrl: "" } : {}),
      ...(tursoToken ? { tursoToken } : clearedKeys.has("tursoToken") ? { tursoToken: "" } : {}),
      ...(tushareToken ? { tushareToken } : clearedKeys.has("tushareToken") ? { tushareToken: "" } : {}),
      ...(cronSecret ? { cronSecret } : clearedKeys.has("cronSecret") ? { cronSecret: "" } : {}),
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
      setTursoUrlSet(Boolean(d.turso?.urlSet));
      setTursoTokenSet(Boolean(d.turso?.tokenSet));
      setTushareTokenSet(Boolean(d.tushare?.tokenSet));
      setCronSecretSet(Boolean(d.cronSecretSet));
      setClearedKeys(new Set());
      setApiKey("");
      setTursoToken("");
      setTushareToken("");
      setCronSecret("");
      setOkMsg("已保存" + (tursoUrl || clearedKeys.has("tursoUrl") || tursoToken || clearedKeys.has("tursoToken") ? "（Turso 数据源改动需重启应用生效）" : ""));
    } catch {
      setError("网络错误，请稍后重试");
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

  const accountInitial = (username || accUsername).trim().charAt(0).toUpperCase();

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
                        {apiKeySet && (
                          <Button type="button" variant="outline" size="icon" onClick={() => clearKey("llmApiKey")} title="清除已保存的 Key">
                            <RotateCcw className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">模型/接口/Key 保存在应用内（app_settings 表），保存后约 30 秒内热生效，无需重启。</p>
                    {saveButton(saveSettings)}
                  </div>
                </section>

                {/* ── 数据源 ── */}
                <section className={sectionClass("turso")}>
                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <div className="space-y-2">
                      <label htmlFor="turso-url" className="text-sm font-medium">远端数据库 URL (TURSO_DATABASE_URL)</label>
                      <div className="flex gap-2">
                        <Input
                          id="turso-url"
                          value={tursoUrl}
                          onChange={(e) => {
                            setTursoUrl(e.target.value);
                            if (e.target.value) restoreKey("tursoUrl");
                          }}
                          placeholder={tursoUrlSet ? "已设置，留空保持不变" : "未设置（可选）"}
                          disabled={!loaded}
                          className="flex-1 bg-background"
                        />
                        {tursoUrlSet && (
                          <Button type="button" variant="outline" size="icon" onClick={() => clearKey("tursoUrl")} title="清除">
                            <RotateCcw className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="space-y-2">
                      <label htmlFor="turso-token" className="text-sm font-medium">鉴权 Token (TURSO_AUTH_TOKEN)</label>
                      <div className="flex gap-2">
                        <Input
                          id="turso-token"
                          {...secretInputProps("tursoToken", tursoToken, setTursoToken, tursoTokenSet)}
                          className="flex-1 bg-background"
                          disabled={!loaded}
                        />
                        {tursoTokenSet && (
                          <Button type="button" variant="outline" size="icon" onClick={() => clearKey("tursoToken")} title="清除">
                            <RotateCcw className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">留空时使用本地文件数据库（news.db）；配置 Turso 后数据存远端，改动需重启应用后生效。</p>
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
                        {tushareTokenSet && (
                          <Button type="button" variant="outline" size="icon" onClick={() => clearKey("tushareToken")} title="清除">
                            <RotateCcw className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">Tushare 只提供 T1 行情/交易日历；官方公告与政策直接取交易所、巨潮、证监会页面。Token 保存后约 30 秒热生效。</p>
                  </div>

                  {saveButton(saveSettings)}
                </section>

                {/* ── 定时任务 ── */}
                <section className={sectionClass("cron")}>
                  <div className="space-y-3 rounded-lg bg-muted p-4">
                    <div className="space-y-2">
                      <label htmlFor="cron-secret" className="text-sm font-medium">CRON_SECRET（Vercel Cron / QStash 鉴权）</label>
                      <div className="flex gap-2">
                        <Input
                          id="cron-secret"
                          {...secretInputProps("cronSecret", cronSecret, setCronSecret, cronSecretSet)}
                          className="flex-1 bg-background"
                          disabled={!loaded}
                        />
                        {cronSecretSet && (
                          <Button type="button" variant="outline" size="icon" onClick={() => clearKey("cronSecret")} title="清除">
                            <RotateCcw className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">用于保护 /api/cron/* 定时任务接口（Bearer 或 ?token=）。保存在应用内，约 30 秒内热生效。</p>
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
