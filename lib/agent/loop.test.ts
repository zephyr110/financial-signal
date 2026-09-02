import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock 依赖：db 写入 + LLM 调用 ──

const db = vi.hoisted(() => ({
  appendAgentMessage: vi.fn().mockResolvedValue(undefined),
  createAgentSession: vi.fn().mockResolvedValue(1),
  touchAgentSession: vi.fn().mockResolvedValue(undefined),
  logEvent: vi.fn().mockResolvedValue(undefined),
  getAgentMessages: vi.fn().mockResolvedValue([]),
  // 工具依赖的只读查询也 mock 掉：测试不依赖真实 DB 状态（sweep#1）
  getBacktestByIndustry: vi.fn().mockResolvedValue([]),
  getEventThreadById: vi.fn().mockResolvedValue(null),
  EVENT_TYPES: {
    NEWS_INGESTED: 'news.ingested',
    SIGNAL_SCORED: 'signal.scored',
    ENTITY_MAPPED: 'entity.mapped',
    THREAD_LINKED: 'thread.linked',
    AGENT_QUERY: 'agent.query',
  },
}));

const llm = vi.hoisted(() => ({
  chatCompletion: vi.fn(),
}));

const llmConfig = vi.hoisted(() => ({
  getEffectiveLlmConfig: vi.fn().mockResolvedValue({
    apiKey: 'test-key',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
  }),
}));

// 保留真实 db 查询函数（tools 依赖），仅覆盖写入/副作用函数
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, ...db };
});
vi.mock('../llm/client', () => llm);
vi.mock('../llm/config', () => llmConfig);
vi.mock('./session', () => ({
  loadAgentContext: vi.fn().mockResolvedValue([]),
}));

import { tryParseToolCall, runAgentTurn } from './loop';

describe('tryParseToolCall', () => {
  it('解析纯 JSON 工具调用', () => {
    const result = tryParseToolCall('{"tool":"search_news","args":{"query":"存储"}}');
    expect(result).toEqual({ tool: 'search_news', args: { query: '存储' } });
  });

  it('解析 ```json 代码块包裹的工具调用', () => {
    const result = tryParseToolCall('```json\n{"tool":"get_event_threads","args":{}}\n```');
    expect(result?.tool).toBe('get_event_threads');
  });

  it('非 JSON 文本视为最终回答（返回 null）', () => {
    expect(tryParseToolCall('存储涨价链条目前处于发酵阶段。')).toBeNull();
  });

  it('JSON 但缺少 tool 字段返回 null', () => {
    expect(tryParseToolCall('{"foo":"bar"}')).toBeNull();
  });

  it('散文里引用工具调用 JSON 不解析（避免误执行）', () => {
    expect(tryParseToolCall('好的，模型输出了 {"tool":"search_news","args":{"query":"存储"}}，但显示异常。')).toBeNull();
  });

  it('说明文字 + 独立末行工具 JSON 可解析', () => {
    const r = tryParseToolCall(
      '让我换个方式，直接搜索存储涨价相关的新闻信号。\n{"tool":"search_news","args":{"query":"存储涨价","hoursBack":720}}'
    );
    expect(r?.tool).toBe('search_news');
    expect(r?.args).toMatchObject({ query: '存储涨价' });
  });

  it('截断的 JSON 工具调用被修复补全为合法调用', () => {
    const r = tryParseToolCall('{"tool":"get_industry_heatmap","args":{"');
    expect(r?.tool).toBe('get_industry_heatmap');
  });

  it('无法修复的 JSON 形状返回 null（交由格式错误回喂）', () => {
    expect(tryParseToolCall('{"tool":')).toBeNull();
  });
});

