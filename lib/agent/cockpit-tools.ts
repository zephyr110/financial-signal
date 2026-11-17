/**
 * 研究 Agent — 驾驶舱面板数据工具。
 *
 * 与 tools.ts 的信号/事件/投研台工具互补：把今日简报、公告原文、自选、持仓、
 * 研究论点、个股详情、单条信号与任务状态接给模型，回答"我的仓位/我的简报"类问题。
 */
import type { ToolDefinition } from './types';
import { intArg } from './args';
import { getDb, getRelatedSignals, getSignalById } from '../db';
import { dateShanghai, formatCny, formatPrice, formatSignedPct, taskStatusLabel, thesisStatusLabel } from '../cockpit/format';
import { getPortfolio, getStockDetail, getTheses, getTodayPayload, getWatchlist } from '../cockpit/repo';
import { searchSourceDocuments } from '../search/fts';
import { listTasks } from '../cockpit/tasks';

/** 单次工具结果的行数上限，避免把整张表塞进上下文；截断时明确说明。 */
const MAX_ROWS = 20;

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
          const backfill = it.backfill ? `｜行情补库：${it.backfill}` : '';
          return `- ${it.code} ${it.name}：${formatPrice(it.price)}（${pct(it.changePct)}）${note}${thesis}${backfill}`;
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
    name: 'get_tasks',
    description:
      '读取任务中心的最近任务：类型、状态、进度、当前步骤、失败原因与时间。' +
      '用于回答"今日简报为什么没生成""任务跑到哪了"类问题。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: '可选：queued|running|succeeded|failed|canceled' },
        limit: { type: 'number', description: '返回条数，默认10，最大30' },
      },
    },
    async execute(args) {
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
