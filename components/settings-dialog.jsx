"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { CheckCircle2, Clock, Cpu, Database, Info, Loader2, RotateCcw, Save, UserRound, XIcon } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

/**
 * 设置弹窗（avatar 菜单 → 设置）：
 * - 模型：LLM_MODEL / LLM_BASE_URL / LLM_API_KEY（30s 缓存热生效，无需重启）
 * - 数据源：TURSO_DATABASE_URL / TURSO_AUTH_TOKEN（需重启应用生效）
 * - 定时任务：CRON_SECRET（30s 缓存热生效）
 * - 账号：修改登录名 / 密码（需当前密码）
 * 布局参考 zlog settings-dialog：左侧导航栏 + 右侧内容区（移动端导航变顶部横排）。
 * 文本类字段留空保存 = 清除该项（恢复环境变量默认）；密钥类留空 = 保持不变。
 */
const PANELS = [
  { id: "model", label: "模型", icon: Cpu, title: "模型配置", desc: "LLM 模型 / 接口地址 / API Key（保存后约 30 秒热生效，无需重启）" },
  { id: "turso", label: "数据源", icon: Database, title: "数据源配置", desc: "远端 Turso 数据库（改动需重启应用后生效）" },
  { id: "cron", label: "定时任务", icon: Clock, title: "定时任务", desc: "Vercel Cron / QStash 鉴权密钥（保存后约 30 秒热生效）" },
  { id: "account", label: "账号", icon: UserRound, title: "账号设置", desc: "修改登录名与密码（需验证当前密码）" },
];