describe('runAgentTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.createAgentSession.mockResolvedValue(1);
  });

  it('工具调用 → 结果回喂 → 最终回答（2 步）', async () => {
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":"search_news","args":{"query":"存储"}}' })
      .mockResolvedValueOnce({ content: '存储行业近期有 5 条信号，平均分 4.2。' });

    const result = await runAgentTurn({ userMessage: '存储现在什么情况？' });

    expect(result.reply).toContain('存储行业');
    expect(result.steps).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe('search_news');
    expect(result.toolLog[0].ok).toBe(true);
    // 全程持久化（模型可见即记录）：user + 工具调用 + 工具结果 + 最终回答
    expect(db.appendAgentMessage).toHaveBeenCalledTimes(4);
    expect(db.logEvent).toHaveBeenCalled();
  });

  it('未知工具名 → 告知模型重试 → 模型给出最终回答', async () => {
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":"nonexistent","args":{}}' })
      .mockResolvedValueOnce({ content: '抱歉，我换个方式回答。' });

    const result = await runAgentTurn({ sessionId: 5, userMessage: '测试' });

    expect(result.steps).toBe(2);
    expect(result.reply).toContain('抱歉');
    // 工具不存在的反馈消息也持久化
    expect(db.appendAgentMessage.mock.calls.some((c) => c[2].includes('工具不存在'))).toBe(true);
  });

  it('参数前校验：缺必填参数 → 回喂模型重试', async () => {
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":"search_news","args":{}}' })
      .mockResolvedValueOnce({ content: '{"tool":"search_news","args":{"query":"存储"}}' })
      .mockResolvedValueOnce({ content: '存储行业近期有 5 条信号。' });

    const result = await runAgentTurn({ userMessage: '存储' });

    expect(result.steps).toBe(3);
    expect(result.toolLog).toHaveLength(1); // 只有第二次（合法）调用执行了工具
    expect(result.reply).toContain('存储行业');
    // 反馈以 system 角色持久化：历史重放渲染为居中提示，而非伪用户气泡
    expect(db.appendAgentMessage.mock.calls.some((c) => c[1] === 'system' && c[2].includes('参数错误'))).toBe(true);
  });

  it('截断/损坏的 JSON 工具调用 → 【格式错误】回喂重试 → 最终回答（用户不再看到原始截断 JSON）', async () => {
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":' })
      .mockResolvedValueOnce({ content: '{"tool":"search_news","args":{"query":"存储"}}' })
      .mockResolvedValueOnce({ content: '存储行业近期信号最强。' });

    const result = await runAgentTurn({ userMessage: '存储现在什么情况？' });

    expect(result.steps).toBe(3);
    expect(result.toolLog).toHaveLength(1);
    expect(result.reply).toBe('存储行业近期信号最强。');
    // 格式错误反馈以 system 角色持久化；截断 JSON 绝不以 assistant 落库
    expect(db.appendAgentMessage.mock.calls.some((c) => c[1] === 'system' && c[2].includes('格式错误'))).toBe(true);
    expect(db.appendAgentMessage.mock.calls.some((c) => c[2] === '{"tool":')).toBe(false);
  });

  it('散文引用工具 JSON 的回答不执行工具，直接作为最终回答', async () => {
    llm.chatCompletion.mockResolvedValueOnce({ content: '之前模型输出了 {"tool":"search_news","args":{"query":"存储"}}，但那是一次异常显示。' });

    const result = await runAgentTurn({ userMessage: '为什么显示 JSON' });

    expect(result.steps).toBe(1);
    expect(result.toolLog).toHaveLength(0);
    expect(result.reply).toContain('异常显示');
  });

  it('JSON 后校正：尾逗号等损坏 JSON 仍可解析为工具调用', async () => {
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":"search_news","args":{"query":"存储",}}' })
      .mockResolvedValueOnce({ content: '好的。' });

    const result = await runAgentTurn({ userMessage: '存储' });

    expect(result.toolLog).toHaveLength(1);
    expect(result.toolLog[0].name).toBe('search_news');
    expect(result.toolLog[0].ok).toBe(true);
    expect(result.reply).toBe('好的。');
  });

  it('回测无数据 → 返回提示文本，工具记为成功', async () => {
    // getBacktestByIndustry 已 mock（[]），不再依赖真实 DB 状态
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":"get_backtest","args":{"industry":"__不存在__"}}' })
      .mockResolvedValueOnce({ content: '好的。' });

    const result = await runAgentTurn({ userMessage: '回测' });
    expect(result.toolLog[0].ok).toBe(true);
    expect(result.toolLog[0].summary).toContain('暂无回测数据');
  });

  it('工具执行抛错 → ok=false 且模型仍可继续', async () => {
    db.getEventThreadById.mockRejectedValueOnce(new Error('db boom'));
    llm.chatCompletion
      .mockResolvedValueOnce({ content: '{"tool":"watch_event","args":{"eventId":1}}' })
      .mockResolvedValueOnce({ content: '好的。' });

    const result = await runAgentTurn({ userMessage: '看下事件1' });

    expect(result.toolLog[0].name).toBe('watch_event');
    expect(result.toolLog[0].ok).toBe(false);
    expect(result.toolLog[0].summary).toContain('db boom');
    expect(result.reply).toBe('好的。');
  });

  it('步数上限触发截断', async () => {
    llm.chatCompletion.mockResolvedValue({ content: '{"tool":"search_news","args":{"query":"循环"}}' });

    const result = await runAgentTurn({ userMessage: '一直调用工具' });

    expect(result.truncated).toBe(true);
    expect(result.steps).toBeLessThanOrEqual(8);
  });

  it('未配置 API key 时抛错', async () => {
    llmConfig.getEffectiveLlmConfig.mockResolvedValueOnce({
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
    });
    await expect(runAgentTurn({ userMessage: 'hi' })).rejects.toThrow('LLM_API_KEY');
  });
});
