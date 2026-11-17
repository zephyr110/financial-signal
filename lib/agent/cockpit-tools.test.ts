import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({
  getTodayPayload: vi.fn(),
  getWatchlist: vi.fn(),
  getPortfolio: vi.fn(),
  getTheses: vi.fn(),
  getStockDetail: vi.fn(),
  getJournal: vi.fn(),
  getSourceHealth: vi.fn(),
}));
const db = vi.hoisted(() => ({
  getDb: vi.fn(),
  getSignalById: vi.fn(),
  getRelatedSignals: vi.fn(),
  getAnalysisStats: vi.fn(),
  getIndustryTrend: vi.fn(),
  getCompanyHeatmap: vi.fn(),
  getSentimentBreakdown: vi.fn(),
}));
const tasks = vi.hoisted(() => ({
  listTasks: vi.fn(),
  getTask: vi.fn(),
  getTaskEvents: vi.fn(),
}));
const notifications = vi.hoisted(() => ({ listNotifications: vi.fn() }));
const fts = vi.hoisted(() => ({ searchSourceDocuments: vi.fn() }));

vi.mock('../cockpit/repo', () => repo);
vi.mock('../cockpit/tasks', () => tasks);
vi.mock('../cockpit/notifications', () => notifications);
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
      { code: '600519', name: '贵州茅台', price: 1500, changePct: -1.2, sparkline: [], note: '渠道跟踪', thesisStatus: 'weakened', nextEvent: '三季报披露' },
    ]);
    const text = await tool('get_watchlist').execute({});
    expect(text).toContain('600519 贵州茅台');
    expect(text).toContain('-1.20%');
    expect(text).toContain('渠道跟踪');
    expect(text).toContain('出现反证');
    expect(text).toContain('事件：三季报披露');
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

describe('get_journal', () => {
  const rows = [
    { id: 1, entryDate: '2026-11-10', code: '600519', action: 'buy', reason: '渠道改革落地，批价企稳', outcomeNote: '三周后批价回落，判断偏早', createdAt: '2026-11-10 15:30:00' },
    { id: 2, entryDate: '2026-11-08', action: 'review', reason: '复盘十月的回避决定', createdAt: '2026-11-08 09:00:00' },
  ];

  it('无日志时明确说明记录边界', async () => {
    repo.getJournal.mockResolvedValue([]);
    expect(await tool('get_journal').execute({})).toContain('还没有研究日志');
  });

  it('输出动作、标的、理由与复盘', async () => {
    repo.getJournal.mockResolvedValue(rows);
    const text = await tool('get_journal').execute({});
    expect(text).toContain('2026-11-10 [记录买入] 600519');
    expect(text).toContain('理由：渠道改革落地');
    expect(text).toContain('复盘：三周后批价回落');
    expect(text).toContain('[复盘旧决定]');
  });

  it('按代码过滤，无匹配时明确说明', async () => {
    repo.getJournal.mockResolvedValue(rows);
    const filtered = await tool('get_journal').execute({ code: '600519' });
    expect(filtered).toContain('600519');
    expect(filtered).not.toContain('复盘十月的回避决定');

    const none = await tool('get_journal').execute({ code: '000000' });
    expect(none).toContain('没有代码为 000000 的研究日志');
  });
});

describe('get_source_health', () => {
  it('按问题优先排序，输出状态汇总与错误信息', async () => {
    repo.getSourceHealth.mockResolvedValue([
      { id: 'tushare', name: 'Tushare', tier: 1, status: 'ok', lastSuccessAt: '2026-11-17T08:00:00Z' },
      { id: 'csrc', name: '证监会', tier: 0, status: 'error', lastSuccessAt: '2026-11-16T08:00:00Z', message: '抓取失败：403' },
      { id: 'wind', name: 'Wind', tier: 2, status: 'inactive' },
      { id: 'demo', name: '示例源', tier: 3, status: 'stale', message: '>=2h 未更新' },
    ]);
    const text = await tool('get_source_health').execute({});
    expect(text).toContain('数据源 4 个：异常1 / 延迟1 / 未接入1 / 正常1');
    expect(text).toContain('[异常] 证监会（T0 官方）');
    expect(text).toContain('抓取失败：403');
    expect(text.indexOf('证监会')).toBeLessThan(text.indexOf('Tushare'));
  });

  it('空注册表明确说明', async () => {
    repo.getSourceHealth.mockResolvedValue([]);
    expect(await tool('get_source_health').execute({})).toContain('数据源注册表为空');
  });
});

