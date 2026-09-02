import { describe, it, expect } from 'vitest';
import { getBacktestTier, shouldShowNumbers, tierProgress, TIER_LABELS } from '../lib/backtest';

describe('P2.3 回测可信度分层', () => {
  it('三档边界：<10 积累中，10-29 参考，≥30 充足', () => {
    expect(getBacktestTier(0)).toBe('accumulating');
    expect(getBacktestTier(9)).toBe('accumulating');
    expect(getBacktestTier(10)).toBe('reference'); // 下边界含 10
    expect(getBacktestTier(29)).toBe('reference');
    expect(getBacktestTier(30)).toBe('sufficient'); // 上边界含 30
    expect(getBacktestTier(100)).toBe('sufficient');
  });

  it('accumulating 不展示数字，其余两档展示', () => {
    expect(shouldShowNumbers(getBacktestTier(5))).toBe(false);
    expect(shouldShowNumbers(getBacktestTier(15))).toBe(true);
    expect(shouldShowNumbers(getBacktestTier(50))).toBe(true);
  });

  it('进度文案与档位标签', () => {
    expect(tierProgress(7)).toBe('多空样本 7/10');
    expect(tierProgress(0)).toBe('多空样本 0/10');
    expect(TIER_LABELS.accumulating).toBe('数据积累中');
    expect(TIER_LABELS.reference).toBe('仅供参考');
    expect(TIER_LABELS.sufficient).toBe('样本充足');
  });
});
