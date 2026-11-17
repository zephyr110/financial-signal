import { describe, it, expect, vi, beforeEach } from 'vitest';

const repo = vi.hoisted(() => ({
  getDeskSnapshot: vi.fn(),
  getDeskStatus: vi.fn(),
  listAlerts: vi.fn(),
  listJudgments: vi.fn(),
}));
const investigation = vi.hoisted(() => ({
  getInvestigation: vi.fn(),
  listInvestigations: vi.fn(),
}));
const db = vi.hoisted(() => ({
  searchSignals: vi.fn(),
  getEventThreads: vi.fn(),
  getEventThreadById: vi.fn(),
  getIndustryHeatmap: vi.fn(),
  getBacktestByIndustry: vi.fn(),
}));
const market = vi.hoisted(() => ({ getThreadMarketContext: vi.fn() }));

vi.mock('../desk/repo', () => repo);
vi.mock('../desk/investigation', () => investigation);
vi.mock('../db', () => db);
vi.mock('../market', () => market);
vi.mock('./cockpit-tools', () => ({ COCKPIT_TOOLS: [] }));
vi.mock('./actions', () => ({ proposeAgentAction: vi.fn() }));
vi.mock('./web-search', () => ({ searchWeb: vi.fn() }));

import { RESEARCH_TOOLS } from './tools';

const tool = (name: string) => RESEARCH_TOOLS.find((t) => t.name === name)!;

const judgment = {
  id: 'j1', tradeDate: '2026-11-17', kind: 'industry', industry: '半导体',
  stance: '看多', confidence: '中', score: 72, headline: '国产替代加速',
  summary: '订单与政策共振', drivers: ['大基金三期落地', '招标放量'], risks: ['估值偏高'],
  reviewAt: '2026-11-24T00:00:00Z', status: 'open', version: 2,
  evidence: [{ id: 'e1', kind: 'fact', label: '招标金额', value: '+30%', sourceName: '财联社', asOf: '2026-11-17' }],
  evaluations: [{ horizonDays: 1, evalDate: '2026-11-18', hit: true, returnPct: 1.2, benchmarkPct: 0.3 }],
  computedAt: '2026-11-17T08:00:00Z', isDemo: false, relation: 'holding',
};

const alert = {
  id: 'a1', tradeDate: '2026-11-17', severity: 'important', category: 'policy',
  industry: '半导体', symbolCode: '688041', title: '出口管制升级',
  summary: '先进制程设备受限', whyNow: '新规即日生效',
  evidence: [{ id: 'e1', kind: 'fact', label: '管制清单更新', sourceName: '商务部', asOf: '2026-11-17' }],
  judgmentId: 'j1', status: 'open', triggeredAt: '2026-11-17T09:00:00Z', isDemo: false,
};

describe('get_desk_snapshot', () => {
  beforeEach(() => {
    repo.getDeskSnapshot.mockReset();
    repo.getDeskStatus.mockReset();
  });

  it('输出快照时效、判断状态/关联/复核、外盘价格与行情时间', async () => {
    repo.getDeskSnapshot.mockResolvedValue({
      tradeDate: '2026-11-17', asOf: '2026-11-17T08:30:00Z',
      market: { ...judgment, id: 'm1', kind: 'market', industry: undefined, relation: undefined },
      industries: [judgment],
      alerts: [alert],
      overseas: [{ symbol: 'SOX', tradeTime: '2026-11-17T05:00:00Z', price: 5120.3, changePct: 1.8, sourceId: 's', delayMinutes: 15, fetchedAt: '' }],
      realtime: [{ code: '600519', name: '贵州茅台', price: 1500, changePct: -0.5, tradeTime: '2026-11-17T14:55:00Z', delaySeconds: 5, sourceId: 's', fetchedAt: '' }],
      dataQuality: [],
      isDemo: false, generatedAt: '2026-11-17T08:30:00Z',
    });
    repo.getDeskStatus.mockResolvedValue({
      tradeDate: '2026-11-17', hasSnapshot: true, stale: true, staleSeconds: 3600,
      openAlerts: 1, judgments: 2, industries: 1, lastComputedAt: '2026-11-17T07:30:00Z',
      sourceHealth: [], isDemo: false,
    });
    const text = await tool('get_desk_snapshot').execute({});
    expect(text).toContain('快照更新于 2026-11-17T08:30:00Z｜最后计算 2026-11-17T07:30:00Z（数据可能过期）');
    expect(text).toContain('- 半导体：看多/中 国产替代加速｜open｜关联 持仓｜复核 2026-11-24');
    expect(text).toContain('[important] 出口管制升级（半导体） 688041：先进制程设备受限');
    expect(text).toContain('- SOX 5120.3（+1.80%，延迟 15 分钟，2026-11-17T05:00:00Z）');
    expect(text).toContain('- 600519 贵州茅台 1500（-0.50%，延迟5秒，2026-11-17T14:55:00Z）');
  });
});

