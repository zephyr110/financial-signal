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
import { getNewsByDate, getAvailableDates, getDb } from "../lib/db";
import { todayKey } from "../lib/format";

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
  // getInfo 判定完成前不自动拉数据:挂载即 fetch /api/news 会让 server 侧
  // getDb() 抢先建出空库(abort 只能断客户端连接,救不回服务端已创建的
  // 文件),getInfo 的 imported 判定随后恒 true → 欢迎页永不出现。
  const [welcomeChecked, setWelcomeChecked] = useState(false);

  useEffect(() => {
    const win = (window as any).desktop;
    if (win?.getInfo) {
      win
        .getInfo()
        .then((info: any) => {
          setWelcomeChecked(true);
          if (!info.imported) setShowWelcome(true);
        })
        .catch(() => {
          // getInfo 失败(IPC 异常等):按【未导入】处理展示欢迎页——不能按已导入
          // 放行自动刷新,/api/news 会触发 server 侧 getDb() 抢先建出空库,
          // 下次启动 getInfo 的 imported 判定恒 true → 欢迎页永远不再出现。
          // 用户仍可通过欢迎页手动导入/全新开始。
          setWelcomeChecked(true);
          setShowWelcome(true);
        });
    } else {
      setWelcomeChecked(true); // web 模式无 IPC,直接放行自动刷新
    }
  }, []);

  const handleDbAction = async (action: "import" | "fresh") => {
    const win = (window as any).desktop;
    if (!win) return;
    const failMsg = action === "import" ? "导入失败，请重试" : "创建数据库失败，请重试";
    setImporting(true);
    setImportError(null);
    try {
      const r =
        action === "import"
          ? await win.selectAndImportDb()
          : await win.createFreshDb();
      if (r?.ok) setShowWelcome(false);
      else if (action === "import" && r?.canceled) return;
      else setImportError(r?.error || failMsg);
    } catch (e) {
      // IPC 异常(如对话框在应用退出时被销毁):按钮卡死在"导入中…"的 bug 来源,
      // 必须兜底复位
      console.error(`handleDbAction(${action}) failed:`, e);
      setImportError(failMsg);
    } finally {
      setImporting(false);
    }
  };

  const handleImport = () => handleDbAction("import");
  const handleSkip = () => handleDbAction("fresh");

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
  // welcomeChecked 前置:挂载期 getInfo 判定完成前不发请求(abort 救不回
  // 服务端已建出的库文件),判定 imported=false 后 welcome 常驻、永不拉取。
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

  // React 合成 onTouchMove 在根节点以 passive 方式注册,preventDefault 无效且告警,
  // 移动端下拉刷新会被系统滚动打断。必须用原生非 passive 监听才能阻止滚动。
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
