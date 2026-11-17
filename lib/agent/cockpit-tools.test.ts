import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({
  getTodayPayload: vi.fn(),
  getWatchlist: vi.fn(),
  getPortfolio: vi.fn(),
  getTheses: vi.fn(),
  getStockDetail: vi.fn(),
}));
const db = vi.hoisted(() => ({
  getDb: vi.fn(),
  getSignalById: vi.fn(),
  getRelatedSignals: vi.fn(),
}));
const tasks = vi.hoisted(() => ({ listTasks: vi.fn() }));
const fts = vi.hoisted(() => ({ searchSourceDocuments: vi.fn() }));

vi.mock('../cockpit/repo', () => repo);
vi.mock('../cockpit/tasks', () => tasks);
vi.mock('../search/fts', () => fts);
vi.mock('../db', () => db);

import { COCKPIT_TOOLS } from './cockpit-tools';

const tool = (name: string) => COCKPIT_TOOLS.find((t) => t.name === name)!;

function briefPayload(overrides: Record<string, unknown> = {}) {
  return {
    tradeDate: '2026-11-17',
    issueNo: 12,
    session: 'post',
    hero: {
      claim: '指数缩量整理，政策线索偏强',
      confidence: { score: 0.72, label: '中', inputs: { completeness: 0.8, freshness: 0.7, agreement: 0.7, sourceQuality: 0.7 } },
      evidence: [],
    },
    indices: [{ code: '000001.SH', name: '上证指数', close: 3123.45, changePct: 0.42, sparkline: [], source: { id: 's', name: '行情', tier: 1, asOf: '2026-11-17' } }],
    breadth: { up: 2800, flat: 120, down: 1900, limitUp: 45, limitDown: 8, limitUpDownAvailable: true, source: { id: 's', name: '行情', tier: 1, asOf: '2026-11-17' } },
    turnover: { value: 980000000000, changePct: 3.2, source: { id: 's', name: '行情', tier: 1, asOf: '2026-11-17' } },
    impacts: [{ code: '600519', name: '贵州茅台', headline: '公告提及渠道调整', detail: '影响有限', thesisStatus: 'weakened', evidence: [] }],
    documents: [{ id: 'doc-1', title: '关于推进资本市场改革的意见', issuer: '证监会', publishedAt: '2026-11-17T09:00:00Z', source: { id: 'csrc', name: '证监会', tier: 0, asOf: '2026-11-17' } }],
    tomorrow: ['观察成交量能否放大'],
    dataQuality: [{ id: 'tushare', name: 'Tushare', tier: 1, status: 'stale', message: '行情延迟' }],
    isDemo: false,
    generatedAt: '2026-11-17T08:30:00Z',
    ...overrides,
  };
}

describe('get_today_brief', () => {
  it('输出简报核心事实与数据质量提示', async () => {
    repo.getTodayPayload.mockResolvedValue(briefPayload());
    const text = await tool('get_today_brief').execute({});
    expect(text).toContain('交易日 2026-11-17');
    expect(text).toContain('指数缩量整理');
    expect(text).toContain('上证指数');
    expect(text).toContain('涨停45');
    expect(text).toContain('贵州茅台');
    expect(text).toContain('关于推进资本市场改革的意见');
    expect(text).toContain('观察成交量能否放大');
    expect(text).toContain('Tushare：stale');
  });

  it('示例数据明确标注', async () => {
    repo.getTodayPayload.mockResolvedValue(briefPayload({ isDemo: true }));
    expect(await tool('get_today_brief').execute({})).toContain('（示例数据）');
  });

  it('没有已发布简报时给出任务排查入口', async () => {
    repo.getTodayPayload.mockResolvedValue(null);
    expect(await tool('get_today_brief').execute({})).toContain('get_tasks');
  });
});

