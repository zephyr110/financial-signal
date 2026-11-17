/**
 * 研究 Agent — 驾驶舱面板数据工具。
 *
 * 与 tools.ts 的信号/事件/投研台工具互补：把今日简报、公告原文、自选、持仓、
 * 研究论点、个股详情、单条信号与任务状态接给模型，回答"我的仓位/我的简报"类问题。
 */
import type { ToolDefinition } from './types';
import { intArg } from './args';
import {
  getAnalysisStats,
  getCompanyHeatmap,
  getDb,
  getIndustryTrend,
  getRelatedSignals,
  getSentimentBreakdown,
  getSignalById,
} from '../db';
import {
  dateShanghai,
  formatCost,
  formatCny,
  formatPrice,
  formatSignedPct,
  formatTime,
  taskStatusLabel,
  thesisStatusLabel,
  tierLabel,
} from '../cockpit/format';
import { getJournal, getPortfolio, getSourceHealth, getStockDetail, getTheses, getTodayPayload, getWatchlist } from '../cockpit/repo';
import { listNotifications } from '../cockpit/notifications';
import { getTask, getTaskEvents, listTasks } from '../cockpit/tasks';
import { searchSourceDocuments } from '../search/fts';
import { CATEGORY_LABELS, SENTIMENT_LABELS } from '../constants';
import { aggregateSentimentRows } from '../sentiment';

/** 单次工具结果的行数上限，避免把整张表塞进上下文；截断时明确说明。 */
const MAX_ROWS = 20;

const JOURNAL_ACTION_LABELS: Record<string, string> = {
  watch: '继续观察',
  buy: '记录买入',
  sell: '记录卖出',
  hold: '继续持有',
  avoid: '选择回避',
  review: '复盘旧决定',
};

const HEALTH_LABELS: Record<string, string> = {
  ok: '正常',
  stale: '延迟',
  error: '异常',
  demo: '示例',
  inactive: '未接入',
};

const HEALTH_ORDER: Record<string, number> = { error: 0, stale: 1, demo: 2, inactive: 3, ok: 4 };

