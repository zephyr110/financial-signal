import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import NewsList from "../components/NewsList";
import AppShell, { useAppShellScroll } from "../components/app-shell";
import { TopbarRefreshButton } from "../components/app-topbar";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import TodaySignalSummary from "../components/TodaySignalSummary";
import WelcomeScreen from "../components/WelcomeScreen";
import { RefreshCw } from "lucide-react";

const PULL_THRESHOLD = 56;

export default function Home({ todayItems: ssgToday, pastDates: ssgDates, today: ssgTodayStr, error: ssgError }) {
  // AppShell 内容滚动容器——下拉刷新守卫读 scrollTop（替代原 window.scrollY）
  const scrollRef = useAppShellScroll();
  const [todayItems, setTodayItems] = useState(ssgToday || []);
  const [pastDates, setPastDates] = useState(ssgDates || []);
  const [error, setError] = useState(ssgError ?? null);
  const [fetching, setFetching] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [mounted, setMounted] = useState(false);

  // ---- 首次启动引导（仅桌面端、userData 无 db 时展示）----
  const [showWelcome, setShowWelcome] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    const win = (window as any).desktop;
    if (win?.getInfo) {
      win
        .getInfo()
        .then((info: any) => {
          if (!info.imported) setShowWelcome(true);
        })
        .catch(() => {
          // getInfo 失败(IPC 异常等)不阻塞首页渲染,按已导入处理
        });
    }
  }, []);

  const handleImport = async () => {
    const win = (window as any).desktop;
    if (!win) return;
    setImporting(true);
    setImportError(null);
    const r = await win.selectAndImportDb();
    setImporting(false);
    if (r?.ok) setShowWelcome(false);
    else if (!r?.canceled) setImportError(r?.error || "导入失败");
  };

  const handleSkip = async () => {
    const win = (window as any).desktop;
    if (!win) return;
    setImporting(true);
    setImportError(null);
    const r = await win.createFreshDb();
    setImporting(false);
    if (r?.ok) setShowWelcome(false);
    else setImportError(r?.error || "创建数据库失败");
  };

  // ---- pull-to-refresh ----
  const [pullDist, setPullDist] = useState(0);
  const pullDistRef = useRef(0);
  const fetchingRef = useRef(false);
  const touchY0 = useRef(0);
  const pulling = useRef(false);

  useEffect(() => {
    fetchingRef.current = fetching;
  }, [fetching]);

  const abortRef = useRef(null);

  const doRefresh = useCallback(async () => {
    if (fetchingRef.current) return;
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setFetching(true);
    fetchingRef.current = true;
    setError(null);
    try {
      const res = await fetch("/api/news", { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTodayItems(data.todayItems || []);
      setPastDates(data.pastDates || []);
      setLastUpdated(new Date());
    } catch (e) {
      if (e.name === "AbortError") return;
      console.error("Refresh failed:", e);
      setError("数据更新失败，请稍后重试");
    } finally {
      setFetching(false);
      fetchingRef.current = false;
      setPullDist(0);
      pullDistRef.current = 0;
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  // Set mounted flag and initial timestamp client-side only (avoid hydration mismatch)
  useEffect(() => {
    setMounted(true);
    if (ssgToday && ssgToday.length > 0) {
      setLastUpdated(new Date());
    }
  }, [ssgToday]);

  // Only auto-refresh if SSG returned no data (cold start)
  // 欢迎页展示期间不拉取数据:fetch /api/news 会触发 server 侧 getDb() 建库,
  // 与 getInfo 的 imported 判定竞态(抢先建出的空库使欢迎页永不出现)。
  // showWelcome 进依赖:变为 true 时 cleanup 会 abort 掉在途请求,彻底封死竞态窗口。
  useEffect(() => {
    if (showWelcome) return;
    if (!ssgToday || ssgToday.length === 0) {
      doRefresh();
    }
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [doRefresh, ssgToday, showWelcome]);

  // ---- touch handlers ----
  const onTouchStart = useCallback((e) => {
    pulling.current = false;
    if ((scrollRef?.current?.scrollTop ?? 0) <= 0 && !fetchingRef.current) {
      touchY0.current = e.touches[0].clientY;
      pulling.current = true;
    }
  }, [scrollRef]);

  const onTouchMove = useCallback((e) => {
    if (!pulling.current) return;
    const dy = e.touches[0].clientY - touchY0.current;
    if (dy > 0) {
      e.preventDefault();
      const d = Math.min(dy * 0.45, 120);
      pullDistRef.current = d;
      setPullDist(d);
    } else {
      pullDistRef.current = 0;
      setPullDist(0);
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    pulling.current = false;
    if (pullDistRef.current >= PULL_THRESHOLD && !fetchingRef.current) {
      doRefresh();
    } else {
      setPullDist(0);
      pullDistRef.current = 0;
    }
  }, [doRefresh]);

  const onTouchCancel = useCallback(() => {
    pulling.current = false;
    setPullDist(0);
    pullDistRef.current = 0;
  }, []);

  const pullProgress = Math.min(pullDist / PULL_THRESHOLD, 1);

  // 首次启动且未导入/创建 db 时,整页替换为欢迎引导(web 模式 window.desktop 不存在,恒 false)
  if (showWelcome) {
    return (
      <WelcomeScreen
        onImport={handleImport}
        onSkip={handleSkip}
        importing={importing}
        error={importError}
      />
    );
  }

  return (
    <>
      <Head>
        <title>财经信号 — 实时快讯 · AI 信号识别</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="AI 驱动的财经信号识别引擎，自动筛选政策、行业、公司关键信号"
        />
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Recent Entries"
          href="/api/rss.xml"
        />
      </Head>

      <AppShell
        title="新闻快讯"
        actions={<TopbarRefreshButton onClick={doRefresh} refreshing={fetching} />}
      >
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchCancel}
        className="bg-background"
      >
        {/* Pull-to-refresh indicator */}
        <div
          className="flex items-center justify-center gap-2 overflow-hidden"
          style={{ height: pullDist, opacity: pullProgress }}
        >
          <RefreshCw
            className={`h-4 w-4 text-muted-foreground ${fetching ? "animate-spin" : ""}`}
            style={{
              transform: !fetching && pullDist > 0
                ? `rotate(${pullProgress * 360}deg)`
                : undefined,
            }}
          />
          <span className="text-xs text-muted-foreground">
            {fetching
              ? "更新中…"
              : pullDist >= PULL_THRESHOLD
                ? "释放刷新"
                : "下拉刷新"}
          </span>
        </div>

        {/* 内容列宽度随分辨率阶梯放大，与 agent/analysis 一致 */}
        <div className="mx-auto max-w-[760px] lg:max-w-[880px] xl:max-w-[960px] 2xl:max-w-[1120px] px-4 sm:px-6 pb-12">
          {/* Hero */}
          <div className="pt-8 pb-6 flex items-end justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                实时财经快讯
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                7×24 全球快讯 · AI 智能筛选高价值信号
              </p>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="relative flex h-2 w-2" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                </span>
                信号流在线
                {lastUpdated && (
                  <>
                    <span aria-hidden>·</span>
                    更新于{" "}
                    {lastUpdated.toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </>
                )}
              </div>
            </div>
          </div>

          <ErrorBanner message={error} />

          <TodaySignalSummary items={todayItems} />

          {todayItems.length > 0 ? (
            <NewsList todayItems={todayItems} pastDates={pastDates} />
          ) : (
            !error && <EmptyState onRefresh={doRefresh} refreshing={fetching} />
          )}
        </div>
      </div>
      </AppShell>
    </>
  );
}

export async function getStaticProps() {
  try {
    // Build the absolute URL for server-side fetch
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/news?includeSignals=1`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      props: {
        todayItems: data.todayItems || [],
        pastDates: data.pastDates || [],
        today: data.today || '',
        error: null,
      },
      revalidate: 300,
    };
  } catch (e) {
    console.error("Failed to fetch news:", e);
    return {
      props: { todayItems: [], pastDates: [], today: '', error: "暂时无法获取最新新闻，请稍后刷新页面" },
      revalidate: 60,
    };
  }
}