describe('search_documents', () => {
  beforeEach(() => {
    fts.searchSourceDocuments.mockReset();
    db.getDb.mockReset();
  });

  it('短查询直接提示，不误报无结果', async () => {
    expect(await tool('search_documents').execute({ query: '存' })).toContain('至少 2 个字符');
    expect(fts.searchSourceDocuments).not.toHaveBeenCalled();
  });

  it('返回标题、类型、机构与原文链接', async () => {
    fts.searchSourceDocuments.mockResolvedValue([
      { id: 'doc-1', title: '关于推进资本市场改革的意见', source_id: 'csrc', published_at: '2026-11-17T09:00:00Z' },
    ]);
    const execute = vi.fn().mockResolvedValue({
      rows: [{ id: 'doc-1', doc_type: 'policy', issuer: '证监会', url: 'https://example.com/doc' }],
    });
    db.getDb.mockResolvedValue({ execute });
    const text = await tool('search_documents').execute({ query: '资本市场' });
    expect(text).toContain('#doc-1');
    expect(text).toContain('[policy]');
    expect(text).toContain('证监会');
    expect(text).toContain('https://example.com/doc');
  });

  it('无结果时明确说明检索范围', async () => {
    fts.searchSourceDocuments.mockResolvedValue([]);
    db.getDb.mockResolvedValue({ execute: vi.fn() });
    expect(await tool('search_documents').execute({ query: '不存在' })).toContain('没有检索到');
  });
});

describe('get_watchlist', () => {
  it('自选为空时明确说明', async () => {
    repo.getWatchlist.mockResolvedValue([]);
    expect(await tool('get_watchlist').execute({})).toBe('自选为空。');
  });

  it('输出代码、名称、涨跌、备注与论点状态', async () => {
    repo.getWatchlist.mockResolvedValue([
      { code: '600519', name: '贵州茅台', price: 1500, changePct: -1.2, sparkline: [], note: '渠道跟踪', thesisStatus: 'weakened' },
    ]);
    const text = await tool('get_watchlist').execute({});
    expect(text).toContain('600519 贵州茅台');
    expect(text).toContain('-1.20%');
    expect(text).toContain('渠道跟踪');
    expect(text).toContain('出现反证');
  });
});

describe('get_portfolio', () => {
  it('无持仓时明确说明', async () => {
    repo.getPortfolio.mockResolvedValue({ positions: [], isDemo: false });
    expect(await tool('get_portfolio').execute({})).toBe('当前没有持仓记录。');
  });

  it('输出市值、盈亏、权重、行业暴露与风险', async () => {
    repo.getPortfolio.mockResolvedValue({
      totalValue: 20000000,
      totalPnl: 1200000,
      totalPnlPct: 6.4,
      positions: [
        { code: '600519', name: '贵州茅台', shares: 100, avgCost: 1400, price: 1500, marketValue: 15000000, pnl: 1000000, pnlPct: 7.14, weight: 75, industry: '食品饮料' },
      ],
      exposure: [{ industry: '食品饮料', weight: 75 }],
      concentration: 75,
      risks: [{ level: 'warn', title: '行业集中', detail: '单一行业权重过高' }],
      isDemo: true,
    });
    const text = await tool('get_portfolio').execute({});
    expect(text).toContain('（示例数据）');
    expect(text).toContain('¥20.00万');
    expect(text).toContain('600519 贵州茅台');
    expect(text).toContain('权重 75.0%');
    expect(text).toContain('行业暴露：食品饮料 75.0%');
    expect(text).toContain('[warn] 行业集中');
  });
});

describe('get_theses', () => {
  const rows = [
    { id: 1, code: '600519', name: '贵州茅台', title: '渠道改革', claim: '渠道调整改善利润率', horizon: '6个月', status: 'active', confidence: '中', invalidation: ['批价持续下跌'], supportCount: 3, opposeCount: 0, lastReviewedAt: '2026-11-10' },
    { id: 2, code: '688041', name: '海光信息', title: '国产替代', claim: '国产CPU份额提升', horizon: '12个月', status: 'weakened', confidence: '低', invalidation: ['大客户流失'], supportCount: 2, opposeCount: 2 },
  ];

  it('无论点时明确说明', async () => {
    repo.getTheses.mockResolvedValue([]);
    expect(await tool('get_theses').execute({})).toContain('还没有建立研究论点');
  });

  it('按代码过滤并输出失效条件', async () => {
    repo.getTheses.mockResolvedValue(rows);
    const text = await tool('get_theses').execute({ code: '600519' });
    expect(text).toContain('贵州茅台');
    expect(text).not.toContain('海光信息');
    expect(text).toContain('失效条件：批价持续下跌');
    expect(text).toContain('支撑3/反驳0');
  });

  it('按状态过滤', async () => {
    repo.getTheses.mockResolvedValue(rows);
    const text = await tool('get_theses').execute({ status: 'weakened' });
    expect(text).toContain('海光信息');
    expect(text).not.toContain('贵州茅台');
  });
});

