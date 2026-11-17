import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({
  getWatchlist: vi.fn(),
  getPortfolio: vi.fn(),
  getTheses: vi.fn(),
}));

vi.mock('../cockpit/repo', () => repo);

import { loadPersonalContextPrompt } from './personal-context';

function watch(code: string, name: string) {
  return { code, name, price: 10, changePct: 1, sparkline: [] };
}

function position(code: string, name: string, weight: number) {
  return {
    code, name, shares: 100, avgCost: 10, price: 11, marketValue: 1100,
    pnl: 100, pnlPct: 10, weight, industry: '测试',
  };
}

function thesis(code: string, title: string, status: string, support = 1, oppose = 0) {
  return {
    id: 't', code, name: title, title, claim: 'c', horizon: '1年', status,
    confidence: '中', invalidation: [], supportCount: support, opposeCount: oppose,
  };
}

describe('loadPersonalContextPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('三个面板都为空时不注入任何内容', async () => {
    repo.getWatchlist.mockResolvedValue([]);
    repo.getPortfolio.mockResolvedValue({ positions: [], isDemo: false });
    repo.getTheses.mockResolvedValue([]);
    expect(await loadPersonalContextPrompt()).toBe('');
  });

  it('输出代码、权重（按权重降序）与论点状态', async () => {
    repo.getWatchlist.mockResolvedValue([watch('600519', '贵州茅台')]);
    repo.getPortfolio.mockResolvedValue({
      positions: [position('600519', '贵州茅台', 10), position('688041', '海光信息', 90)],
      isDemo: true,
    });
    repo.getTheses.mockResolvedValue([thesis('600519', '渠道改革', 'weakened', 3, 2)]);

    const text = await loadPersonalContextPrompt();
    expect(text).toContain('自选（1只）：600519 贵州茅台');
    expect(text).toContain('持仓（示例数据）（2只）');
    expect(text.indexOf('688041')).toBeLessThan(text.indexOf('600519 贵州茅台 10.0%'));
    expect(text).toContain('688041 海光信息 90.0%');
    expect(text).toContain('600519 渠道改革（出现反证，支撑3/反驳2）');
    // 只给摘要，不给明细；明细要通过工具按需读取
    expect(text).toContain('get_portfolio');
    expect(text).not.toContain('市值');
  });

  it('超出上限时截断并标注「等」', async () => {
    repo.getWatchlist.mockResolvedValue(
      Array.from({ length: 13 }, (_, i) => watch(`00000${i}`, `股票${i}`)),
    );
    repo.getPortfolio.mockResolvedValue({
      positions: Array.from({ length: 11 }, (_, i) => position(`00010${i}`, `持仓${i}`, i + 1)),
      isDemo: false,
    });
    repo.getTheses.mockResolvedValue(
      Array.from({ length: 9 }, (_, i) => thesis(`00020${i}`, `论点${i}`, 'active')),
    );

    const text = await loadPersonalContextPrompt();
    expect(text).toContain('自选（13只）');
    expect(text).toContain('股票11 等');
    expect(text).not.toContain('股票12');
    expect(text).toContain('持仓（11只）');
    expect(text).toContain('持仓1 2.0% 等');
    expect(text).not.toContain('持仓0 ');
    expect(text).toContain('研究论点（9条）');
    expect(text).toContain('论点7（论证中');
    expect(text).not.toContain('论点8');
  });

  it('面板读取失败时静默降级，不阻断对话', async () => {
    repo.getWatchlist.mockRejectedValue(new Error('db locked'));
    repo.getPortfolio.mockResolvedValue({ positions: [], isDemo: false });
    repo.getTheses.mockResolvedValue([]);
    expect(await loadPersonalContextPrompt()).toBe('');
  });
});
