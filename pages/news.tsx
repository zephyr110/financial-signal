import { useState, useEffect, useCallback, useRef } from "react";
import Head from "next/head";
import NewsList from "../components/NewsList";
import AppShell, { useAppShellScroll } from "../components/app-shell";
import { TopbarRefreshButton } from "../components/app-topbar";
import ErrorBanner from "../components/ErrorBanner";
import EmptyState from "../components/EmptyState";
import TodaySignalSummary from "../components/TodaySignalSummary";
import WelcomeScreen from "../components/WelcomeScreen";
import { Clock, RefreshCw } from "lucide-react";
import { TodayTabs } from "../components/TodayTabs";
import { getNewsByDate, getAvailableDates, getDb } from "../lib/db";
import { todayKey } from "../lib/format";
import { CONTENT_GUTTER } from "@/lib/layout-classes";
import { useDesktopWelcome } from "@/hooks/use-desktop-welcome";

const PULL_THRESHOLD = 56;

/** 新闻线索视图（原首页）。驾驶舱成为 / 后，这里仍是同一份 7×24 快讯。 */
export default function NewsPage({ todayItems: ssgToday, pastDates: ssgDates, today: ssgTodayStr, error: ssgError }) {
  // AppShell 内容滚动容器——下拉刷新守卫读 scrollTop（替代原 window.scrollY）
  const scrollRef = useAppShellScroll();
  const [todayItems, setTodayItems] = useState(ssgToday || []);
  const [pastDates, setPastDates] = useState(ssgDates || []);
  const [error, setError] = useState(ssgError ?? null);
  const [fetching, setFetching] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [mounted, setMounted] = useState(false);

  const { showWelcome, checked: welcomeChecked, importing, importError, handleImport, handleSkip } = useDesktopWelcome();

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

  // Only auto-refresh if SSG returned no data (cold start)；欢迎页期间不拉，避免抢先建库。
  useEffect(() => {
    if (showWelcome) return;
    if (!welcomeChecked) return;
    if (!ssgToday || ssgToday.length === 0) {
      doRefresh();
    }
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [doRefresh, ssgToday, showWelcome, welcomeChecked]);

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

  // React 合成 onTouchMove 以 passive 注册，preventDefault 无效：下拉会被系统滚动打断。
  const pullAreaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = pullAreaRef.current;
    if (!el) return;
    const handler = (e: TouchEvent) => onTouchMove(e);
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, [onTouchMove]);

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
        <title>新闻线索 · 财经信号</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="7×24 财经快讯与信号筛选，个人收盘研究用途"
        />
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Recent Entries"
          href="/api/rss.xml"
        />
      </Head>

      <AppShell
        title="新闻线索"
        actions={<TopbarRefreshButton onClick={doRefresh} refreshing={fetching} />}
      >
      <div
        ref={pullAreaRef}
        onTouchStart={onTouchStart}
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

        {/* 内容区与投研台同宽：占满侧栏右侧，水平留白一致 */}
        <div className={`w-full pb-12 ${CONTENT_GUTTER}`}>
          {/* Hero */}
          <div className="pt-6 pb-6 flex items-end justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground">
                新闻线索
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                7×24 全球快讯 · AI 辅助筛选值得跟进的线索
              </p>
              <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Clock className="size-3.5" aria-hidden="true" />
                {lastUpdated ? (
                  <>
                    更新于{" "}
                    {lastUpdated.toLocaleTimeString("zh-CN", {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </>
                ) : (
                  <>7×24 快讯 · 下拉或点右上角刷新</>
                )}
              </div>
            </div>
            <TodayTabs />
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
    // 直连 DB 组装首页数据(与 /api/news 同构,但不在构建/ISR 时自回环 HTTP,
    // 避免未配 NEXT_PUBLIC_BASE_URL 时构建期必失败;客户端刷新按钮仍走 /api/news 拿实时补数据)
    const today = todayKey();
    const todayRows = await getNewsByDate(today, 200);
    const todayItems = todayRows.map((row: any) => ({
      id: row.id,
      rich_text: row.content,
      published_at: row.published_at,
      source: row.source,
      title: row.title,
    }));
    await attachSignalData(todayItems);

    const allDates = await getAvailableDates(7);
    const pastDates = allDates.filter((d) => d !== today);

    return {
      props: {
        todayItems,
        pastDates,
        today,
        error: null,
      },
      revalidate: 300,
    };
  } catch (e) {
    console.error("Failed to load news:", e);
    return {
      props: { todayItems: [], pastDates: [], today: '', error: "暂时无法获取最新新闻，请稍后刷新页面" },
      revalidate: 60,
    };
  }
}

/** 为带 DB id 的条目附加分析信号信息(LEFT JOIN analysis_result)。 */
async function attachSignalData(items: any[]) {
  const ids = items
    .map((item: any) => item.id)
    .filter((id: any) => typeof id === 'number' && id > 0);
  if (ids.length === 0) return;

  const db = await getDb();
  const placeholders = ids.map(() => '?').join(',');
  const result = await db.execute({
    sql: `
      SELECT a.id as analysis_id, a.news_id, a.signal_score, a.category
      FROM analysis_result a
      WHERE a.news_id IN (${placeholders})
    `,
    args: ids,
  });

  const signalMap = new Map<number, any>();
  for (const row of result.rows) {
    const r = row as any;
    signalMap.set(r.news_id, {
      id: r.analysis_id,
      signal_score: r.signal_score,
      category: r.category,
    });
  }

  for (const item of items) {
    if (item.id > 0 && signalMap.has(item.id)) {
      item.analysis = signalMap.get(item.id);
    }
  }
}
