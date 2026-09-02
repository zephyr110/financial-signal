import { describe, it, expect } from 'vitest';
import {
  aggregateSentimentRows,
  computeSentimentBreakdown,
  summarizeOverallSentiment,
} from './sentiment';

describe('computeSentimentBreakdown', () => {
  it('仅统计 ≥3 分信号', () => {
    const rows = computeSentimentBreakdown([
      { signal_score: 2, category: 'policy', sentiment: 'positive' },
      { signal_score: 3, category: 'policy', sentiment: 'positive' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].positive).toBe(1);
  });

  it('未知 category 归入 macro', () => {
    const rows = computeSentimentBreakdown([
      { signal_score: 4, category: 'unknown_cat', sentiment: 'negative' },
    ]);
    expect(rows).toEqual([expect.objectContaining({ category: 'macro', negative: 1 })]);
  });

  it('未知 sentiment 归入 neutral', () => {
    const rows = computeSentimentBreakdown([
      { signal_score: 5, category: 'industry', sentiment: 'bullish' },
    ]);
    expect(rows[0].neutral).toBe(1);
  });

  it('空输入返回空数组', () => {
    expect(computeSentimentBreakdown([])).toEqual([]);
  });
});

describe('aggregateSentimentRows', () => {
  it('合并 DB 分组计数', () => {
    const rows = aggregateSentimentRows([
      { category: 'policy', sentiment: 'positive', cnt: 2 },
      { category: 'policy', sentiment: 'negative', cnt: 1 },
    ]);
    expect(rows[0]).toMatchObject({ category: 'policy', positive: 2, negative: 1 });
  });
});

describe('summarizeOverallSentiment', () => {
  it('看多过半判偏积极', () => {
    const s = summarizeOverallSentiment([
      { category: 'policy', positive: 6, negative: 2, neutral: 2, mixed: 0 },
    ]);
    expect(s.label).toBe('偏积极 ↑');
    expect(s.total).toBe(10);
  });

  it('无单一方向过半判多空分歧', () => {
    const s = summarizeOverallSentiment([
      { category: 'macro', positive: 3, negative: 3, neutral: 3, mixed: 1 },
    ]);
    expect(s.label).toBe('多空分歧');
  });
});