function pct(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? '—' : formatSignedPct(value);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

function dateOnly(value: unknown): string {
  return dateShanghai(value as string) || String(value ?? '').slice(0, 10);
}

export const COCKPIT_TOOLS: ToolDefinition[] = [
  {
    name: 'get_today_brief',
    description:
      '读取已发布的收盘简报（今日或指定交易日）：收盘判断与置信度、指数与涨跌广度、成交额、' +
      '对自选/持仓的影响、明日验证条件、政策公告与数据质量。用于回答"今天简报怎么说""明天要验证什么"类问题。',
    parameters: {
      type: 'object',
      properties: {
        tradeDate: { type: 'string', description: '交易日 YYYY-MM-DD，不填取最新已发布' },
      },
    },
    async execute(args) {
      const payload = await getTodayPayload(args.tradeDate ? String(args.tradeDate) : undefined);
      if (!payload) return '还没有已发布的收盘简报。可用 get_tasks 查看 daily_brief 任务状态。';

      const breadth = payload.breadth.limitUpDownAvailable === false
        ? `涨${payload.breadth.up} 平${payload.breadth.flat} 跌${payload.breadth.down}（涨跌停统计不可用）`
        : `涨${payload.breadth.up} 平${payload.breadth.flat} 跌${payload.breadth.down} 涨停${payload.breadth.limitUp} 跌停${payload.breadth.limitDown}`;
      const indices = payload.indices
        .map((i) => `${i.name} ${i.close.toFixed(2)}（${pct(i.changePct)}）`)
        .join('；');
      const impacts = payload.impacts.slice(0, 8).map((i) =>
        `- ${i.code} ${i.name}：${i.headline}${i.thesisStatus ? `（论点：${thesisStatusLabel(i.thesisStatus)}）` : ''}`,
      );
      const documents = payload.documents.slice(0, 8).map((d) =>
        `- #${d.id} ${dateOnly(d.publishedAt)} [${d.source.name}] ${d.title}${d.issuer ? `（${d.issuer}）` : ''}`,
      );
      const quality = payload.dataQuality
        .filter((q) => q.status !== 'ok')
        .map((q) => `- ${q.name}：${q.status}${q.message ? `，${q.message}` : ''}`);

      return [
        `交易日 ${payload.tradeDate}｜第 ${payload.issueNo} 期${payload.isDemo ? '（示例数据）' : ''}`,
        `收盘判断：${payload.hero.claim}（置信度 ${payload.hero.confidence.label}·${Math.round(payload.hero.confidence.score * 100)}）`,
        indices ? `指数：${indices}` : '',
        `涨跌广度：${breadth}`,
        `成交额：${formatCny(payload.turnover.value, true)}（${pct(payload.turnover.changePct)}）`,
        impacts.length ? `对你的影响：\n${impacts.join('\n')}` : '对你的影响：当前持仓与自选没有需要单独说明的变化',
        payload.tomorrow.length
          ? `明日验证：\n${payload.tomorrow.map((t, i) => `${i + 1}. ${t}`).join('\n')}`
          : '明日验证：无',
        documents.length
          ? `政策与公告（共${payload.documents.length}条，显示前${documents.length}条）：\n${documents.join('\n')}`
          : '政策与公告：无',
        quality.length ? `数据质量提示：\n${quality.join('\n')}` : '',
        payload.narrative?.text ? `模型叙述：${payload.narrative.text}` : '',
        '（引用时标注交易日；公告引用标注文档 id 与来源）',
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'search_documents',
    description:
      '全文检索已入库的官方公告与政策原文（source_documents），返回文档 id、发布日期、类型、标题、发布机构与原文链接。' +
      '用于回答"有没有相关政策/公告原文"类问题。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词（至少2字）' },
        days: { type: 'number', description: '回溯天数，默认90，最大730' },
        limit: { type: 'number', description: '返回条数，默认10，最大30' },
      },
      required: ['query'],
    },
    async execute(args) {
      const query = String(args.query || '').trim();
      if (query.length < 2) return 'query 至少 2 个字符。';
      const days = intArg(args.days, 90, 1, 730);
      const limit = intArg(args.limit, 10, 1, 30);
      const db = await getDb();
      const rows = await searchSourceDocuments(db, query, { days, limit });
      if (rows.length === 0) return `近${days}天没有检索到匹配的公告或政策文档。`;

      // 检索结果只有标题级字段；补类型/机构/链接，便于模型给出可核对的引用。
      const ids = rows.map((r) => r.id);
      const meta = new Map<string, Record<string, unknown>>();
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const res = await db.execute({
          sql: `SELECT id, doc_type, issuer, url FROM source_documents WHERE id IN (${placeholders})`,
          args: ids,
        });
        for (const row of res.rows as unknown as Record<string, unknown>[]) {
          meta.set(String(row.id), row);
        }
      }
      const lines = rows.map((r) => {
        const m = meta.get(String(r.id));
        const kind = m?.doc_type ? `[${m.doc_type}] ` : '';
        const issuer = m?.issuer ? `（${m.issuer}）` : '';
        const url = m?.url ? `\n  ${m.url}` : '';
        return `- #${r.id} ${dateOnly(r.published_at)} ${kind}${r.title}${issuer}${url}`;
      });
      return [
        `近${days}天匹配 ${rows.length} 条（显示前${rows.length}条）：`,
        ...lines,
        '（引用时标注文档 id 与发布日期）',
      ].join('\n');
    },
  },
  {
    name: 'get_watchlist',
    description:
      '读取用户自选股：代码、名称、最新价与涨跌幅、备注、研究论点状态与行情补库状态。' +
      '用于回答"我的自选表现如何""自选里有哪些标的"类问题。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const items = await getWatchlist();
      if (items.length === 0) return '自选为空。';
      const shown = items.slice(0, MAX_ROWS);
      return [
        `自选 ${items.length} 只${items.length > shown.length ? `（显示前${shown.length}只）` : ''}：`,
        ...shown.map((it) => {
          const note = it.note ? `｜备注：${it.note}` : '';
          const thesis = it.thesisStatus ? `｜论点：${thesisStatusLabel(it.thesisStatus)}` : '';
          const nextEvent = it.nextEvent ? `｜事件：${it.nextEvent}` : '';
          const backfill = it.backfill ? `｜行情补库：${it.backfill}` : '';
          return `- ${it.code} ${it.name}：${formatPrice(it.price)}（${pct(it.changePct)}）${note}${thesis}${nextEvent}${backfill}`;
        }),
      ].join('\n');
    },
  },
  {
    name: 'get_portfolio',
    description:
      '读取用户持仓与风险：总市值/盈亏、逐仓成本与权重、行业暴露、集中度与风险提示。' +
      '用于回答"我的持仓怎么样""哪些行业暴露高"类问题。金额为整数分，展示已格式化。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const portfolio = await getPortfolio();
      if (portfolio.positions.length === 0) return '当前没有持仓记录。';
      const shown = portfolio.positions.slice(0, MAX_ROWS);
      const exposure = portfolio.exposure
        .slice(0, 8)
        .map((e) => `${e.industry} ${e.weight.toFixed(1)}%`)
        .join('、');
      const risks = portfolio.risks.map((r) => `- [${r.level}] ${r.title}：${r.detail}`);
      return [
        `持仓 ${portfolio.positions.length} 只${portfolio.isDemo ? '（示例数据）' : ''}｜总市值 ${formatCny(portfolio.totalValue, true)}` +
          `｜总盈亏 ${formatCny(portfolio.totalPnl, true)}（${pct(portfolio.totalPnlPct)}）｜集中度 ${portfolio.concentration.toFixed(1)}%`,
        ...shown.map((p) =>
          `- ${p.code} ${p.name} ${p.shares}股｜现价 ${formatPrice(p.price)}｜成本 ${formatPrice(p.avgCost)}` +
          `｜市值 ${formatCny(p.marketValue, true)}｜盈亏 ${formatCny(p.pnl, true)}（${pct(p.pnlPct)}）` +
          `｜权重 ${p.weight.toFixed(1)}%｜${p.industry}`,
        ),
        exposure ? `行业暴露：${exposure}` : '',
        risks.length ? `风险提示：\n${risks.join('\n')}` : '',
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'get_theses',
    description:
      '读取研究论点台账：主张、期限、状态、置信度、失效条件、支撑/反驳证据数量与最近复评时间。' +
      '可按股票代码或状态过滤。用于回答"我的研究论点""某标的的论点是否失效"类问题。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '可选：股票代码精确匹配' },
        status: { type: 'string', description: '可选：active|strengthened|weakened|broken|review_due' },
        limit: { type: 'number', description: '返回条数，默认10，最大30' },
      },
    },
    async execute(args) {
      const all = await getTheses();
      const code = args.code ? String(args.code).trim() : '';
      const status = args.status ? String(args.status).trim() : '';
      const filtered = all.filter((t) => (!code || t.code === code) && (!status || t.status === status));
      if (filtered.length === 0) {
        return code || status ? '没有匹配的研究论点。' : '还没有建立研究论点。';
      }
      const limit = intArg(args.limit, 10, 1, 30);
      const shown = filtered.slice(0, limit);
      return [
        `研究论点 ${filtered.length} 条${filtered.length > shown.length ? `（显示前${shown.length}条）` : ''}：`,
        ...shown.map((t) =>
          `#${t.id} ${t.code} ${t.name}｜${t.title}\n` +
          `状态 ${thesisStatusLabel(t.status)}｜置信度 ${t.confidence}｜期限 ${t.horizon}｜` +
          `证据 支撑${t.supportCount}/反驳${t.opposeCount}${t.lastReviewedAt ? `｜复评 ${dateOnly(t.lastReviewedAt)}` : ''}\n` +
          `主张：${t.claim}\n失效条件：${t.invalidation.join('；') || '未设置'}`,
        ),
      ].join('\n');
    },
  },
  {
    name: 'get_stock_detail',
    description:
      '读取单个标的详情：名称/行业、最新价与涨跌幅、近60日日线、相关公告与现有研究论点。' +
      '用于回答"某只股票最近走势/公告/论点"类问题。',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: '股票代码，如 600519' } },
      required: ['code'],
    },
    async execute(args) {
      const code = String(args.code || '').trim();
      if (!code) return 'code 不能为空。';
      const detail = await getStockDetail(code);
      if (!detail) return `未找到标的 ${code}（可能尚未入库）。`;

      const closes = detail.bars.map((b) => b.close);
      const changeOver = (days: number): string => {
        if (closes.length <= days) return '—';
        const prev = closes[closes.length - 1 - days];
        const last = closes[closes.length - 1];
        return prev > 0 ? `${(((last - prev) / prev) * 100).toFixed(2)}%` : '—';
      };
      const first = detail.bars[0];
      const last = detail.bars[detail.bars.length - 1];
      const documents = detail.documents
        .slice(0, 5)
        .map((d) => `- ${dateOnly(d.publishedAt)} ${d.title}${d.issuer ? `（${d.issuer}）` : ''}`);
      const thesis = detail.thesis
        ? `研究论点：${detail.thesis.title}｜${thesisStatusLabel(detail.thesis.status)}｜${detail.thesis.claim}`
        : '研究论点：暂无';

      return [
        `${detail.code} ${detail.name}（${detail.exchange}/${detail.industry}）${detail.isDemo ? '（示例数据）' : ''}`,
        `现价 ${formatPrice(detail.price)}（${pct(detail.changePct)}）｜近5日 ${changeOver(5)}｜近20日 ${changeOver(20)}｜数据截至 ${detail.asOf || '—'}`,
        detail.bars.length > 0 ? `日线 ${detail.bars.length} 条：${first?.date} ~ ${last?.date}` : '日线：暂无',
        documents.length ? `相关公告：\n${documents.join('\n')}` : '相关公告：暂无',
        thesis,
      ].join('\n');
    },
  },
  {
    name: 'get_signal_detail',
    description:
      '读取单条信号的完整分析：评分、行业/公司、情绪、摘要、深度分析、所属事件线索与相关信号。' +
      'search_news 只返回摘要；需要深挖某条信号时用本工具。',
    parameters: {
      type: 'object',
      properties: { signalId: { type: 'number', description: '信号 id（来自 search_news）' } },
      required: ['signalId'],
    },
    async execute(args) {
      const id = Number(args.signalId);
      if (!Number.isFinite(id) || id <= 0) return 'signalId 必须是大于 0 的数字。';
      const signal = await getSignalById(id);
      if (!signal) return `信号 ${id} 不存在。`;

      const industries = (signal.industries || []).join('/') || '无';
      const companies = (signal.companies || []).join('/') || '无';
      const tags = (signal.tags || []).join('/');
      let related: Awaited<ReturnType<typeof getRelatedSignals>> = [];
      try {
        related = await getRelatedSignals(id, signal.industries || [], signal.companies || [], 5, 90);
      } catch {
        related = [];
      }
      const deep = signal.deep_analysis
        ? `深度分析：${clip(String(signal.deep_analysis), 1500)}`
        : signal.content
          ? `原文摘录：${clip(String(signal.content), 800)}`
          : '深度分析：暂无';

      return [
        `#${signal.id} ${signal.signal_score}分/${signal.category}/${signal.impact_level}/${signal.sentiment}｜${signal.published_at}｜${signal.source}`,
        `行业：${industries}｜公司：${companies}${tags ? `｜标签：${tags}` : ''}`,
        `摘要：${signal.summary}`,
        deep,
        signal.event_thread
          ? `事件线索：#${signal.event_thread.id} ${signal.event_thread.title}（${signal.event_thread.stage}/${signal.event_thread.confidence}）`
          : '',
        related.length > 0
          ? `相关信号：\n${related.map((r) => `- #${r.id} ${r.signal_score}分 ${r.summary}`).join('\n')}`
          : '',
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'get_journal',
    description:
      '读取研究日志（用户自己记录的决定、理由与复盘）：日期、动作、标的、理由、复盘备注。' +
      '可按股票代码过滤。用于回答"我之前怎么决定的""当时的理由/复盘是什么"类问题。',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '可选：股票代码精确匹配' },
        limit: { type: 'number', description: '返回条数，默认10，最大50' },
      },
    },
    async execute(args) {
      const limit = intArg(args.limit, 10, 1, 50);
      const code = args.code ? String(args.code).trim() : '';
      const all = await getJournal(100);
      const filtered = code ? all.filter((e) => e.code === code) : all;
      if (filtered.length === 0) {
        return code ? `没有代码为 ${code} 的研究日志。` : '还没有研究日志（只记录用户写下的决定，系统不代写）。';
      }
      const shown = filtered.slice(0, limit);
      return [
        `研究日志 ${filtered.length} 条${filtered.length > shown.length ? `（显示前${shown.length}条）` : ''}：`,
        ...shown.map((e) => {
          const action = JOURNAL_ACTION_LABELS[e.action] || e.action;
          const created = e.createdAt ? `｜录入 ${dateShanghai(e.createdAt)} ${formatTime(e.createdAt)}` : '';
          const outcome = e.outcomeNote ? `\n  复盘：${clip(e.outcomeNote, 300)}` : '';
          return `- ${e.entryDate} [${action}]${e.code ? ` ${e.code}` : ''}${created}\n  理由：${clip(e.reason, 500)}${outcome}`;
        }),
      ].join('\n');
    },
  },
  {
    name: 'get_source_health',
    description:
      '读取数据源注册表与实时健康状态：来源名称、层级、状态、最近成功时间与错误信息。' +
      '用于回答"数据源正常吗""为什么行情/公告没更新"类问题。',
    parameters: { type: 'object', properties: {} },
    async execute() {
      const sources = await getSourceHealth();
      if (sources.length === 0) return '数据源注册表为空。';
      const counts = new Map<string, number>();
      for (const source of sources) counts.set(source.status, (counts.get(source.status) || 0) + 1);
      const summary = [...counts.entries()]
        .sort((a, b) => (HEALTH_ORDER[a[0]] ?? 9) - (HEALTH_ORDER[b[0]] ?? 9))
        .map(([status, n]) => `${HEALTH_LABELS[status] || status}${n}`)
        .join(' / ');
      const sorted = [...sources].sort(
        (a, b) => (HEALTH_ORDER[a.status] ?? 9) - (HEALTH_ORDER[b.status] ?? 9),
      );
      return [
        `数据源 ${sources.length} 个：${summary}`,
        ...sorted.map((s) => {
          const last = s.lastSuccessAt ? `｜最近成功 ${dateShanghai(s.lastSuccessAt)} ${formatTime(s.lastSuccessAt)}` : '';
          const message = s.message ? `｜${s.message}` : '';
          return `- [${HEALTH_LABELS[s.status] || s.status}] ${s.name}（${tierLabel(s.tier)}）${last}${message}`;
        }),
      ].join('\n');
    },
  },
  {
    name: 'get_market_analytics',
    description:
      '读取信号分析看板的聚合数据：概览统计（信号数/高分数量）、行业趋势（按时段信号量）、公司热力（被提及最多的公司）、情绪分布（利好/利空/中性）。' +
      'view 可选 stats|industry_trend|company_heatmap|sentiment，默认 all；可按行业过滤。' +
      '用于回答"最近信号多吗""哪些行业在升温""哪些公司被频繁提及""情绪偏多还是偏空"类问题。',
    parameters: {
      type: 'object',
      properties: {
        view: { type: 'string', description: 'stats|industry_trend|company_heatmap|sentiment，默认 all' },
        hoursBack: { type: 'number', description: '回溯小时数，默认24，最大720' },
        industry: { type: 'string', description: '可选：行业名过滤' },
      },
    },
    async execute(args) {
      const view = String(args.view || 'all').trim();
      const allowed = ['stats', 'industry_trend', 'company_heatmap', 'sentiment'];
      if (view !== 'all' && !allowed.includes(view)) {
        return `view 仅支持 ${allowed.join('|')}（或 all）。`;
      }
      const hoursBack = intArg(args.hoursBack, 24, 1, 720);
      const industry = args.industry ? String(args.industry).trim() : '';
      const industries = industry ? [industry] : null;
      const wanted = view === 'all' ? allowed : [view];

      const [stats, trend, companies, sentimentRows] = await Promise.all([
        wanted.includes('stats') ? getAnalysisStats(hoursBack) : null,
        wanted.includes('industry_trend') ? getIndustryTrend(hoursBack, industries) : null,
        wanted.includes('company_heatmap') ? getCompanyHeatmap(hoursBack, industries) : null,
        wanted.includes('sentiment') ? getSentimentBreakdown(hoursBack, industries) : null,
      ]);

      const sections: string[] = [];
      const scope = industry ? `，行业=${industry}` : '';

      if (stats) {
        sections.push(
          `概览（近${hoursBack}h${scope}）：信号 ${Number(stats.total_signals) || 0} 条｜5分 ${Number(stats.critical_count) || 0}` +
            `｜4分 ${Number(stats.significant_count) || 0}｜最高分 ${Number(stats.max_score) || 0}`,
        );
      }

      if (trend) {
        if (trend.length === 0) {
          sections.push('行业趋势：该时间窗内没有数据。');
        } else {
          const totals = new Map<string, number>();
          for (const row of trend) {
            for (const [key, value] of Object.entries(row)) {
              if (key === 'time') continue;
              totals.set(key, (totals.get(key) || 0) + Number(value || 0));
            }
          }
          const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
          const buckets = trend.slice(-8);
          const lines = top.map(([name]) => {
            const series = buckets.map((row) => `${row.time} ${Number(row[name] || 0)}`).join(' → ');
            return `- ${name}：${series}`;
          });
          sections.push(
            `行业趋势（近${hoursBack}h${scope}，信号量前${lines.length}行业，最近${buckets.length}个时段）：\n${lines.join('\n')}`,
          );
        }
      }

      if (companies) {
        if (companies.length === 0) {
          sections.push('公司热力：该时间窗内没有数据。');
        } else {
          const lines = companies.map((c) => `- ${String(c.company)}：${c.signalCount}条，平均分${c.avgScore}`);
          sections.push(`公司热力（近${hoursBack}h${scope}，前${lines.length}）：\n${lines.join('\n')}`);
        }
      }

      if (sentimentRows) {
        const breakdown = aggregateSentimentRows(sentimentRows);
        if (breakdown.length === 0) {
          sections.push('情绪分布：该时间窗内没有数据。');
        } else {
          const totals = { positive: 0, negative: 0, neutral: 0, mixed: 0 };
          for (const row of breakdown) {
            totals.positive += row.positive;
            totals.negative += row.negative;
            totals.neutral += row.neutral;
            totals.mixed += row.mixed;
          }
          const overall = (['positive', 'negative', 'neutral', 'mixed'] as const)
            .map((key) => `${SENTIMENT_LABELS[key]} ${totals[key]}`)
            .join(' / ');
          const lines = breakdown.map((row) =>
            `- ${CATEGORY_LABELS[row.category] || row.category}：${SENTIMENT_LABELS.positive}${row.positive} ` +
            `${SENTIMENT_LABELS.negative}${row.negative} ${SENTIMENT_LABELS.neutral}${row.neutral}` +
            `${row.mixed ? ` ${SENTIMENT_LABELS.mixed}${row.mixed}` : ''}`,
          );
          sections.push(`情绪分布（近${hoursBack}h${scope}）：${overall}\n${lines.join('\n')}`);
        }
      }

      return sections.length > 0 ? sections.join('\n\n') : '没有可返回的分析数据。';
    },
  },
  {
    name: 'get_notifications',
    description:
      '读取站内通知（任务完成/失败、行情补库等）：严重级别、标题、正文、时间、已读状态与跳转链接。' +
      '用于回答"有什么提醒/通知""哪些还没看"类问题。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认10，最大50' },
        unreadOnly: { type: 'boolean', description: '只看未读，默认 false' },
      },
    },
    async execute(args) {
      const limit = intArg(args.limit, 10, 1, 50);
      const { items, unread } = await listNotifications(100);
      const filtered = args.unreadOnly === true ? items.filter((n) => !n.readAt) : items;
      if (filtered.length === 0) {
        return args.unreadOnly === true ? '没有未读通知。' : '暂无站内通知。';
      }
      const shown = filtered.slice(0, limit);
      return [
        `站内通知（未读 ${unread} / 显示 ${shown.length} 条）：`,
        ...shown.map((n) => {
          const body = n.body ? `\n  ${clip(n.body, 200)}` : '';
          const link = n.deepLink ? `\n  链接：${n.deepLink}` : '';
          return `- [${n.severity}] ${n.title}｜${dateShanghai(n.createdAt)} ${formatTime(n.createdAt)}｜${n.readAt ? '已读' : '未读'}${body}${link}`;
        }),
      ].join('\n');
    },
  },
  {
    name: 'get_tasks',
    description:
      '读取任务中心的最近任务：类型、状态、进度、当前步骤、失败原因与时间。' +
      '传 taskId 可读单个任务的参数、结果与最近事件日志。' +
      '用于回答"今日简报为什么没生成""任务跑到哪了"类问题。',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '可选：任务 id，读取单个任务详情与事件' },
        status: { type: 'string', description: '可选：queued|running|succeeded|failed|canceled' },
        limit: { type: 'number', description: '返回条数，默认10，最大30' },
      },
    },
    async execute(args) {
      const taskId = args.taskId ? String(args.taskId).trim() : '';
      if (taskId) {
        const task = await getTask(taskId);
        if (!task) return `任务 ${taskId} 不存在。`;
        const events = await getTaskEvents(taskId);
        const shownEvents = events.slice(-20);
        const span = task.finishedAt
          ? `${task.createdAt} ~ ${task.finishedAt}`
          : task.startedAt
            ? `${task.createdAt} ~ 进行中`
            : task.createdAt;
        const parameterText = clip(JSON.stringify(task.params ?? {}), 500);
        const resultText = task.result ? clip(JSON.stringify(task.result), 800) : '无';
        return [
          `${task.id} ${task.type} [${taskStatusLabel(task.status)}] ${Math.round(task.progress)}%｜${task.lane}｜尝试 ${task.attempts} 次｜成本 ${formatCost(task.costMicros)}｜${span}`,
          task.step ? `当前步骤：${task.step}` : '',
          `参数：${parameterText}`,
          `结果：${resultText}`,
          task.error ? `错误：${task.error}` : '',
          shownEvents.length > 0
            ? `最近事件（${shownEvents.length}/${events.length} 条）：\n${shownEvents.map((e) => {
                const payload = e.payload ? ` ${clip(JSON.stringify(e.payload), 200)}` : '';
                return `- #${e.seq} ${e.type} ${formatTime(e.createdAt)}${payload}`;
              }).join('\n')}`
            : '任务事件：无',
        ].filter(Boolean).join('\n');
      }

      const status = args.status ? String(args.status).trim() : '';
      const limit = intArg(args.limit, 10, 1, 30);
      const all = await listTasks(50);
      const filtered = status ? all.filter((t) => t.status === status) : all;
      if (filtered.length === 0) return status ? `没有状态为 ${status} 的任务。` : '任务中心暂无任务。';
      const shown = filtered.slice(0, limit);
      return [
        `最近任务 ${filtered.length} 条${filtered.length > shown.length ? `（显示前${shown.length}条）` : ''}：`,
        ...shown.map((t) => {
          const step = t.step ? `｜${t.step}` : '';
          const error = t.error ? `｜错误：${t.error}` : '';
          const span = t.finishedAt ? `${t.createdAt} ~ ${t.finishedAt}` : t.createdAt;
          return `- ${t.id} ${t.type} [${taskStatusLabel(t.status)}] ${Math.round(t.progress)}%${step}${error}｜${span}`;
        }),
      ].join('\n');
    },
  },
];
