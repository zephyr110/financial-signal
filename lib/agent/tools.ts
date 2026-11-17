/**
 * 研究 Agent — 领域工具集（spec §10.3 阶段 B）
 *
 * 把现有 3-step 管道（信号筛选/实体映射/事件串联）与 v2 数据层
 * 包装为模型可调用的工具。新增工具 = 在 TOOLS 数组追加一项。
 */
import type { ToolDefinition } from './types';
import { searchSignals, getEventThreads, getEventThreadById, getIndustryHeatmap, getBacktestByIndustry } from '../db';
import { fixMarkdown, repairJson, formatBacktestRows, formatEvidenceLines } from './format';
import { getDeskSnapshot, getDeskStatus, listAlerts, listJudgments } from '../desk/repo';
import { getInvestigation, listInvestigations } from '../desk/investigation';
import { getThreadMarketContext } from '../market';
import { CATEGORY_LABELS, sourceDisplayName } from '../constants';
import { formatCost } from '../cockpit/format';
import { proposeAgentAction, type AgentActionType } from './actions';
import { searchWeb } from './web-search';
import { COCKPIT_TOOLS } from './cockpit-tools';

/** 简洁化工具输出：限制文本长度，避免撑爆上下文 */
function summarizeList(rows, fields, limit = 10) {
  return rows.slice(0, limit).map((r) => fields.map((f) => r[f]).join(' | ')).join('\n');
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…（已截断）` : text;
}

function signedPct(value: unknown): string {
  const n = Number(value);
  return value == null || !Number.isFinite(n) ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

interface ThreadSignalRow {
  id: unknown;
  signal_score: unknown;
  category?: string;
  summary: unknown;
  published_at: unknown;
  content?: string;
  docurl?: string;
  source?: string;
}

interface SectorRow {
  name?: unknown;
  change_pct?: unknown;
}

/** 事件线索重点个股（数据层已按成员新闻情绪加权），无方向时明确说无。 */
function focusStocksLine(thread) {
  const names = (list) => (list || []).map((s) => s.name).join('、') || '无';
  const focus = thread?.focus_stocks;
  if (!focus) return '重点个股: 无';
  const watch = (focus.watch || []).length > 0 ? `；待观察 ${names(focus.watch)}` : '';
  return `重点个股: 看涨 ${names(focus.bullish)}；看跌 ${names(focus.bearish)}${watch}`;
}

import { numArg } from './args';
export { numArg };

export const RESEARCH_TOOLS: ToolDefinition[] = [
  {
    name: 'search_news',
    description:
      '按关键词检索已分析的信号（新闻），支持按时间范围与最低信号分过滤。' +
      '用于查找某行业/公司/主题的近期财经信号。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，如"存储""稀土""半导体"（至少2字）' },
        hoursBack: { type: 'number', description: '回溯小时数，默认720（30天），最大2160' },
        minScore: { type: 'number', description: '最低信号分1-5，默认1' },
        limit: { type: 'number', description: '返回条数，默认10，最大50' },
      },
      required: ['query'],
    },
    async execute(args) {
      const query = String(args.query || '').trim();
      if (query.length < 2) return 'query 至少 2 个字符。'; // 空查询直接提示，勿误导为"无结果"（C22）
      const result = await searchSignals({
        query,
        hoursBack: numArg(args.hoursBack, 720),
        minScore: numArg(args.minScore, 1),
        limit: numArg(args.limit, 10),
      });
      if (result.items.length === 0) return '未找到匹配信号。';
      return [
        `共 ${result.total} 条匹配，显示前 ${result.items.length} 条：`,
        summarizeList(
          result.items,
          ['id', 'signal_score', 'category', 'industries', 'summary', 'source', 'published_at'],
          10
        ),
        '（引用时请标注 signal id）',
      ].join('\n');
    },
  },
  {
    name: 'get_event_threads',
    description:
      '查询当前事件线索列表（多条新闻指向的同一趋势），含发展阶段与置信度。' +
      '用于回答"现在市场在关注什么主线"类问题。',
    parameters: {
      type: 'object',
      properties: {
        hoursBack: { type: 'number', description: '回溯小时数，默认24' },
      },
    },
    async execute(args) {
      const threads = await getEventThreads(numArg(args.hoursBack, 24));
      if (threads.length === 0) return '当前时间窗内没有事件线索。';
      return threads.map((t) =>
        `#${t.id} [${t.stage}] ${t.title}（置信度:${t.confidence}，涉及行业:${(t.industries || []).join('/')}，` +
        `关联信号:${(t.news_ids || []).length}条）\n${t.narrative}` +
        (t.watch_points?.length ? `\n关注点: ${t.watch_points.join('；')}` : '') +
        `\n${focusStocksLine(t)}`
      ).join('\n\n');
    },
  },
  {
    name: 'get_industry_heatmap',
    description:
      '查询行业信号热力图（各行业近期信号数量与平均分、情绪）。' +
      '用于回答"哪个行业近期信号最强"类问题；看时段趋势用 get_market_analytics。',
    parameters: {
      type: 'object',
      properties: {
        hoursBack: { type: 'number', description: '回溯小时数，默认24' },
      },
    },
    async execute(args) {
      const hoursBack = numArg(args.hoursBack, 24);
      const heatmap = await getIndustryHeatmap(hoursBack);
      if (heatmap.length === 0) return '该时间窗内没有行业信号数据。';
      const top = heatmap.slice(0, 12);
      const lines = top.map((h) =>
        `${h.industry}: ${h.signalCount}条信号 平均分${h.avgScore} 情绪${h.sentiment}`
      );
      return `行业信号热力图（近${hoursBack}h，前${top.length}名）：\n${lines.join('\n')}`;
    },
  },
  {
    name: 'get_backtest',
    description:
      '查询行业信号回测统计（信号出现后1/3/7日平均涨跌与方向命中率）。' +
      '命中率为方向口径：看多事件次日涨/看空事件次日跌计命中，分母仅计带方向(多/空)事件，中性/混合不计。' +
      '用于回答"某行业的信号历史上表现如何"类问题。',
    parameters: {
      type: 'object',
      properties: {
        industry: { type: 'string', description: '行业名（可选，如"半导体"），不填则返回全部' },
        daysBack: { type: 'number', description: '回溯天数，默认30' },
      },
    },
    async execute(args) {
      const rows = await getBacktestByIndustry(numArg(args.daysBack, 30));
      if (rows.length === 0) return '暂无回测数据（需要积累足够历史信号）。';
      const filtered = args.industry
        ? rows.filter((r) => (r.industry as string).includes(String(args.industry)))
        : rows;
      if (filtered.length === 0) return `没有找到行业"${args.industry}"的回测数据。`;
      return `行业信号回测统计（近${numArg(args.daysBack, 30)}天，命中率为方向口径，中性/混合不计入分母）：` +
        `\n${formatBacktestRows(filtered as unknown as Array<Record<string, unknown>>, 10)}`;
    },
  },
  {
    name: 'watch_event',
    description:
      '查询单个事件线索的完整详情：事件发展叙事、关联信号列表（id、时间线、原文摘录、来源与链接）、' +
      '后续关注点、相关板块涨跌与行业回测。用于回答"某事件现在到哪个阶段了""市场反应如何"类问题。',
    parameters: {
      type: 'object',
      properties: {
        eventId: { type: 'number', description: '事件线索ID（来自 get_event_threads）' },
      },
      required: ['eventId'],
    },
    async execute(args) {
      const id = Number(args.eventId);
      // Number('') = 0：空串也拦截，避免 0 被当作合法 id 查库（C22）
      if (!Number.isFinite(id) || id <= 0) return 'eventId 必须是大于 0 的数字。';
      const thread = await getEventThreadById(id);
      if (!thread) return `事件线索 ${id} 不存在（可能已过期，可用 get_event_threads 查看最新线索）。`;
      const context = await getThreadMarketContext((thread.industries || []) as string[])
        .catch(() => null);
      const signalLines = (thread.signals as ThreadSignalRow[]).map((s) => {
        const category = CATEGORY_LABELS[s.category as keyof typeof CATEGORY_LABELS] || s.category;
        const excerpt = s.content ? `\n  摘录：${clip(String(s.content), 240)}` : '';
        const docurl = s.docurl ? `\n  原文：${String(s.docurl)}` : '';
        const source = s.source ? `\n  来源：${sourceDisplayName(s.source)}` : '';
        return `${s.published_at} #${s.id} [${s.signal_score}分/${category}] ${s.summary}${excerpt}${docurl}${source}`;
      }).join('\n\n');
      const market = context?.market?.length
        ? `相关板块（最近交易日）：\n${(context.market as unknown as SectorRow[]).map((m) =>
            `- ${String(m.name)}（${signedPct(m.change_pct)}）`).join('\n')}`
        : '';
      const backtest = context?.backtest?.length
        ? `行业回测（近30天）：\n${formatBacktestRows(context.backtest as unknown as Array<Record<string, unknown>>, 8)}`
        : '';
      return [
        `事件线索 #${thread.id}: ${thread.title}`,
        `阶段: ${thread.stage} | 置信度: ${thread.confidence}｜生成于 ${thread.created_at}`,
        `叙事: ${thread.narrative}`,
        `涉及行业: ${(thread.industries || []).join('/') || '无'}`,
        `关注点: ${(thread.watch_points || []).join('；') || '无'}`,
        focusStocksLine(thread),
        market,
        backtest,
        `\n关联信号（${thread.signals.length}条）:\n${signalLines || '无'}`,
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'get_desk_snapshot',
    description:
      '读取投研台最新快照：市场判断、行业判断、未处理预警、A股实时行情、外盘行情与数据源质量。' +
      '用于回答"今天投研台怎么说""哪些行业/预警值得关注"类问题。',
    parameters: {
      type: 'object',
      properties: {
        tradeDate: { type: 'string', description: '交易日 YYYY-MM-DD，不填取最新' },
      },
    },
    async execute(args) {
      try {
        const [snapshot, status] = await Promise.all([
          getDeskSnapshot(args.tradeDate ? String(args.tradeDate) : undefined),
          getDeskStatus().catch(() => null),
        ])
        if (!snapshot.tradeDate) return '投研台还没有快照，请先在 /desk 触发刷新。'
        const judgmentMeta = (j: typeof snapshot.industries[number]): string => [
          j.status,
          j.relation ? `关联 ${j.relation === 'holding' ? '持仓' : '自选'}` : '',
          j.reviewAt ? `复核 ${String(j.reviewAt).slice(0, 10)}` : '',
        ].filter(Boolean).join('｜')
        const market = snapshot.market
          ? `市场判断：${snapshot.market.headline}（${snapshot.market.stance}/${snapshot.market.confidence}）｜${judgmentMeta(snapshot.market)}`
          : '市场判断：暂无'
        const industries = snapshot.industries.slice(0, 8).map((j) =>
          `- ${j.industry}：${j.stance}/${j.confidence} ${j.headline}｜${judgmentMeta(j)}`).join('\n')
        const alerts = snapshot.alerts.slice(0, 6).map((a) =>
          `- [${a.severity}] ${a.title}${a.industry ? `（${a.industry}）` : ''}${a.symbolCode ? ` ${a.symbolCode}` : ''}：${a.summary}`).join('\n')
        const realtime = snapshot.realtime.slice(0, 6).map((q) =>
          `- ${q.code}${q.name ? ` ${q.name}` : ''} ${q.price}（${signedPct(q.changePct)}，延迟${q.delaySeconds}秒，${q.tradeTime}）`).join('\n')
        const overseas = snapshot.overseas.map((q) =>
          `- ${q.symbol} ${q.price}（${signedPct(q.changePct)}，延迟 ${q.delayMinutes ?? '?'} 分钟，${q.tradeTime}）`).join('\n')
        const quality = snapshot.dataQuality
          .filter((q) => q.status !== 'ok')
          .map((q) => `- ${q.name}：${q.status}${q.message ? `，${q.message}` : ''}`).join('\n')
        const freshness = status
          ? `｜最后计算 ${status.lastComputedAt ?? '—'}${status.stale ? '（数据可能过期）' : ''}`
          : ''
        return [
          `交易日 ${snapshot.tradeDate}${snapshot.isDemo ? '（示例数据）' : ''}｜快照更新于 ${snapshot.asOf}${freshness}`,
          market,
          industries ? `行业判断：\n${industries}` : '行业判断：暂无',
          alerts ? `未处理预警：\n${alerts}` : '未处理预警：无',
          realtime ? `A股行情（延迟标注）：\n${realtime}` : '',
          overseas ? `外盘：\n${overseas}` : '',
          quality ? `数据质量提示：\n${quality}` : '',
        ].filter(Boolean).join('\n\n')
      } catch (err) {
        return `投研台快照不可用：${(err as Error).message}`
      }
    },
  },
  {
    name: 'get_open_alerts',
    description:
      '列出未处理预警（严重度、行业、摘要、为什么是现在、证据）。用于回答"现在有哪些风险提示"类问题。',
    parameters: {
      type: 'object',
      properties: {
        severity: { type: 'string', description: '可选：info/watch/important/critical' },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
    },
    async execute(args) {
      const severity = args.severity ? String(args.severity).trim() || undefined : undefined
      const limit = Math.max(1, Math.min(30, Math.floor(numArg(args.limit, 10))))
      // 先按 severity 在库里过滤再取条数，否则最新 30 条之外的同级预警会被误报为“没有”。
      const filtered = await listAlerts({ status: 'open', severity, limit })
      if (!filtered.length) return '当前没有未处理预警。'
      return filtered.map((a) => [
        `#${a.id} [${a.severity}] ${a.title}${a.symbolCode ? ` ${a.symbolCode}` : ''}${a.industry ? `（${a.industry}）` : ''}｜${a.category}｜交易日 ${a.tradeDate}${a.isDemo ? '｜示例数据' : ''}`,
        `摘要：${a.summary}`,
        `触发原因：${a.whyNow}`,
        `触发于 ${a.triggeredAt}｜证据 ${a.evidence.length} 条${a.judgmentId ? `｜关联判断 #${a.judgmentId}` : ''}`,
        formatEvidenceLines(a.evidence, 3),
      ].filter(Boolean).join('\n')).join('\n\n')
    },
  },
  {
    name: 'get_judgments',
    description:
      '查询投研台判断台账（市场/行业判断、方向、置信度、评分、状态、驱动/风险、复核时间与评估结果）。用于回答"哪些行业被看多/看空"类问题。',
    parameters: {
      type: 'object',
      properties: {
        industry: { type: 'string', description: '可选行业名' },
        kind: { type: 'string', description: 'market 或 industry' },
        from: { type: 'string', description: '可选起始交易日 YYYY-MM-DD' },
        to: { type: 'string', description: '可选结束交易日 YYYY-MM-DD' },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
    },
    async execute(args) {
      const kind = args.kind === 'market' || args.kind === 'industry' ? args.kind : undefined
      const result = await listJudgments({
        kind,
        industry: args.industry ? String(args.industry) : undefined,
        from: args.from ? String(args.from) : undefined,
        to: args.to ? String(args.to) : undefined,
        limit: numArg(args.limit, 10),
      })
      if (!result.items.length) return '没有匹配的判断。'
      return result.items.map((j) => {
        const relation = j.relation ? `｜关联 ${j.relation === 'holding' ? '持仓' : '自选'}` : ''
        const evaluations = j.evaluations.slice(-3).map((e) => {
          const ret = e.returnPct == null ? '—' : signedPct(e.returnPct)
          const bench = e.benchmarkPct == null ? '' : `（基准 ${signedPct(e.benchmarkPct)}）`
          return `T+${e.horizonDays} ${e.hit ? '命中' : '未中'} ${ret}${bench} ${e.evalDate}`
        })
        return [
          `#${j.id} [${j.kind === 'market' ? '市场' : j.industry}] ${j.headline}`,
          `${j.stance}/${j.confidence}｜评分 ${j.score}｜状态 ${j.status}｜交易日 ${j.tradeDate}${relation}${j.isDemo ? '｜示例数据' : ''}`,
          `摘要：${j.summary}`,
          j.drivers.length ? `驱动：${j.drivers.join('；')}` : '',
          j.risks.length ? `风险：${j.risks.join('；')}` : '',
          `复核 ${j.reviewAt ? String(j.reviewAt).slice(0, 10) : '未设置'}｜证据 ${j.evidence.length} 条｜版本 v${j.version}｜计算于 ${j.computedAt}`,
          formatEvidenceLines(j.evidence, 3),
          evaluations.length ? `事后评估：${evaluations.join('；')}` : '事后评估：暂无',
        ].filter(Boolean).join('\n')
      }).join('\n\n')
    },
  },
  {
    name: 'get_investigation',
    description:
      '读取预警深挖的调查结论、置信度、证据强度、触发原因、进度与工具步骤；可按调查 id 或预警 id 查询。',
    parameters: {
      type: 'object',
      properties: {
        investigationId: { type: 'string', description: '调查 id' },
        alertId: { type: 'string', description: '预警 id，取其最近一次调查' },
      },
    },
    async execute(args) {
      let investigation = args.investigationId
        ? await getInvestigation(String(args.investigationId))
        : null
      if (!investigation && args.alertId) {
        const items = await listInvestigations({ alertId: String(args.alertId), limit: 1 })
        investigation = items[0] || null
      }
      if (!investigation) return '没有找到该预警的深挖调查。'
      const steps = investigation.steps.slice(0, 15).map((s) =>
        `- 第${s.stepNo}步 [${s.kind}${s.tool ? `·${s.tool}` : ''}] ${s.ok ? '成功' : '失败'}` +
        `${s.durationMs != null ? `｜${s.durationMs}ms` : ''}｜${s.tokens} tokens\n  ${clip(s.digest, 200)}` +
        `${s.refs.length ? `\n  引用：${s.refs.slice(0, 6).join('、')}` : ''}`)
      return [
        `调查 ${investigation.id}｜${investigation.status}｜进度 ${investigation.progress}%｜置信度 ${investigation.confidence || '—'}｜证据强度 ${investigation.evidenceStrength || '—'}`,
        `触发原因：${investigation.triggerReason}${investigation.alertId ? `｜预警 #${investigation.alertId}` : ''}${investigation.judgmentId ? `｜判断 #${investigation.judgmentId}` : ''}`,
        `问题：${investigation.question}`,
        `消耗：${investigation.stepsUsed} 步｜${investigation.tokensUsed} tokens｜${formatCost(investigation.costMicros)}`,
        `创建 ${investigation.createdAt}${investigation.startedAt ? `｜开始 ${investigation.startedAt}` : ''}${investigation.finishedAt ? `｜完成 ${investigation.finishedAt}` : ''}`,
        investigation.conclusion ? `结论：${investigation.conclusion}` : investigation.errorMessage ? `失败原因：${investigation.errorMessage}` : '尚未生成结论。',
        investigation.feedback
          ? `用户反馈：${{ useful: '有用', wrong: '结论有误', incomplete: '信息不完整' }[investigation.feedback]}`
          : '',
        steps.length ? `工具步骤（${investigation.steps.length} 条，最多列 15 条）：\n${steps.join('\n')}` : '',
      ].filter(Boolean).join('\n\n')
    },
  },
  // 驾驶舱面板数据（今日简报/自选/持仓/论点/个股/公告/任务）
  ...COCKPIT_TOOLS,
  {
    name: 'propose_action',
    description:
      '提交一个需要用户确认的安全动作提案（关注事件/创建任务/加入研究项目/保存记忆）。' +
      '工具只创建提案，不会执行；必须在回答中明确告诉用户"待确认"，不得声称已完成。',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'watch_event | create_task | pin_project | save_memory' },
        payload: { type: 'object', description: '动作参数，按动作类型填写' },
      },
      required: ['type', 'payload'],
    },
    async execute(args, context) {
      try {
        const action = await proposeAgentAction({
          type: String(args.type || '') as AgentActionType,
          payload: args.payload && typeof args.payload === 'object' ? args.payload as Record<string, unknown> : {},
          sessionId: context?.sessionId == null ? null : String(context.sessionId),
          turnId: context?.turnId ?? null,
          userId: context?.userId ?? null,
        })
        return `已创建待确认动作 ${action.id}（${action.type}，状态 proposed）。请提示用户在界面确认后才会执行。`
      } catch (err) {
        return `动作提案被拒绝：${(err as Error).message}`
      }
    },
  },
  {
    name: 'format_markdown',
    description:
      '把草稿文本整理为规范的 Markdown（修复未闭合代码块围栏、多余空行、行尾空白等语法问题）。' +
      '在最终回答较长、包含代码块或表格时，先调用本工具整理草稿，再把整理结果作为最终回答输出。',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '需要整理的原始草稿文本' } },
      required: ['text'],
    },
    async execute(args) {
      return fixMarkdown(String(args.text ?? ''));
    },
  },
  {
    name: 'fix_json',
    description:
      '修复一段损坏或截断的 JSON 字符串（尾逗号、单引号、未加引号的键、括号未闭合等），返回修复后的 JSON。' +
      '用于处理从外部拿到的、无法直接解析的 JSON 数据。无法修复时返回明确错误提示。',
    parameters: {
      type: 'object',
      properties: { json: { type: 'string', description: '损坏的 JSON 文本' } },
      required: ['json'],
    },
    async execute(args) {
      const fixed = repairJson(String(args.json ?? ''));
      return fixed ?? '无法修复该 JSON，请检查内容或向用户索取完整数据。';
    },
  },
];

