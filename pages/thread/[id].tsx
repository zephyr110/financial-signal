import { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Link from "next/link";
import { ArrowLeft, Loader2, Zap, AlertCircle, CalendarDays, History, Flame, TrendingUp, ExternalLink } from "lucide-react";
import AppShell from "../../components/app-shell";
import SignalBadge from "../../components/SignalBadge";
import ErrorBanner from "../../components/ErrorBanner";
import WatchlistButton from "../../components/WatchlistButton";
import { cn } from "@/lib/utils";
import { CATEGORY_LABELS, CATEGORY_COLORS, SCORE_LABELS } from "@/lib/constants";
import { getEventThreads, getEventThreadById } from "../../lib/db";
import { getThreadMarketContext } from "../../lib/market";
import { getBacktestTier, shouldShowNumbers, TIER_LABELS } from "@/lib/backtest";
import { formatDate, formatTime } from "../../lib/format";
import { track } from "@/lib/track";

const STAGE_LABELS = {
  early: "早期",
  brewing: "发酵中",
  spreading: "全面扩散",
  priced_in: "成熟定价",
};

const STAGE_COLORS = {
  early: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  brewing: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  spreading: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  priced_in: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export default function ThreadPage({ data: ssgData, error: ssgError }) {
  const router = useRouter();
  const [data, setData] = useState(ssgData || null);
  const [error, setError] = useState(ssgError ?? null);
  const [loading, setLoading] = useState(false);

  // Fallback: fetch client-side if not pre-rendered
  const rawId = router.query.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  useEffect(() => {
    if (ssgData) return;
    if (!id || !router.isReady) return;

    let cancelled = false;
    setLoading(true);
    fetch(`/api/thread/${id}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status === 404 ? "NOT_FOUND" : `HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e.message === "NOT_FOUND" ? "事件线索不存在" : "加载失败，请稍后重试");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [id, router.isReady, ssgData]);

  // P2.1 埋点：进入线索详情即记 thread_expand（SSG 首屏与客户端兜底都覆盖）
  useEffect(() => {
    if (!id || !router.isReady) return;
    track('thread_expand', { id: Number(id) });
  }, [id, router.isReady]);

  if (loading) {
    return (
      <>
        <Head><title>加载中… — 财经信号</title></Head>
        <AppShell title="事件线索">
          <div className="mx-auto flex min-h-full max-w-[720px] lg:max-w-[960px] flex-col px-4 sm:px-6 pb-12 pt-8">
            <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">加载中…</span>
            </div>
          </div>
        </AppShell>
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <Head><title>事件线索 — 财经信号</title></Head>
        <AppShell title="事件线索">
          <div className="mx-auto max-w-[720px] lg:max-w-[960px] px-4 sm:px-6 pb-12 pt-8">
            <Link
              href="/analysis"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              返回分析面板
            </Link>
            <ErrorBanner message={error} />
          </div>
        </AppShell>
      </>
    );
  }

  const thread = data;
  // P2.4 四段叙事：起因 = 最早信号；时间线 = 成员信号正序（DB 已按 published_at ASC）
  const origin = thread?.signals?.[0] || null;
  const signals = thread?.signals || [];

  return (
    <>
      <Head>
        <title>
          {thread ? `${thread.title} — 事件线索 | 财经信号` : "事件线索 — 财经信号"}
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content={thread?.narrative?.slice(0, 160) || "AI 识别的事件线索及其成员信号"}
        />
      </Head>

      <AppShell title="事件线索">
        <div className="mx-auto max-w-[720px] lg:max-w-[960px] px-4 sm:px-6 pb-12 pt-8">
          <Link
            href="/analysis"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回分析面板
          </Link>

          {thread ? (
            <>
              {/* ── 段① 起因：线索头部 + 最早信号 + 原文 ── */}
              <div className="bg-card border rounded-xl p-4 sm:p-6 mb-6">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  {thread.confidence === "high" ? (
                    <Zap className="h-4 w-4 text-amber-500 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <h1 className="text-base sm:text-lg font-semibold text-foreground">
                    {thread.title}
                  </h1>
                  <span className={cn(
                    "text-xs px-1.5 py-0.5 rounded-full font-medium",
                    STAGE_COLORS[thread.stage] || STAGE_COLORS.early
                  )}>
                    {STAGE_LABELS[thread.stage] || thread.stage}
                  </span>
                  <WatchlistButton type="thread" id={thread.id} compact className="ml-auto shrink-0" />
                </div>

                <p className="text-sm text-foreground leading-relaxed mb-3">
                  {thread.narrative}
                </p>

                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarDays className="h-3.5 w-3.5" />
                  生成于 {formatDate(thread.created_at)} {formatTime(thread.created_at)}
                </div>

                {thread.industries?.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap mt-3">
                    <span className="text-xs text-muted-foreground">涉及行业：</span>
                    {thread.industries.map((ind: string) => (
                      <span
                        key={ind}
                        className="text-xs px-1.5 py-0.5 rounded bg-accent text-accent-foreground"
                      >
                        {ind}
                      </span>
                    ))}
                  </div>
                )}

                {/* 起因：最早信号 + 原始快讯 + 原文链接 */}
                {origin && (
                  <div className="mt-4 pt-4 border-t border-border">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                      <Flame className="h-3 w-3 text-amber-500" />
                      起因 · {formatDate(origin.published_at)} {formatTime(origin.published_at)}
                    </div>
                    <div className="flex items-start gap-2.5">
                      <SignalBadge score={origin.signal_score} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-foreground leading-relaxed">
                          {origin.summary}
                        </p>
                        {origin.content && (
                          <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed line-clamp-3">
                            {origin.content}
                          </p>
                        )}
                        <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                          {origin.docurl && (
                            <a
                              href={origin.docurl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
                            >
                              阅读原文 <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                          {origin.source && (
                            <span className="text-xs text-muted-foreground">{origin.source}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* ── 段② 进展时间线 ── */}
              <div className="bg-card border rounded-xl p-4 sm:p-6 mb-6">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <History className="h-4 w-4 text-primary" />
                  进展时间线（{signals.length} 条）
                </h3>
                {signals.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    暂无成员信号数据
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {signals.map((s: any, i: number) => (
                      <Link
                        key={s.id}
                        href={`/signal/${s.id}`}
                        className="flex items-start gap-3 p-3 rounded-lg border bg-background hover:border-primary/50 hover:bg-accent/40 transition-colors"
                      >
                        <div className="flex flex-col items-center shrink-0">
                          <SignalBadge score={s.signal_score} size="md" />
                          {i === 0 && (
                            <span className="text-xs text-amber-500 mt-1">起因</span>
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-foreground leading-relaxed">
                            {s.summary}
                          </p>
                          <div className="mt-1 flex items-center gap-2 flex-wrap">
                            <span className={cn(
                              "text-xs px-1.5 py-0.5 rounded font-medium",
                              CATEGORY_COLORS[s.category] || CATEGORY_COLORS.macro
                            )}>
                              {CATEGORY_LABELS[s.category] || s.category}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {SCORE_LABELS[s.signal_score] || ""}信号
                            </span>
                            <span className="text-xs text-muted-foreground ml-auto tabular-nums">
                              {formatDate(s.published_at)} {formatTime(s.published_at)}
                            </span>
                          </div>
                          {s.content && (
                            <p className="text-xs text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                              {s.content}
                            </p>
                          )}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {/* ── 段③ 市场反应：今日板块涨跌 + 行业回测 ── */}
              <div className="bg-card border rounded-xl p-4 sm:p-6 mb-6">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  市场反应
                </h3>
                {thread.market?.length > 0 || thread.backtest?.length > 0 ? (
                  <>
                    {thread.market?.length > 0 && (
                      <div className="mb-3">
                        <span className="text-xs text-muted-foreground block mb-1.5">
                          今日板块涨跌
                        </span>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {thread.market.map((m: any) => {
                            const raw = m.change_pct;
                            const hasPct = raw != null && Number.isFinite(Number(raw));
                            const pct = Number(raw);
                            return (
                              <span key={m.name} className="text-xs flex items-center gap-1">
                                <span className="text-muted-foreground">{m.name}</span>
                                {/* A股惯例：红涨绿跌 */}
                                <span
                                  className={
                                    hasPct && pct >= 0
                                      ? "text-red-600 dark:text-red-400"
                                      : "text-emerald-600 dark:text-emerald-400"
                                  }
                                >
                                  {hasPct ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—"}
                                </span>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {thread.backtest?.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-muted-foreground border-b">
                              <th className="text-left py-2 pr-4 font-medium">行业回测</th>
                              <th className="text-right py-2 px-2 font-medium">样本</th>
                              <th className="text-right py-2 px-2 font-medium">T+1</th>
                              <th className="text-right py-2 px-2 font-medium">T+3</th>
                              <th className="text-right py-2 px-2 font-medium">T+7</th>
                              <th className="text-right py-2 pl-2 font-medium">胜率</th>
                            </tr>
                          </thead>
                          <tbody>
                            {thread.backtest.map((row: any) => {
                              // P2.3 可信度分层：样本不足只显示行业名 + 进度
                              const tier = getBacktestTier(row.samples);
                              const showNumbers = shouldShowNumbers(tier);
                              return (
                                <tr key={row.industry} className="border-b last:border-0">
                                  <td className="py-2 pr-4 font-medium text-foreground">
                                    <span className="inline-flex items-center gap-1.5">
                                      {row.industry}
                                      <span className={cn(
                                        "text-xs px-1 py-0.5 rounded",
                                        tier === "sufficient"
                                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300"
                                          : tier === "reference"
                                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300"
                                            : "bg-muted text-muted-foreground"
                                      )}>
                                        {TIER_LABELS[tier]}
                                      </span>
                                    </span>
                                  </td>
                                  <td className="py-2 px-2 text-right tabular-nums">
                                    {row.samples}
                                    {!showNumbers && (
                                      <span className="ml-1 text-xs text-muted-foreground">/10</span>
                                    )}
                                  </td>
                                  <td className="py-2 px-2 text-right tabular-nums">
                                    {showNumbers ? <ReturnSpan value={row.avg_d1} tier={tier} /> : <Dash />}
                                  </td>
                                  <td className="py-2 px-2 text-right tabular-nums">
                                    {showNumbers ? <ReturnSpan value={row.avg_d3} tier={tier} /> : <Dash />}
                                  </td>
                                  <td className="py-2 px-2 text-right tabular-nums">
                                    {showNumbers ? <ReturnSpan value={row.avg_d7} tier={tier} /> : <Dash />}
                                  </td>
                                  <td className="py-2 pl-2 text-right tabular-nums font-medium">
                                    {showNumbers
                                      ? `${tier === "reference" ? "~" : ""}${row.win_rate}%`
                                      : <Dash />}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <p className="text-xs text-muted-foreground mt-2">
                          信号出现后行业指数平均涨跌幅 · 近 30 天 · 胜率 = T+1 上涨样本占比
                        </p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    暂无相关行情数据
                  </p>
                )}
              </div>

              {/* ── 段④ 后续关注 ── */}
              {thread.watch_points?.length > 0 && (
                <div className="bg-card border rounded-xl p-4 sm:p-6">
                  <h3 className="text-sm font-semibold text-foreground mb-3">
                    后续关注
                  </h3>
                  <ul className="space-y-1.5">
                    {thread.watch_points.map((p: string, i: number) => (
                      <li
                        key={i}
                        className="text-sm text-muted-foreground flex items-start gap-2"
                      >
                        <span className="text-primary mt-1">•</span>
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : (
            <div className="text-center py-20 text-sm text-muted-foreground">
              事件线索不存在或已被移除
            </div>
          )}
        </div>
      </AppShell>
    </>
  );
}

function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

function ReturnSpan({ value, tier }: { value: number | null; tier: string }) {
  if (value == null || Number.isNaN(Number(value)))
    return <span className="text-muted-foreground">—</span>;
  const n = Number(value);
  // A股惯例：红涨绿跌
  const cls =
    n > 0
      ? "text-red-600 dark:text-red-400"
      : n < 0
        ? "text-emerald-600 dark:text-emerald-400"
        : "text-muted-foreground";
  return (
    <span className={cls}>
      {tier === "reference" ? "~" : ""}
      {n > 0 ? "+" : ""}
      {n.toFixed(2)}%
    </span>
  );
}

/**
 * ISR: 只预渲染最近的高优先级线索（Top 50），其余走 blocking fallback。
 * P1.5 构建期 DB 解耦：限制构建期 DB 查询量，避免全量预渲染拖垮 build。
 */
export async function getStaticPaths() {
  try {
    const threads = await getEventThreads(24 * 7, 50);
    return {
      paths: threads.map((t: any) => ({ params: { id: String(t.id) } })),
      fallback: 'blocking',
    };
  } catch {
    return { paths: [], fallback: 'blocking' };
  }
}

export async function getStaticProps({ params }: { params: { id: string } }) {
  const threadId = Number(params.id);

  if (!Number.isFinite(threadId) || threadId < 1) {
    return { notFound: true };
  }

  try {
    const thread = await getEventThreadById(threadId);

    if (!thread) {
      return { notFound: true };
    }

    // P2.4：SSG 时并行预取市场上下文，ISR 首屏即有「市场反应」段
    const context = await getThreadMarketContext(thread.industries);

    return {
      props: {
        data: { ...thread, market: context.market, backtest: context.backtest },
        error: null,
      },
      revalidate: 3600,
    };
  } catch (e) {
    console.error(`[thread/${threadId}] getStaticProps error:`, e);
    return {
      props: {
        data: null,
        error: "暂时无法加载事件线索，请稍后刷新",
      },
      revalidate: 60,
    };
  }
}
