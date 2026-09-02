import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { Loader2, Lock, UserRound, AlertCircle, Eye, EyeOff } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import BrandLogo from "../components/BrandLogo";

/**
 * 登录页（shadcn 风格：居中卡片 + 品牌 + 账号密码）。
 * 背景：项目主题——「财经信号」：细网格 + 品牌色光晕 + 抽象趋势线（明暗自适应）。
 * 登录成功后跳回 next 参数指定的页面（默认首页）。
 */
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [isDesktopApp, setIsDesktopApp] = useState(false);

  useEffect(() => {
    setIsDesktopApp(typeof window !== "undefined" && !!(window as any).desktop);
  }, []);

  // 登录后跳转目标防开放重定向:仅允许站内相对路径(以 / 开头且非 //host)
  const safeNext = (next: string): string => {
    if (!next.startsWith("/") || next.startsWith("//")) return "/";
    return next;
  };

  // 已登录则直接进入
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated) router.replace("/");
      })
      .catch(() => {});
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "登录失败，请重试");
        return;
      }
      const next = typeof router.query.next === "string" ? router.query.next : "/";
      router.replace(safeNext(next));
    } catch {
      setError("网络错误，请稍后重试");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Head>
        <title>登录 — 财经信号</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
      </Head>

      <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-10">
        {/* 背景装饰层（极简光晕：柔和、克制，焦点在卡片） */}
        <div aria-hidden className="pointer-events-none absolute inset-0">
          {/* 顶部品牌色大光晕 */}
          <div className="absolute -top-32 left-1/2 h-[30rem] w-[42rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
          {/* 底部对角冷色光晕 */}
          <div className="absolute -right-24 -bottom-32 h-[26rem] w-[26rem] rounded-full bg-blue-500/10 blur-3xl" />
        </div>

        <div className="relative w-full max-w-sm space-y-8">
          {/* 品牌 */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center gap-2.5">
              <BrandLogo className="size-9" />
              <span className="text-xl font-semibold tracking-tight">财经信号</span>
            </div>
            <p className="text-center text-sm text-muted-foreground">
              个人智能投资顾问 · 基于数据分析的信号与建议
            </p>
          </div>

          {/* 登录卡片 */}
          <form
            onSubmit={submit}
            noValidate
            className="space-y-4 rounded-2xl border bg-card/90 p-6 shadow-lg backdrop-blur-sm"
          >
            <div className="space-y-2">
              <label htmlFor="username" className="text-sm font-medium leading-none">
                账号
              </label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="请输入账号"
                  autoComplete="username"
                  className="pl-9"
                  disabled={submitting}
                />
              </div>
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium leading-none">
                密码
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  className="pr-9 pl-9"
                  disabled={submitting}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  tabIndex={-1}
                  aria-label={showPassword ? "隐藏密码" : "显示密码"}
                  className="absolute top-1/2 right-2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive">
                <AlertCircle className="size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button type="submit" className="w-full" disabled={submitting || !username.trim() || !password}>
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  登录中…
                </>
              ) : (
                "登录"
              )}
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            仅供个人研究使用 · 不构成投资建议
          </p>
          {isDesktopApp && (
            <p className="text-center text-xs text-muted-foreground">
              首次使用默认账号为 admin；若未设置密码，初始密码会输出到桌面应用日志，登录后请在「设置 → 账号」修改。
            </p>
          )}
        </div>
      </div>
    </>
  );
}