/**
 * 联网搜索按轮次开关：只有用户在本轮打开「联网」时才注入，避免默认消耗
 * 外部搜索额度，也避免模型在本地信号足够时滥用。
 */
export const WEB_SEARCH_TOOL: ToolDefinition = {
  name: 'web_search',
  description:
    '联网搜索最新的财经新闻、股市行情与政策信息（第三方网页）。' +
    '用于本地信号库尚未覆盖的最新消息；结果需注明来源链接，并区分联网信息与本地信号。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索词，如"央行 降准 最新消息"（至少2字）' },
      freshness: {
        type: 'string',
        description: '时间范围：oneDay | oneWeek | oneMonth | noLimit，默认 oneWeek',
      },
      count: { type: 'number', description: '返回条数，默认 8，最大 10' },
    },
    required: ['query'],
  },
  async execute(args) {
    return searchWeb(String(args.query || ''), {
      freshness: args.freshness as never,
      count: args.count as number,
    });
  },
};

export interface ToolScope {
  /** 本轮是否允许联网搜索 */
  webSearch?: boolean;
}

const toolMap = new Map(RESEARCH_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string, scope: ToolScope = {}): ToolDefinition | undefined {
  if (name === WEB_SEARCH_TOOL.name) return scope.webSearch ? WEB_SEARCH_TOOL : undefined;
  return toolMap.get(name);
}

/** 生成工具清单文本，注入 system prompt */
export function buildToolPrompt(scope: ToolScope = {}): string {
  const tools = scope.webSearch ? [...RESEARCH_TOOLS, WEB_SEARCH_TOOL] : RESEARCH_TOOLS;
  return tools.map((t) =>
    `- ${t.name}: ${t.description}\n  参数: ${JSON.stringify(t.parameters.properties || {})}`
  ).join('\n');
}