export default function SettingsDialog({ open, onOpenChange, username, onAccountChanged, desktop = false }) {
  // 桌面模式为本地单用户,账号(改登录名/密码)面板无意义,整块隐藏
  const panels = desktop ? PANELS.filter((p) => p.id !== "account") : PANELS;
  // 表单状态（初始值在 open 时从 GET /api/settings 拉取）
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState(null);
  const [panel, setPanel] = useState("model");

  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(false);
  const [clearedKeys, setClearedKeys] = useState(new Set());

  const [tursoUrl, setTursoUrl] = useState("");
  const [tursoToken, setTursoToken] = useState("");
  const [tursoUrlSet, setTursoUrlSet] = useState(false);
  const [tursoTokenSet, setTursoTokenSet] = useState(false);

  const [cronSecret, setCronSecret] = useState("");
  const [cronSecretSet, setCronSecretSet] = useState(false);

  // 账号表单
  const [accUsername, setAccUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const router = useRouter();

  // 打开时拉取当前配置（仅在打开/关闭转换时重置；账号改名回调更新 username prop 时保持 okMsg 可见）
  const prevOpen = useRef(false);
  useEffect(() => {
    if (prevOpen.current === open) return;
    prevOpen.current = open;
    if (!open) return;
    setLoaded(false);
    setError(null);
    setOkMsg(null);
    setClearedKeys(new Set());
    setApiKey("");
    setTursoToken("");
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
      setCronSecretSet(Boolean(d.cronSecretSet));
      setClearedKeys(new Set());
      setApiKey("");
      setTursoToken("");
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
        setTimeout(() => router.replace("/login"), 1200);
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

  const hint = (text) => (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Info className="size-3.5 shrink-0" />
      {text}
    </p>
  );

  const activePanel = panels.find((p) => p.id === panel) ?? panels[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(calc(100dvh-2rem),48rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl sm:flex-row"
      >
        {/* 左侧导航（移动端为顶部横排） */}
        <nav
          className="flex shrink-0 flex-row gap-0.5 overflow-x-auto border-b bg-muted p-2 sm:w-44 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0 sm:px-3 sm:pt-4 sm:pb-3"
          aria-label="设置"
        >
          {panels.map((item) => {
            const Icon = item.icon;
            const active = panel === item.id;
            return (
              <Button
                key={item.id}
                type="button"
                variant="ghost"
                size="sm"
                aria-current={active ? "page" : undefined}
                onClick={() => setPanel(item.id)}
                className={cn(
                  "h-8 shrink-0 justify-start px-2.5 text-sm sm:w-full",
                  active
                    ? "bg-accent font-medium text-accent-foreground hover:bg-accent hover:text-accent-foreground"
                    : "text-muted-foreground"
                )}
              >
                <Icon className={cn("size-4", !active && "opacity-70")} />
                {item.label}
              </Button>
            );
          })}
        </nav>

        {/* 右侧内容区 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <DialogHeader className="relative shrink-0 gap-1 border-b px-6 py-4 pr-12">
            <DialogTitle>{activePanel.title}</DialogTitle>
            <DialogDescription>{activePanel.desc}</DialogDescription>
            <DialogClose
              render={
                <Button variant="ghost" size="icon-sm" className="absolute top-3 right-3" aria-label="关闭" />
              }
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </DialogClose>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5 [scrollbar-gutter:stable]">
            {error && (
              <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
            )}
            {okMsg && (
              <div className="mb-4 flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5 shrink-0" />
                {okMsg}
              </div>
            )}

            {/* ── 模型 ── */}
            <div hidden={panel !== "model"} className="max-w-md space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">模型 (LLM_MODEL)</label>
                <Input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="留空使用环境变量（默认 deepseek-v4-flash）"
                  disabled={!loaded}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">接口地址 (LLM_BASE_URL)</label>
                <Input
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="留空使用环境变量（默认 https://api.deepseek.com/v1）"
                  disabled={!loaded}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">API Key (LLM_API_KEY)</label>
                <div className="flex gap-2">
                  <Input
                    {...secretInputProps("llmApiKey", apiKey, setApiKey, apiKeySet)}
                    className="flex-1"
                    disabled={!loaded}
                  />
                  {apiKeySet && (
                    <Button type="button" variant="outline" size="icon" onClick={() => clearKey("llmApiKey")} title="清除已保存的 Key">
                      <RotateCcw className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
              {hint("模型/接口/Key 保存在应用内（app_settings 表），保存后约 30 秒内热生效，无需重启。")}
              <div className="flex justify-end pt-1">
                <Button size="sm" onClick={saveSettings} disabled={saving || !loaded}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存
                </Button>
              </div>
            </div>

            {/* ── 数据源 ── */}
            <div hidden={panel !== "turso"} className="max-w-md space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">远端数据库 URL (TURSO_DATABASE_URL)</label>
                <div className="flex gap-2">
                  <Input
                    value={tursoUrl}
                    onChange={(e) => {
                      setTursoUrl(e.target.value);
                      if (e.target.value) restoreKey("tursoUrl");
                    }}
                    placeholder={tursoUrlSet ? "已设置，留空保持不变" : "未设置（可选）"}
                    disabled={!loaded}
                    className="flex-1"
                  />
                  {tursoUrlSet && (
                    <Button type="button" variant="outline" size="icon" onClick={() => clearKey("tursoUrl")} title="清除">
                      <RotateCcw className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">鉴权 Token (TURSO_AUTH_TOKEN)</label>
                <div className="flex gap-2">
                  <Input
                    {...secretInputProps("tursoToken", tursoToken, setTursoToken, tursoTokenSet)}
                    className="flex-1"
                    disabled={!loaded}
                  />
                  {tursoTokenSet && (
                    <Button type="button" variant="outline" size="icon" onClick={() => clearKey("tursoToken")} title="清除">
                      <RotateCcw className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
              {hint("留空时使用本地文件数据库（news.db）。配置了 Turso 后数据存远端；改动需重启应用后生效。")}
              <div className="flex justify-end pt-1">
                <Button size="sm" onClick={saveSettings} disabled={saving || !loaded}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存
                </Button>
              </div>
            </div>

            {/* ── 定时任务 ── */}
            <div hidden={panel !== "cron"} className="max-w-md space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">CRON_SECRET（Vercel Cron / QStash 鉴权）</label>
                <div className="flex gap-2">
                  <Input
                    {...secretInputProps("cronSecret", cronSecret, setCronSecret, cronSecretSet)}
                    className="flex-1"
                    disabled={!loaded}
                  />
                  {cronSecretSet && (
                    <Button type="button" variant="outline" size="icon" onClick={() => clearKey("cronSecret")} title="清除">
                      <RotateCcw className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
              {hint("用于保护 /api/cron/* 定时任务接口（Bearer 或 ?token=）。保存在应用内，约 30 秒内热生效。")}
              <div className="flex justify-end pt-1">
                <Button size="sm" onClick={saveSettings} disabled={saving || !loaded}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存
                </Button>
              </div>
            </div>

            {/* ── 账号 ── */}
            <div hidden={panel !== "account"} className="max-w-md space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium">登录名</label>
                <Input
                  value={accUsername}
                  onChange={(e) => setAccUsername(e.target.value)}
                  placeholder="当前登录名"
                  autoComplete="off"
                  disabled={!loaded}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">当前密码（必填验证）</label>
                <Input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  placeholder="输入当前密码以确认修改"
                  autoComplete="current-password"
                  disabled={!loaded}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">新密码（可选）</label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="至少 6 位；留空则不修改密码"
                  autoComplete="new-password"
                  disabled={!loaded}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium">确认新密码</label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="再次输入新密码"
                  autoComplete="new-password"
                  disabled={!loaded}
                />
              </div>
              <div className="flex justify-end pt-1">
                <Button size="sm" onClick={saveAccount} disabled={saving || !loaded || !currentPassword}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  保存
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
