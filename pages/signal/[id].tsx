import { useState, useEffect } from "react";
import Head from "next/head";
import { useRouter } from "next/router";
import Link from "next/link";
import { ArrowLeft, Loader2 } from "lucide-react";
import AppShell from "../../components/app-shell";
import SignalDetailComponent from "../../components/SignalDetail";
import ErrorBanner from "../../components/ErrorBanner";
import { getSignalById, getHighScoreSignals, getRelatedSignals, getBacktestByIndustry } from "../../lib/db";

export default function SignalPage({ data: ssgData, error: ssgError }) {
  const router = useRouter();
  const [data, setData] = useState(ssgData || null);
  const [error, setError] = useState(ssgError ?? null);
  const [loading, setLoading] = useState(false);

  // Fallback: fetch client-side if not pre-rendered
  const rawId = router.query.id;
  const id = Array.isArray(rawId) ? rawId[0] : rawId;

  useEffect(() => {
    if (ssgData) return; // already have SSG data
    if (!id || !router.isReady) return;

    let cancelled = false;
    setLoading(true);
    fetch(`/api/signal/${id}`)
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
          setError(e.message === "NOT_FOUND" ? "信号不存在" : "加载失败，请稍后重试");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [id, router.isReady, ssgData]);

  // Loading skeleton (fallback rendering)
  if (loading) {
    return (
      <>
        <Head><title>加载中… · 收盘手记</title></Head>
        <AppShell title="信号详情">
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

  // Error state
  if (error && !data) {
    return (
      <>
        <Head><title>信号详情 · 收盘手记</title></Head>
        <AppShell title="信号详情">
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

  const signal = data?.signal;

  return (
    <>
      <Head>
        <title>
          {signal
            ? `${signal.summary?.slice(0, 40)} · 收盘手记`
            : "信号详情 · 收盘手记"}
        </title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content={
            signal?.deep_analysis?.slice(0, 160) ||
            signal?.summary?.slice(0, 160) ||
            "已入库信号的深度分析"
          }
        />
      </Head>

      <AppShell title="信号详情">
        <div className="mx-auto max-w-[720px] lg:max-w-[960px] px-4 sm:px-6 pb-12 pt-8">
          {/* Back link */}
          <Link
            href="/analysis"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            返回分析面板
          </Link>

          {signal ? (
            <SignalDetailComponent
              signal={signal}
              related={data?.related || []}
              backtest={data?.backtest || []}
            />
          ) : (
            <div className="text-center py-20 text-sm text-muted-foreground">
              信号不存在或已被移除
            </div>
          )}
        </div>
      </AppShell>
    </>
  );
}

/**
 * ISR: 只预渲染近 7 天的高分信号（Top 50），其余走 blocking fallback。
 * P1.5 构建期 DB 解耦：限制构建期 DB 查询量，避免全量预渲染拖垮 build。
 */
export async function getStaticPaths() {
  try {
    const signals = await getHighScoreSignals({ daysBack: 7, minScore: 4, limit: 50 });
    return {
      paths: signals.map((s: any) => ({ params: { id: String(s.id) } })),
      fallback: 'blocking',
    };
  } catch {
    return { paths: [], fallback: 'blocking' };
  }
}

export async function getStaticProps({ params }: { params: { id: string } }) {
  const signalId = Number(params.id);

  if (!Number.isFinite(signalId) || signalId < 1) {
    return { notFound: true };
  }

  try {
    const signal = await getSignalById(signalId);

    if (!signal) {
      return { notFound: true };
    }

    // 与 /api/signal/[id] 保持一致：SSG 时并行预取相关信号与行业回测，
    // 避免 ISR 首屏出现空白区块（revalidate 期间内容会同步更新）
    const [related, backtest] = await Promise.all([
      getRelatedSignals(signalId, signal.industries || [], signal.companies || [], 5),
      getBacktestByIndustry(30),
    ]);

    const signalIndustries: string[] = signal.industries || [];
    const relevantBacktest = backtest.filter((b: any) => {
      if (!b.industry) return false;
      return signalIndustries.some(
        (ind: string) =>
          b.industry === ind || b.industry.includes(ind) || ind.includes(b.industry)
      );
    });

    return {
      props: {
        data: { signal, related: related || [], backtest: relevantBacktest },
        error: null,
      },
      revalidate: 3600,
    };
  } catch (e) {
    console.error(`[signal/${signalId}] getStaticProps error:`, e);
    return {
      props: {
        data: null,
        error: "暂时无法加载信号详情，请稍后刷新",
      },
      revalidate: 60,
    };
  }
}
