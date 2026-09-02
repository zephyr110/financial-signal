import { useState, useEffect, useMemo } from "react";
import { TrendingUp, TrendingDown, Loader2, Building2, Hash, ArrowUp, ArrowDown, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { getBacktestTier, shouldShowNumbers, tierProgress, type BacktestTier } from "@/lib/backtest";

interface BacktestRow {
  signal_score?: number;
  industry?: string;
  samples: number;
  avg_d1: number;
  avg_d3: number;
  avg_d7: number;
  win_rate: number | null;
}

type TabKey = "score" | "industry";

// 口径说明(胜率 1.6fr 列表头与单元格悬浮提示共用):分母仅计带方向事件,中性/混合不计
const WIN_RATE_HINT =
  "方向命中率 = 看多信号次日板块上涨 / 看空信号次日下跌的比例;中性/混合事件不计入分母(样本列 = 总事件数)";

// 表格网格列模板（fr 权重自适应：行业列相对收窄，数值列相对加宽，表头与两种行共用，改列宽需同步）：
// 行业 1.4fr | 均分 0.9fr | 样本 1.4fr | 3×涨跌幅 1fr | 命中率 1.6fr | 方向 0.8fr
const HEADER_GRID = "hidden sm:grid grid-cols-[1.4fr_0.9fr_1.4fr_1fr_1fr_1fr_1.6fr_0.8fr]";
const ROW_GRID = "grid grid-cols-[1fr_40px_1fr] sm:grid-cols-[1.4fr_0.9fr_1.4fr_1fr_1fr_1fr_1.6fr_0.8fr]";

export default function BacktestPanel() {
  const [byScore, setByScore] = useState<BacktestRow[] | null>(null);
  const [byIndustry, setByIndustry] = useState<BacktestRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("industry");
  // 行业视图排序：null=默认（样本降序）；score/winRate 点击表头切换升降序
  const [sortKey, setSortKey] = useState<"score" | "winRate" | null>(null);
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const toggleSort = (key: "score" | "winRate") => {
    if (sortKey !== key) {
      setSortKey(key);
      setSortDir("desc");
    } else {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    }
  };

  const sortedIndustry = useMemo(() => {
    const rows = [...(byIndustry || [])];
    if (sortKey === "score") {
      rows.sort((a, b) =>
        sortDir === "desc"
          ? (b.signal_score ?? 0) - (a.signal_score ?? 0)
          : (a.signal_score ?? 0) - (b.signal_score ?? 0)
      );
    } else if (sortKey === "winRate") {
      // 无方向样本(NULL)视为 -1:降序时排最后,升序时排最前
      rows.sort((a, b) =>
        sortDir === "desc"
          ? (b.win_rate ?? -1) - (a.win_rate ?? -1)
          : (a.win_rate ?? -1) - (b.win_rate ?? -1)
      );
    } else {
      rows.sort((a, b) => b.samples - a.samples);
    }
    return rows.slice(0, 15);
  }, [byIndustry, sortKey, sortDir]);

  useEffect(() => {
    if (byIndustry !== null) return;
    let cancelled = false;
    setLoading(true);
    fetch("/api/backtest")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setByScore(d.byScore || []);
        setByIndustry(d.byIndustry || []);
      })
      .catch(() => {
        if (cancelled) return;
        setByScore([]);
        setByIndustry([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [byIndustry]);

  const activeData = tab === "score" ? byScore : byIndustry;
  const hasData = activeData && activeData.length > 0;

  return (
    <div className="bg-card border rounded-xl mb-6 overflow-hidden">
      {loading ? (
        <div className="flex min-h-28 items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-xs">加载中…</span>
        </div>
      ) : !hasData ? (
        <div className="text-center py-8 text-xs text-muted-foreground">
          暂无数据，信号和行情积累后自动生成
        </div>
      ) : (
        <>
          {/* Tab switcher */}
          <div className="px-4 sm:px-5 pt-4 sm:pt-5">
          <div className="flex items-center gap-1 mb-3">
                <button
                  type="button"
                  onClick={() => setTab("industry")}
                  className={cn(
                    "inline-flex items-center gap-1 px-2.5 h-8 rounded-md text-xs transition-colors",
                    tab === "industry"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  <Building2 className="h-3 w-3" />
                  按行业
                </button>
                <button
                  type="button"
                  onClick={() => setTab("score")}
                  className={cn(
                    "inline-flex items-center gap-1 px-2.5 h-8 rounded-md text-xs transition-colors",
                    tab === "score"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                >
                  <Hash className="h-3 w-3" />
                  按分数
                </button>
              </div>

              {/* Header */}
              <div className={cn(HEADER_GRID, "gap-2 mb-1 text-xs text-muted-foreground px-1")}>
                <span>{tab === "industry" ? "行业" : "分数"}</span>
                {tab === "industry" ? (
                  <SortableHeader
                    label="均分"
                    active={sortKey === "score"}
                    dir={sortDir}
                    onClick={() => toggleSort("score")}
                  />
                ) : (
                  <span />
                )}
                <span>样本</span>
                <span>T+1</span>
                <span>T+3</span>
                <span>T+7</span>
                {tab === "industry" ? (
                  <SortableHeader
                    label="命中率"
                    title={WIN_RATE_HINT}
                    active={sortKey === "winRate"}
                    dir={sortDir}
                    onClick={() => toggleSort("winRate")}
                  />
                ) : (
                  <span title={WIN_RATE_HINT}>命中率</span>
                )}
                <span>方向</span>
              </div>
          </div>

          {/* 表格 body：固定高度内垂直滚动，表头常驻（行溢出不可见时滚动查看） */}
          <div className="px-4 sm:px-5 pb-4 sm:pb-5 max-h-[320px] overflow-y-auto overscroll-contain">
              {/* Industry view */}
              {tab === "industry" &&
                sortedIndustry.map((row) => {
                  // P2.3 可信度分层：样本不足只显示行业名 + 进度（不展示数字，R4 只改展示不改数据）
                  const tier = getBacktestTier(row.samples);
                  const showNumbers = shouldShowNumbers(tier);
                  return (
                    <div
                      key={`${row.industry}-${row.signal_score}`}
                      className={cn(ROW_GRID, "gap-2 items-center py-2 px-1 border-t first:border-t-0 hover:bg-accent/20 rounded transition-colors")}
                    >
                      <span className="text-xs font-medium text-foreground truncate">
                        {row.industry}
                      </span>
                      <ScoreBadge score={row.signal_score} />
                      <SampleCell samples={row.samples} tier={tier} />
                      <div className="sm:hidden text-xs text-muted-foreground">
                        {showNumbers
                          ? `${row.avg_d1 > 0 ? "看涨" : "看跌"} · ${tier === "reference" ? "~" : ""}样本 ${row.samples} · T+1 ${fmtPct(row.avg_d1, tier)} · T+3 ${fmtPct(row.avg_d3, tier)} · T+7 ${fmtPct(row.avg_d7, tier)}`
                          : tierProgress(row.samples)}
                      </div>
                      <ReturnCell value={row.avg_d1} show={showNumbers} tier={tier} />
                      <ReturnCell value={row.avg_d3} show={showNumbers} tier={tier} />
                      <ReturnCell value={row.avg_d7} show={showNumbers} tier={tier} />
                      <WinRateCell rate={row.win_rate} show={showNumbers} tier={tier} />
                      <DirectionCell value={row.avg_d1} show={showNumbers} />
                    </div>
                  );
                })}

              {/* Score view */}
              {tab === "score" &&
                (byScore as BacktestRow[])
                  ?.sort((a, b) => (b.signal_score ?? 0) - (a.signal_score ?? 0))
                  .map((row, i) => {
                    // 分数组同样受分层约束：样本不足不展示收益/胜率数字
                    const tier = getBacktestTier(row.samples);
                    const showNumbers = shouldShowNumbers(tier);
                    return (
                      <div
                        key={`score-${row.signal_score ?? "null"}-${i}`}
                        className={cn(ROW_GRID, "gap-2 items-center py-2 px-1 border-t first:border-t-0 hover:bg-accent/20 rounded transition-colors")}
                      >
                        <ScoreBadge score={row.signal_score} />
                        <span className="w-6" />
                        <SampleCell samples={row.samples} tier={tier} />
                        <div className="sm:hidden text-xs text-muted-foreground">
                          {showNumbers
                            ? `${tier === "reference" ? "~" : ""}样本 ${row.samples} · T+1 ${fmtPct(row.avg_d1, tier)} · T+3 ${fmtPct(row.avg_d3, tier)} · T+7 ${fmtPct(row.avg_d7, tier)}`
                            : tierProgress(row.samples)}
                        </div>
                        <ReturnCell value={row.avg_d1} show={showNumbers} tier={tier} />
                        <ReturnCell value={row.avg_d3} show={showNumbers} tier={tier} />
                        <ReturnCell value={row.avg_d7} show={showNumbers} tier={tier} />
                        <WinRateCell rate={row.win_rate} show={showNumbers} tier={tier} />
                        <DirectionCell value={row.avg_d1} show={showNumbers} />
                      </div>
                    );
                  })}
          </div>
        </>
      )}
    </div>
  );
}

/** 可排序表头：点击切换升降序，未激活显示中性排序图标。 */
function SortableHeader({
  label,
  title,
  active,
  dir,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  dir: "desc" | "asc";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex items-center gap-0.5 text-xs transition-colors hover:text-foreground",
        active && "text-foreground font-medium"
      )}
      aria-label={`按${label}${active && dir === "asc" ? "升序" : "降序"}排序`}
    >
      {label}
      {active ? (
        dir === "desc" ? (
          <ArrowDown className="h-3 w-3" />
        ) : (
          <ArrowUp className="h-3 w-3" />
        )
      ) : (
        <ChevronsUpDown className="h-3 w-3 opacity-40" />
      )}
    </button>
  );
}

/** 方向列：T+1 平均涨跌幅 > 0 → 看涨（红），否则看跌（绿），A 股红涨绿跌惯例。 */
function DirectionCell({ value, show = true }: { value: number; show?: boolean }) {
  if (!show || value == null)
    return <span className="hidden text-xs text-muted-foreground sm:block">—</span>;
  const bull = value > 0;
  return (
    <span
      className={cn(
        "hidden sm:inline-flex items-center justify-center rounded px-1.5 py-0.5 text-xs font-medium",
        bull
          ? "bg-red-100 text-red-600 dark:bg-red-950/50 dark:text-red-400"
          : "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400"
      )}
    >
      {bull ? "看涨" : "看跌"}
    </span>
  );
}

/** 样本列：充足=绿徽章数字、参考=琥珀 ~数字（与行内 ~ 约定一致）、积累=灰进度。 */
function SampleCell({ samples, tier }: { samples: number; tier: BacktestTier }) {
  return (
    <span
      className={cn(
        "hidden sm:inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium tabular-nums",
        tier === "sufficient" &&
          "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
        tier === "reference" &&
          "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
        tier === "accumulating" && "bg-muted text-muted-foreground"
      )}
    >
      {tier === "accumulating" ? tierProgress(samples) : tier === "reference" ? `~${samples}` : samples}
    </span>
  );
}

function ScoreBadge({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="w-6 h-6" />;
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center rounded-full text-xs font-bold shrink-0 w-6 h-6",
        score >= 5
          ? "bg-red-600 text-white"
          : score >= 4
            ? "bg-orange-500 text-white"
            : "bg-yellow-500 text-white"
      )}
    >
      {score}
    </span>
  );
}

function ReturnCell({ value, show = true, tier }: { value: number; show?: boolean; tier?: BacktestTier }) {
  if (!show || value == null)
    return (
      <span className="text-xs text-muted-foreground tabular-nums hidden sm:block">
        —
      </span>
    );
  const isPositive = value > 0;
  // A股惯例：红涨绿跌
  return (
    <span
      className={cn(
        "hidden sm:flex items-center gap-1 text-xs font-medium tabular-nums",
        isPositive
          ? "text-red-600 dark:text-red-400"
          : value < 0
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground"
      )}
    >
      {isPositive ? (
        <TrendingUp className="h-3 w-3" />
      ) : value < 0 ? (
        <TrendingDown className="h-3 w-3" />
      ) : null}
      {fmtPct(value, tier)}
    </span>
  );
}

function WinRateCell({ rate, show = true, tier }: { rate: number | null; show?: boolean; tier?: BacktestTier }) {
  // rate 为 NULL = 该组无带方向事件(全部中性/混合/遗留),展示 "—" 而非参与数字
  const hasRate = show && rate != null;
  return (
    <div className="hidden sm:flex items-center gap-1.5" title={rate == null ? "无带方向样本,不计命中率" : undefined}>
      <div className="flex-1 h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", hasRate ? "bg-primary" : "bg-border")}
          style={{ width: hasRate ? `${rate}%` : "100%" }}
        />
      </div>
      <span className="text-xs font-medium tabular-nums w-9 text-right">
        {hasRate ? `${tier === "reference" ? "~" : ""}${rate}%` : "—"}
      </span>
    </div>
  );
}

function fmtPct(v: number, tier?: BacktestTier): string {
  if (v == null || isNaN(v)) return "—";
  return `${tier === "reference" ? "~" : ""}${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
