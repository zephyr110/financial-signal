/** 信号分类（与 LLM category 枚举一致） */
export const SIGNAL_CATEGORIES = [
  'policy',
  'geopolitics',
  'industry',
  'company',
  'macro',
  'market_rumor',
] as const;

export type SignalCategory = (typeof SIGNAL_CATEGORIES)[number];

export const SENTIMENT_KEYS = ['positive', 'negative', 'neutral', 'mixed'] as const;

export type SentimentKey = (typeof SENTIMENT_KEYS)[number];

export interface SentimentBreakdownRow {
  category: SignalCategory;
  positive: number;
  negative: number;
  neutral: number;
  mixed: number;
}

const CATEGORY_SET = new Set<string>(SIGNAL_CATEGORIES);
const SENTIMENT_SET = new Set<string>(SENTIMENT_KEYS);

function emptyCounts(): Record<SentimentKey, number> {
  return { positive: 0, negative: 0, neutral: 0, mixed: 0 };
}

function normalizeCategory(raw: unknown): SignalCategory {
  const cat = typeof raw === 'string' && raw ? raw : 'macro';
  return CATEGORY_SET.has(cat) ? (cat as SignalCategory) : 'macro';
}

function normalizeSentiment(raw: unknown): SentimentKey {
  const sent = typeof raw === 'string' && raw ? raw : 'neutral';
  return SENTIMENT_SET.has(sent) ? (sent as SentimentKey) : 'neutral';
}

/**
 * 按信号分类聚合情感分布（仅 signal_score ≥ minScore，默认 3）。
 * 未知 category 归入 macro；未知 sentiment 归入 neutral。
 */
export function computeSentimentBreakdown(
  items: { signal_score?: number | null; category?: string | null; sentiment?: string | null }[],
  minScore = 3,
): SentimentBreakdownRow[] {
  const result: Record<SignalCategory, Record<SentimentKey, number>> = {} as Record<
    SignalCategory,
    Record<SentimentKey, number>
  >;
  for (const cat of SIGNAL_CATEGORIES) {
    result[cat] = emptyCounts();
  }

  for (const item of items) {
    const score = item.signal_score;
    if (score == null || score < minScore) continue;
    const cat = normalizeCategory(item.category);
    const sent = normalizeSentiment(item.sentiment);
    result[cat][sent]++;
  }

  return SIGNAL_CATEGORIES.map((cat) => ({
    category: cat,
    ...result[cat],
  })).filter((d) => d.positive + d.negative + d.neutral + d.mixed > 0);
}

/** DB 聚合行 → 前端 breakdown 结构 */
export function aggregateSentimentRows(
  rows: { category: unknown; sentiment: unknown; cnt: number }[],
): SentimentBreakdownRow[] {
  const result: Record<SignalCategory, Record<SentimentKey, number>> = {} as Record<
    SignalCategory,
    Record<SentimentKey, number>
  >;
  for (const cat of SIGNAL_CATEGORIES) {
    result[cat] = emptyCounts();
  }

  for (const row of rows) {
    const cat = normalizeCategory(row.category);
    const sent = normalizeSentiment(row.sentiment);
    const n = Number(row.cnt);
    if (!Number.isFinite(n) || n <= 0) continue;
    result[cat][sent] += n;
  }

  return SIGNAL_CATEGORIES.map((cat) => ({
    category: cat,
    ...result[cat],
  })).filter((d) => d.positive + d.negative + d.neutral + d.mixed > 0);
}

/** 整体情绪结论（与 SentimentChart 展示一致） */
export function summarizeOverallSentiment(data: SentimentBreakdownRow[]): {
  label: string;
  positivePct: number;
  negativePct: number;
  neutralPct: number;
  mixedPct: number;
  total: number;
} {
  let totalPositive = 0;
  let totalNegative = 0;
  let totalNeutral = 0;
  let totalMixed = 0;

  for (const d of data) {
    totalPositive += d.positive;
    totalNegative += d.negative;
    totalNeutral += d.neutral;
    totalMixed += d.mixed;
  }

  const total = totalPositive + totalNegative + totalNeutral + totalMixed;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
  const positivePct = pct(totalPositive);
  const negativePct = pct(totalNegative);
  const neutralPct = pct(totalNeutral);
  const mixedPct = pct(totalMixed);

  let label = '多空分歧';
  if (positivePct >= 50) label = '偏积极 ↑';
  else if (negativePct >= 50) label = '偏消极 ↓';

  return { label, positivePct, negativePct, neutralPct, mixedPct, total };
}