describe('get_judgments', () => {
  beforeEach(() => {
    repo.listJudgments.mockReset();
  });

  it('输出摘要、驱动/风险、状态、复核、证据与事后评估', async () => {
    repo.listJudgments.mockResolvedValue({ items: [judgment], total: 1 });
    const text = await tool('get_judgments').execute({ industry: '半导体', from: '2026-11-01', to: '2026-11-30' });
    expect(repo.listJudgments).toHaveBeenCalledWith({
      kind: undefined, industry: '半导体', from: '2026-11-01', to: '2026-11-30', limit: 10,
    });
    expect(text).toContain('#j1 [半导体] 国产替代加速');
    expect(text).toContain('看多/中｜评分 72｜状态 open｜交易日 2026-11-17｜关联 持仓');
    expect(text).toContain('摘要：订单与政策共振');
    expect(text).toContain('驱动：大基金三期落地；招标放量');
    expect(text).toContain('风险：估值偏高');
    expect(text).toContain('复核 2026-11-24｜证据 1 条｜版本 v2｜计算于 2026-11-17T08:00:00Z');
    expect(text).toContain('[事实] 招标金额（+30%）｜来源 财联社（2026-11-17）');
    expect(text).toContain('事后评估：T+1 命中 +1.20%（基准 +0.30%） 2026-11-18');
  });

  it('无匹配时明确说明', async () => {
    repo.listJudgments.mockResolvedValue({ items: [], total: 0 });
    expect(await tool('get_judgments').execute({})).toBe('没有匹配的判断。');
  });
});

describe('get_open_alerts', () => {
  beforeEach(() => {
    repo.listAlerts.mockReset();
  });

  it('输出摘要、标的、证据与关联判断', async () => {
    repo.listAlerts.mockResolvedValue([alert]);
    const text = await tool('get_open_alerts').execute({ severity: 'important' });
    expect(repo.listAlerts).toHaveBeenCalledWith({ status: 'open', severity: 'important', limit: 10 });
    expect(text).toContain('#a1 [important] 出口管制升级 688041（半导体）｜policy｜交易日 2026-11-17');
    expect(text).toContain('摘要：先进制程设备受限');
    expect(text).toContain('触发原因：新规即日生效');
    expect(text).toContain('触发于 2026-11-17T09:00:00Z｜证据 1 条｜关联判断 #j1');
    expect(text).toContain('- [事实] 管制清单更新｜来源 商务部（2026-11-17）');
  });
});

describe('get_investigation', () => {
  beforeEach(() => {
    investigation.getInvestigation.mockReset();
    investigation.listInvestigations.mockReset();
  });

  it('输出触发原因、进度、反馈与工具步骤，不暴露内部编号与用量', async () => {
    investigation.listInvestigations.mockResolvedValue([{
      id: 'inv1', alertId: 'a1', judgmentId: 'j1', status: 'succeeded',
      triggerReason: '重要预警自动深挖', question: '影响多大？', progress: 100,
      stepsUsed: 2, tokensUsed: 1234, costMicros: 12000, conclusion: '短期影响有限',
      confidence: '中', evidenceStrength: 'moderate', feedback: 'useful',
      createdAt: '2026-11-17T09:00:00Z', startedAt: '2026-11-17T09:00:05Z', finishedAt: '2026-11-17T09:02:00Z',
      steps: [
        { stepNo: 1, kind: 'tool', tool: 'search_news', digest: '检索到 3 条', refs: ['#1', '#2'], ok: true, durationMs: 120, tokens: 300, createdAt: '2026-11-17T09:00:10Z' },
        { stepNo: 2, kind: 'think', digest: '归纳证据', refs: [], ok: true, tokens: 100, createdAt: '2026-11-17T09:00:20Z' },
      ],
    }]);
    const text = await tool('get_investigation').execute({ alertId: 'a1' });
    expect(text).toContain('调查状态：succeeded｜进度 100%｜置信度 中｜证据强度 moderate');
    expect(text).toContain('触发原因：重要预警自动深挖');
    expect(text).not.toContain('inv1');
    expect(text).not.toContain('#a1');
    expect(text).not.toContain('tokens');
    expect(text).toContain('结论：短期影响有限');
    expect(text).toContain('用户反馈：有用');
    expect(text).toContain('- 第1步 [tool·search_news] 成功｜120ms\n  检索到 3 条');
    expect(text).toContain('- 第2步 [think] 成功\n  归纳证据');
  });
});

describe('watch_event', () => {
  beforeEach(() => {
    db.getEventThreadById.mockReset();
    market.getThreadMarketContext.mockReset();
  });

  it('输出信号 id、原文摘录、来源、相关板块与回测', async () => {
    db.getEventThreadById.mockResolvedValue({
      id: 7, title: '国产算力', stage: '发酵', confidence: '中', created_at: '2026-11-16T08:00:00Z',
      narrative: '订单持续落地', industries: ['半导体'], watch_points: ['订单持续性'],
      focus_stocks: null,
      signals: [{
        id: 1019, signal_score: 4, category: 'industry', summary: '海光信息获大单',
        published_at: '2026-11-16T10:00:00Z', content: '国产CPU需求上行', docurl: 'https://example.com/news', source: 'cls',
      }],
    });
    market.getThreadMarketContext.mockResolvedValue({
      market: [{ name: '半导体', change_pct: 2.3 }],
      backtest: [{ industry: '半导体', samples: 40, directional_count: 40, avg_d1: 0.5, avg_d3: 1.2, avg_d7: 2, win_rate: 60 }],
    });
    const text = await tool('watch_event').execute({ eventId: 7 });
    expect(text).toContain('事件线索 #7: 国产算力');
    expect(text).toContain('生成于 2026-11-16T08:00:00Z');
    expect(text).toContain('2026-11-16T10:00:00Z #1019 [4分/行业] 海光信息获大单');
    expect(text).toContain('摘录：国产CPU需求上行');
    expect(text).toContain('原文：https://example.com/news');
    expect(text).toContain('来源：财联社');
    expect(text).toContain('- 半导体（+2.30%）');
    expect(text).toContain('- 半导体：样本充足｜方向样本 40（总事件 40）');
  });
});
