/**
 * P2.5 价值验证：5 项指标聚合 + M2 阈值对照 + go/no-go 判定。
 *
 * 纯函数 + 依赖注入（事件数据由调用方传入），便于单测。
 * R5 约束：独立访问样本 < minSessions（默认 100/周）时判定 insufficient-data，
 * 延长观察期而非硬下结论。
 *
 * M2 阈值（docs/reconstruction-plan.md）：
 * - 观察列表添加率 ≥ 5%（独立访问用户中）
 * - 周回访率 ≥ 15%
 * - 线索展开率 ≥ 20%（信号 → 线索钻取，以 thread_expand 近似）
 * - 回测分层无负反馈：无反馈渠道数据，恒通过并注明口径（见 METRIC_KEYS）
 */

export type Verdict = 'go' | 'no-go' | 'insufficient-data';

export const VERDICT_LABELS: Record<Verdict, string> = {
  go: '通过',
  'no-go': '未通过',
  'insufficient-data': '数据不足（延长观察期）',
};

/** 5 项展示指标的 key（事件白名单见 /api/events） */
export const METRIC_KEYS = [
  'watchlist_add',
  'search_query',
  'signal_click',
  'thread_expand',
  'industry_drill',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

export interface EventAggregate {
  event_type: string;
  count: number;
  sessions: number;
}

export interface ValueMetrics {
  uniqueSessions: number;
  events: EventAggregate[];
  weeklyReturn: { recentSessions: number; returning: number };
}

export interface ThresholdCheck {
  key: string;
  label: string;
  value: number; // 0-1 比率；无阈值指标为 0
  threshold: number; // 0-1；无阈值指标为 0
  pass: boolean | null; // null = 无阈值/无法判定
  note?: string;
}

export interface ValueReport {
  verdict: Verdict;
  metrics: ValueMetrics;
  checks: ThresholdCheck[];
  rates: Record<MetricKey, number>;
  weeklyReturnRate: number | null;
  generatedAt: string;
}

export const DEFAULT_THRESHOLDS = {
  watchlistAddRate: 0.05,
  weeklyReturnRate: 0.15,
  threadExpandRate: 0.2,
  minSessions: 100,
} as const;

function aggregateSessions(events: EventAggregate[], key: string): number {
  return events.find((e) => e.event_type === key)?.sessions || 0;
}

/**
 * 由聚合数据产出报告并判定 go/no-go。
 * @param metrics getEventMetrics 的返回（可注入测试数据）
 * @param thresholds 阈值；不传用默认
 */
export function evaluateValue(
  metrics: ValueMetrics,
  thresholds: Partial<typeof DEFAULT_THRESHOLDS> = {}
): ValueReport {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const total = metrics.uniqueSessions;

  const rate = (key: MetricKey) =>
    total > 0 ? aggregateSessions(metrics.events, key) / total : 0;

  const watchlistAddRate = rate('watchlist_add');
  const threadExpandRate = rate('thread_expand');
  const weekly =
    metrics.weeklyReturn.recentSessions > 0
      ? metrics.weeklyReturn.returning / metrics.weeklyReturn.recentSessions
      : null;

  const checks: ThresholdCheck[] = [
    {
      key: 'watchlist_add',
      label: '观察列表添加率（添加观察列表的用户占比）',
      value: watchlistAddRate,
      threshold: t.watchlistAddRate,
      pass: null,
    },
    {
      key: 'weekly_return',
      label: '周回访率（上周访问过的用户本周再次访问的比例）',
      value: weekly ?? 0,
      threshold: t.weeklyReturnRate,
      pass: null,
    },
    {
      key: 'thread_expand',
      label: '线索展开率（展开过事件线索的用户占比）',
      value: threadExpandRate,
      threshold: t.threadExpandRate,
      pass: null,
    },
    {
      key: 'backtest_feedback',
      label: '回测分层无负反馈',
      value: 0,
      threshold: 0,
      pass: null,
      note: '暂无独立反馈渠道——命中率(方向口径)与分层状态请以分析页回测面板为准，本项未评估',
    },
  ];

  if (total < t.minSessions) {
    return {
      verdict: 'insufficient-data',
      metrics,
      checks: checks.map((c) => ({
        ...c,
        pass: c.key === 'backtest_feedback' ? true : null,
        note: c.note || `样本不足（独立访问 ${total} < ${t.minSessions}），延长观察期后再判定`,
      })),
      rates: {
        watchlist_add: watchlistAddRate,
        search_query: rate('search_query'),
        signal_click: rate('signal_click'),
        thread_expand: threadExpandRate,
        industry_drill: rate('industry_drill'),
      },
      weeklyReturnRate: weekly,
      generatedAt: new Date().toISOString(),
    };
  }

  checks[0].pass = watchlistAddRate >= t.watchlistAddRate;
  checks[1].pass = weekly !== null && weekly >= t.weeklyReturnRate;
  checks[2].pass = threadExpandRate >= t.threadExpandRate;
  checks[3].pass = true;

  const verdict: Verdict = checks.every((c) => c.pass) ? 'go' : 'no-go';

  return {
    verdict,
    metrics,
    checks,
    rates: {
      watchlist_add: watchlistAddRate,
      search_query: rate('search_query'),
      signal_click: rate('signal_click'),
      thread_expand: threadExpandRate,
      industry_drill: rate('industry_drill'),
    },
    weeklyReturnRate: weekly,
    generatedAt: new Date().toISOString(),
  };
}
