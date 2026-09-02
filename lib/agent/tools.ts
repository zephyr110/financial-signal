/**
 * 研究 Agent — 领域工具集（spec §10.3 阶段 B）
 *
 * 把现有 3-step 管道（信号筛选/实体映射/事件串联）与 v2 数据层
 * 包装为模型可调用的工具。新增工具 = 在 TOOLS 数组追加一项。
 */
import type { ToolDefinition } from './types';
import { searchSignals, getEventThreads, getEventThreadById, getIndustryHeatmap, getIndustryTrend, getBacktestByIndustry } from '../db';
import { fixMarkdown, repairJson } from './format';

/** 简洁化工具输出：限制文本长度，避免撑爆上下文 */
function summarizeList(rows, fields, limit = 10) {
  return rows.slice(0, limit).map((r) => fields.map((f) => r[f]).join(' | ')).join('\n');
}

/** 数字参数安全转换：undefined/null/空串 → 默认值；NaN → 默认值；合法数字原样返回。
 *  不用 `Number(x) || fallback`——`Number("0")` 为 0（falsy）会被误吞为默认值。 */
export function numArg(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

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
          ['id', 'signal_score', 'category', 'industries', 'summary', 'published_at'],
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
        (t.watch_points?.length ? `\n关注点: ${t.watch_points.join('；')}` : '')
      ).join('\n\n');
    },
  },
  {
    name: 'get_industry_heatmap',
    description:
      '查询行业信号热力图（各行业近期信号数量与平均分、情绪）及时间趋势。' +
      '用于回答"哪个行业近期信号最强"类问题。',
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
      const lines = filtered.slice(0, 10).map((r) =>
        `${r.industry}: ${r.samples}次样本 1日${r.avg_d1}% 3日${r.avg_d3}% 7日${r.avg_d7}% 命中率${r.win_rate == null ? '—' : `${r.win_rate}%`}（方向口径,${r.directional_count ?? 0}个多/空事件计入分母）`
      );
      return `行业信号回测统计（近${numArg(args.daysBack, 30)}天）：\n${lines.join('\n')}`;
    },
  },
  {
    name: 'watch_event',
    description:
      '查询单个事件线索的完整详情：事件发展叙事、关联信号列表（含时间线与内容）、后续关注点。' +
      '用于回答"某事件现在到哪个阶段了"类问题。',
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
      const signalLines = thread.signals.map((s) =>
        `${s.published_at} [${s.signal_score}分/${s.category}] ${s.summary}`
      ).join('\n');
      return [
        `事件线索 #${thread.id}: ${thread.title}`,
        `阶段: ${thread.stage} | 置信度: ${thread.confidence}`,
        `叙事: ${thread.narrative}`,
        `涉及行业: ${(thread.industries || []).join('/') || '无'}`,
        `关注点: ${(thread.watch_points || []).join('；') || '无'}`,
        `\n关联信号（${thread.signals.length}条）:\n${signalLines || '无'}`,
      ].join('\n');
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

const toolMap = new Map(RESEARCH_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): ToolDefinition | undefined {
  return toolMap.get(name);
}

/** 生成工具清单文本，注入 system prompt */
export function buildToolPrompt(): string {
  return RESEARCH_TOOLS.map((t) =>
    `- ${t.name}: ${t.description}\n  参数: ${JSON.stringify(t.parameters.properties || {})}`
  ).join('\n');
}
