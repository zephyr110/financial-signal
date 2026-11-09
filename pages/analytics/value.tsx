import { useState, useEffect } from "react";
import Head from "next/head";
import { Loader2, CheckCircle2, XCircle, Clock, BarChart3, ShieldCheck } from "lucide-react";
import AppShell from "../../components/app-shell";
import ErrorBanner from "../../components/ErrorBanner";
import { cn } from "@/lib/utils";
import { VERDICT_LABELS } from "@/lib/value";

/**
 * P2.5 价值验证报告：5 项指标 vs M2 阈值 → go/no-go 结论。
 * 数据来自 /api/analytics/value（getEventMetrics + evaluateValue）。
 */
export default function ValueReportPage() {
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/analytics/value")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (!cancelled) {
          setReport(d);
          setError(null);
        }
      })
      .catch(() => {
        if (!cancelled) setError("加载失败，请稍后重试");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <Head>
        <title>价值验证报告 · 收盘手记</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
      </Head>

      <AppShell title="价值验证报告">
        <div className="mx-auto flex min-h-full max-w-[720px] lg:max-w-[960px] flex-col px-4 sm:px-6 pb-12 pt-8">
          <div className="flex items-center gap-2 mb-6">
            <BarChart3 className="h-5 w-5 text-primary" />
            <h1 className="text-base sm:text-lg font-semibold text-foreground">
              价值验证报告
            </h1>
            <span className="text-xs text-muted-foreground ml-auto">
              数据窗口：最近 7 天
            </span>
          </div>

          {loading ? (
            <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">计算中…</span>
            </div>
          ) : error ? (
            <ErrorBanner message={error} />
          ) : !report ? (
            <ErrorBanner message="暂无数据" />
          ) : (
            <>
              {/* ── 判定横幅 ── */}
              <div
                className={cn(
                  "rounded-xl border p-4 sm:p-5 mb-6 flex items-start gap-3",
                  report.verdict === "go" && "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800",
                  report.verdict === "no-go" && "bg-destructive/5 border-destructive/20 dark:bg-destructive/10 dark:border-destructive/30",
                  report.verdict === "insufficient-data" && "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800"
                )}
              >
                {report.verdict === "go" ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400 shrink-0 mt-0.5" />
                ) : report.verdict === "no-go" ? (
                  <XCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                ) : (
                  <Clock className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
                )}
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    当前结论：{VERDICT_LABELS[report.verdict] || report.verdict}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    独立访问 {report.metrics.uniqueSessions} 人次
                    {report.verdict === "insufficient-data" && " · 样本量不足（建议每周 100 人次），延长观察期后再判定"}
                  </p>
                </div>
              </div>

              {/* ── 5 项指标 ── */}
              <div className="bg-card border rounded-xl p-4 sm:p-6 mb-6">
                <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1.5">
                  <ShieldCheck className="h-4 w-4 text-primary" />
                  指标与阈值对照
                </h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground border-b">
                        <th className="text-left py-2 pr-4 font-medium">指标</th>
                        <th className="text-right py-2 px-2 font-medium">实际值</th>
                        <th className="text-right py-2 px-2 font-medium">阈值</th>
                        <th className="text-right py-2 pl-2 font-medium">结论</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.checks.map((c: any) => (
                        <tr key={c.key} className="border-b last:border-0">
                          <td className="py-2.5 pr-4 text-foreground">
                            {c.label}
                            {c.note && (
                              <p className="text-xs text-muted-foreground mt-0.5">{c.note}</p>
                            )}
                          </td>
                          <td className="py-2.5 px-2 text-right tabular-nums font-medium">
                            {c.key === "backtest_feedback"
                              ? "—"
                              : `${(c.value * 100).toFixed(1)}%`}
                          </td>
                          <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                            {c.key === "backtest_feedback" ? "—" : `≥ ${(c.threshold * 100).toFixed(0)}%`}
                          </td>
                          <td className="py-2.5 pl-2 text-right">
                            {c.pass === null ? (
                              <span className="text-xs text-muted-foreground">待观察</span>
                            ) : c.pass ? (
                              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> 通过
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
                                <XCircle className="h-3.5 w-3.5" /> 未达
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ── 参考指标 ── */}
              <div className="bg-card border rounded-xl p-4 sm:p-6">
                <h3 className="text-sm font-semibold text-foreground mb-3">
                  参考指标（无阈值，仅观察）
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    { label: "信号点击率", value: report.rates.signal_click },
                    { label: "线索展开率", value: report.rates.thread_expand },
                    { label: "搜索使用率", value: report.rates.search_query },
                    { label: "行业钻取率", value: report.rates.industry_drill },
                  ].map((r) => (
                    <div key={r.label} className="rounded-lg border bg-background p-3">
                      <p className="text-xs text-muted-foreground">{r.label}</p>
                      <p className="text-sm font-semibold text-foreground tabular-nums mt-1">
                        {(r.value * 100).toFixed(1)}%
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  周回访率（上周访问过的用户本周再次访问的比例）：{" "}
                  {report.weeklyReturnRate === null
                    ? "无数据"
                    : `${(report.weeklyReturnRate * 100).toFixed(1)}%`}
                  · 生成于 {new Date(report.generatedAt).toLocaleString("zh-CN")}
                </p>
              </div>
            </>
          )}
        </div>
      </AppShell>
    </>
  );
}