describe('get_stock_detail', () => {
  it('未入库标的返回明确提示', async () => {
    repo.getStockDetail.mockResolvedValue(null);
    expect(await tool('get_stock_detail').execute({ code: '000000' })).toContain('未找到标的');
  });

  it('输出价格、区间涨跌、公告与论点', async () => {
    const bars = Array.from({ length: 25 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, close: 100 + i }));
    repo.getStockDetail.mockResolvedValue({
      code: '600519', name: '贵州茅台', exchange: 'SSE', industry: '食品饮料',
      price: 124, changePct: 0.8, asOf: '2026-11-17', bars,
      evidence: [], documents: [{ id: 'd1', title: '渠道调整公告', publishedAt: '2026-11-16T10:00:00Z', source: { id: 's', name: '上交所', tier: 0, asOf: '2026-11-16' } }],
      thesis: { id: 1, code: '600519', name: '贵州茅台', title: '渠道改革', claim: '改善利润率', horizon: '6个月', status: 'active', confidence: '中', invalidation: [], supportCount: 1, opposeCount: 0 },
      isDemo: false,
    });
    const text = await tool('get_stock_detail').execute({ code: '600519' });
    expect(text).toContain('600519 贵州茅台');
    expect(text).toContain('现价 124.00');
    expect(text).toContain('近5日');
    expect(text).toContain('渠道调整公告');
    expect(text).toContain('研究论点：渠道改革');
  });
});

describe('get_signal_detail', () => {
  it('非法 id 明确拒绝', async () => {
    expect(await tool('get_signal_detail').execute({ signalId: 0 })).toContain('大于 0');
  });

  it('输出深度分析与相关信号', async () => {
    db.getSignalById.mockResolvedValue({
      id: 1019, news_id: 88, signal_score: 4, category: 'industry', impact_level: 'high',
      sentiment: 'positive', summary: '海光信息获大单', deep_analysis: '国产CPU需求上行，关注订单持续性。',
      industries: ['半导体'], companies: ['海光信息'], tags: ['国产替代'],
      analyzed_at: '2026-11-16', source: '财联社', content: '原文内容', published_at: '2026-11-16T10:00:00Z',
      event_thread: { id: 7, title: '国产算力', stage: '发酵', confidence: '中' },
    });
    db.getRelatedSignals.mockResolvedValue([
      { id: 1020, signal_score: 3, category: 'industry', industries: ['半导体'], summary: '国产CPU招标落地', published_at: '2026-11-16T12:00:00Z' },
    ]);
    const text = await tool('get_signal_detail').execute({ signalId: 1019 });
    expect(text).toContain('#1019');
    expect(text).toContain('深度分析：国产CPU需求上行');
    expect(text).toContain('事件线索：#7 国产算力');
    expect(text).toContain('#1020');
  });

  it('无深度分析时回退原文摘录', async () => {
    db.getSignalById.mockResolvedValue({
      id: 1, signal_score: 3, category: 'macro', impact_level: 'medium', sentiment: 'neutral',
      summary: '摘要', deep_analysis: null, industries: [], companies: [], tags: [],
      source: '官方', content: '原文很长', published_at: '2026-11-16T10:00:00Z', event_thread: null,
    });
    db.getRelatedSignals.mockResolvedValue([]);
    const text = await tool('get_signal_detail').execute({ signalId: 1 });
    expect(text).toContain('原文摘录：原文很长');
  });
});

describe('get_tasks', () => {
  const rows = [
    { id: 't1', type: 'daily_brief', status: 'failed', progress: 40, step: '拉取行情', error: 'Tushare 超时', createdAt: '2026-11-17 08:00', finishedAt: '2026-11-17 08:05' },
    { id: 't2', type: 'market_ingest', status: 'succeeded', progress: 100, createdAt: '2026-11-17 07:00' },
  ];

  it('无任务时明确说明', async () => {
    tasks.listTasks.mockResolvedValue([]);
    expect(await tool('get_tasks').execute({})).toContain('暂无任务');
  });

  it('按状态过滤并输出失败原因', async () => {
    tasks.listTasks.mockResolvedValue(rows);
    const text = await tool('get_tasks').execute({ status: 'failed' });
    expect(text).toContain('daily_brief');
    expect(text).toContain('Tushare 超时');
    expect(text).not.toContain('market_ingest');
  });
});