describe('get_market_analytics', () => {
  beforeEach(() => {
    db.getAnalysisStats.mockReset();
    db.getIndustryTrend.mockReset();
    db.getCompanyHeatmap.mockReset();
    db.getSentimentBreakdown.mockReset();
  });

  it('all 视图输出概览、行业趋势、公司热力与情绪分布', async () => {
    db.getAnalysisStats.mockResolvedValue({ total_signals: 42, critical_count: 2, significant_count: 8, max_score: 5 });
    db.getIndustryTrend.mockResolvedValue([
      { time: '09:00', 半导体: 3, 政策: 1 },
      { time: '10:00', 半导体: 5, 政策: 2 },
    ]);
    db.getCompanyHeatmap.mockResolvedValue([{ company: '海光信息', signalCount: 4, avgScore: 4.5 }]);
    db.getSentimentBreakdown.mockResolvedValue([
      { category: 'industry', sentiment: 'positive', cnt: 6 },
      { category: 'industry', sentiment: 'negative', cnt: 2 },
    ]);

    const text = await tool('get_market_analytics').execute({});
    expect(text).toContain('信号 42 条｜5分 2｜4分 8｜最高分 5');
    expect(text).toContain('- 半导体：09:00 3 → 10:00 5');
    expect(text).toContain('海光信息：4条，平均分4.5');
    expect(text).toContain('利好 6 / 利空 2 / 中性 0 / 混合 0');
    expect(text).toContain('- 行业：利好6 利空2 中性0');
  });

  it('单视图只查对应数据，不查其余聚合', async () => {
    db.getAnalysisStats.mockResolvedValue({ total_signals: 5, critical_count: 0, significant_count: 1, max_score: 4 });
    const text = await tool('get_market_analytics').execute({ view: 'stats' });
    expect(text).toContain('信号 5 条');
    expect(text).not.toContain('行业趋势');
    expect(db.getIndustryTrend).not.toHaveBeenCalled();
    expect(db.getCompanyHeatmap).not.toHaveBeenCalled();
    expect(db.getSentimentBreakdown).not.toHaveBeenCalled();
  });

  it('未知视图明确返回可选值', async () => {
    const text = await tool('get_market_analytics').execute({ view: 'news' });
    expect(text).toContain('view 仅支持');
    expect(db.getAnalysisStats).not.toHaveBeenCalled();
  });

  it('空数据时逐项说明缺口', async () => {
    db.getAnalysisStats.mockResolvedValue({ total_signals: 0, critical_count: 0, significant_count: 0, max_score: 0 });
    db.getIndustryTrend.mockResolvedValue([]);
    db.getCompanyHeatmap.mockResolvedValue([]);
    db.getSentimentBreakdown.mockResolvedValue([]);
    const text = await tool('get_market_analytics').execute({});
    expect(text).toContain('信号 0 条');
    expect(text).toContain('行业趋势：该时间窗内没有数据');
    expect(text).toContain('公司热力：该时间窗内没有数据');
    expect(text).toContain('情绪分布：该时间窗内没有数据');
  });
});

describe('get_notifications', () => {
  const items = [
    { id: 'n1', kind: 'task', severity: 'warn', title: '任务失败：每日简报', body: 'Tushare 超时', deepLink: '/tasks', createdAt: '2026-11-17T08:05:00Z' },
    { id: 'n2', kind: 'task', severity: 'info', title: '行情补库完成', createdAt: '2026-11-17T07:00:00Z', readAt: '2026-11-17T07:30:00Z' },
  ];

  it('输出未读与已读状态', async () => {
    notifications.listNotifications.mockResolvedValue({ items, unread: 1 });
    const text = await tool('get_notifications').execute({});
    expect(text).toContain('未读 1 / 显示 2 条');
    expect(text).toContain('[warn] 任务失败：每日简报');
    expect(text).toContain('未读');
    expect(text).toContain('已读');
    expect(text).toContain('链接：/tasks');
  });

  it('unreadOnly 只返回未读', async () => {
    notifications.listNotifications.mockResolvedValue({ items, unread: 1 });
    const text = await tool('get_notifications').execute({ unreadOnly: true });
    expect(text).toContain('任务失败');
    expect(text).not.toContain('行情补库完成');
  });

  it('无通知时明确说明', async () => {
    notifications.listNotifications.mockResolvedValue({ items: [], unread: 0 });
    expect(await tool('get_notifications').execute({})).toContain('暂无站内通知');
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

  it('按 taskId 返回参数、结果与事件日志', async () => {
    tasks.getTask.mockResolvedValue({
      id: 't1', type: 'daily_brief', lane: 'core', status: 'failed', progress: 40,
      step: '拉取行情', params: { tradeDate: '2026-11-17' }, result: { docs: 3 },
      error: 'Tushare 超时', createdAt: '2026-11-17 08:00', startedAt: '2026-11-17 08:01',
      finishedAt: '2026-11-17 08:05', attempts: 2, costMicros: 12000,
    });
    tasks.getTaskEvents.mockResolvedValue([
      { seq: 1, type: 'started', payload: null, createdAt: '2026-11-17 08:01' },
      { seq: 2, type: 'step', payload: { step: '拉取行情' }, createdAt: '2026-11-17 08:03' },
    ]);
    const text = await tool('get_tasks').execute({ taskId: 't1' });
    expect(text).toContain('t1 daily_brief [失败] 40%');
    expect(text).toContain('参数：{"tradeDate":"2026-11-17"}');
    expect(text).toContain('结果：{"docs":3}');
    expect(text).toContain('错误：Tushare 超时');
    expect(text).toContain('#2 step');
    expect(text).toContain('"step":"拉取行情"');
  });

  it('taskId 不存在时明确说明', async () => {
    tasks.getTask.mockResolvedValue(null);
    expect(await tool('get_tasks').execute({ taskId: 'missing' })).toContain('任务 missing 不存在');
  });
});
