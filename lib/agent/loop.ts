/**
 * 研究 Agent — ReactLoop 执行循环（spec §10.3 阶段 B）
 *
 * Mini-Agent 式循环 + "prompt 内 JSON 工具协议"：
 *   1. 用户消息入库，加载会话上下文（含自动压缩）
 *   2. 组装 messages → LLM
 *   3. 输出为 `{"tool":"<name>","args":{...}}` → 执行工具 → 结果回喂 → 回到 2
 *   4. 输出为纯文本 → 视为最终回答，入库并返回
 * 循环全程持久化（模型可见即记录，spec §10.2 原则2）。
 */
import { appendAgentMessage, createAgentSession, touchAgentSession, editAgentMessage, logEvent, agentSessionExists, EVENT_TYPES } from '../db';
import { chatCompletion } from '../llm/client';
import { getEffectiveLlmConfig } from '../llm/config';
import type { AgentTurnResult } from './types';
import { getTool, buildToolPrompt } from './tools';
import { loadAgentContext } from './session';
import { looksLikeJson, parseJsonLike, repairJson, formatFinalAnswer, stripToolProtocolFromAnswer, validateToolArgs } from './format';
import { getAgentMaxSteps, MAX_CORRECTION_STEPS } from './limits';

/** 工具结果文本长度上限（防止工具输出撑爆上下文） */
const TOOL_RESULT_MAX_CHARS = 3000;

const TRUNCATED_REPLY_PREFIX =
  '> 本轮工具调用较多，以下为基于已收集信息的总结。如需继续深入，请点击「继续分析」或追问。';

export const AGENT_SYSTEM_PROMPT = `你是一个A股政策-行业研究助手（信息准备层，不做投资顾问）。

你的任务：通过调用工具，回答用户关于财经信号、政策影响、行业趋势、事件发展的问题。

工具调用协议：
- 当需要信息时，输出严格JSON（不要输出其他文字）：{"tool":"<工具名>","args":{...}}
- 当信息足够时，输出最终回答（纯文本，可使用 markdown 列表）

使用准则：
- 优先用工具获取真实数据，不要凭记忆编造新闻、日期、行业数据
- 同一问题尽量合并检索（避免对相近关键词重复 search_news），信息足够后尽快给出结论
- 回答要引用数据来源（信号ID、事件线索ID、时间），说明判断依据
- 区分"已确认信号"与"推测"，标注置信度
- 可以给出趋势判断（早期/发酵/扩散/定价），但禁止给出买卖建议
- 若工具没有数据，明确说明数据缺口，不要编造`;

function parseToolCallCandidate(text: string): { tool?: string; args?: Record<string, unknown> } | null {
  const trimmed = (text || '').trim();
  const parsed = parseJsonLike(trimmed);
  if (parsed && typeof parsed === 'object' && typeof (parsed as { tool?: unknown }).tool === 'string') {
    const p = parsed as { tool: string; args?: unknown };
    return { tool: p.tool, args: p.args && typeof p.args === 'object' ? (p.args as Record<string, unknown>) : {} };
  }
  if (!looksLikeJson(trimmed)) return null;
  const repaired = repairJson(trimmed);
  if (repaired !== null && repaired !== trimmed) {
    try {
      const parsed = JSON.parse(repaired) as { tool?: unknown; args?: unknown };
      if (parsed && typeof parsed === 'object' && typeof parsed.tool === 'string') {
        return { tool: parsed.tool, args: parsed.args && typeof parsed.args === 'object' ? (parsed.args as Record<string, unknown>) : {} };
      }
    } catch {
      // 放弃
    }
  }
  return null;
}

export function tryParseToolCall(content: string): { tool?: string; args?: Record<string, unknown> } | null {
  const trimmed = (content || '').trim();
  const direct = parseToolCallCandidate(trimmed);
  if (direct?.tool) return direct;

  // 说明文字 + 独立末行工具 JSON（常见误输出；行内引用 JSON 仍不解析）
  const lines = trimmed.split('\n');
  if (lines.length > 1) {
    const lastLine = lines[lines.length - 1].trim();
    const tail = parseToolCallCandidate(lastLine);
    if (tail?.tool) return tail;
  }

  const fenceMatch = trimmed.match(/\n```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) {
    const tail = parseToolCallCandidate(`\`\`\`json\n${fenceMatch[1]}\n\`\`\``);
    if (tail?.tool) return tail;
  }

  return null;
}

export interface RunTurnOptions {
  sessionId?: number;
  userMessage: string;
  /** 编辑重发：替换该消息内容并删除其后全部消息，不再追加新用户消息 */
  editingId?: number;
  /** SSE 流式事件回调（tool_start / tool_end / delta / done） */
  onEvent?: (event: AgentTurnEvent) => void;
}

export type AgentTurnEvent =
  | { type: 'context_compact_start'; messageCount: number }
  | { type: 'context_compact_end'; messageCount: number; summary: string; failed?: boolean }
  | { type: 'tool_start'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_end'; tool: string; ok: boolean; summary: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; sessionId: number; reply: string; steps: number; toolLog: AgentTurnResult['toolLog']; truncated: boolean; userMessageId: number };

/**
 * 执行一轮研究对话：入库 → 循环 → 持久化。
 * 无 sessionId 时自动创建新会话。
 *
 * 流式：opts.onEvent 提供后，工具调用与最终回答的生成过程实时推送
 * （最终回答经 chatCompletion stream 逐字回调）。
 */
export async function runAgentTurn(input: RunTurnOptions): Promise<AgentTurnResult & { sessionId: number }> {
  const { apiKey } = await getEffectiveLlmConfig();
  if (!apiKey) {
    throw new Error(
      'LLM_API_KEY not configured. Set LLM_API_KEY (or DEEPSEEK_API_KEY) environment variable, or configure it in 设置 → 模型.'
    );
  }

  // 防御悬空 sessionId：浏览器 localStorage 可能缓存了已删除的会话。直接使用会在
  // 插入消息时触发外键约束错误（SQLITE_CONSTRAINT）→ 500。静默回退为新建会话，
  // 前端拿到新 sessionId 后自动续用，用户无感。
  let opts = input;
  if (opts.sessionId != null) {
    const exists = await agentSessionExists(opts.sessionId);
    if (!exists) {
      console.warn(`[agent] session ${opts.sessionId} not found, falling back to a new session`);
      opts = { ...opts, sessionId: undefined };
    }
  }

  const emit = opts.onEvent ?? (() => {});

  let sessionId: number;
  try {
    sessionId = opts.sessionId ?? (await createAgentSession(opts.userMessage.slice(0, 20)));
    // 编辑重发：替换既有用户消息并截断其后内容，供本轮重新生成回复
    let userMessageId: number;
    if (opts.editingId != null) {
      const ok = await editAgentMessage(sessionId, opts.editingId, opts.userMessage);
      if (!ok) {
        throw new Error('要编辑的消息不存在或不属于当前会话');
      }
      userMessageId = opts.editingId;
      await touchAgentSession(sessionId, opts.userMessage.slice(0, 20));
    } else {
      userMessageId = await appendAgentMessage(sessionId, 'user', opts.userMessage);
      if (opts.sessionId != null) {
        await touchAgentSession(sessionId, opts.userMessage.slice(0, 20));
      }
    }
    await logEvent(EVENT_TYPES.AGENT_QUERY, { entityId: sessionId, payload: { message: opts.userMessage.slice(0, 100) } });

    // history 已包含刚持久化的当前用户消息；压缩过程通过 onCompact 推送 SSE，完成后继续主循环
    const history = await loadAgentContext(sessionId, {
      onCompact: (e) => {
        if (e.type === 'start') emit({ type: 'context_compact_start', messageCount: e.messageCount });
        else if (e.type === 'end') {
          emit({
            type: 'context_compact_end',
            messageCount: e.messageCount,
            summary: e.summary,
            ...(e.failed ? { failed: true } : {}),
          });
        }
      },
    });
    const maxToolSteps = getAgentMaxSteps();
    const toolLog: AgentTurnResult['toolLog'] = [];
    const turnMessages: { role: 'user' | 'assistant'; content: string }[] = [];

    let toolSteps = 0;
    let corrections = 0;
    let llmCalls = 0;
    /** 工具步 + 纠错 + 触顶总结，硬顶防失控 */
    const maxLlmCalls = maxToolSteps + MAX_CORRECTION_STEPS + 2;
    let reply = '';

    while (llmCalls < maxLlmCalls) {
      llmCalls++;
      const messages = [
        { role: 'system', content: `${AGENT_SYSTEM_PROMPT}\n\n可用工具：\n${buildToolPrompt()}` },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        ...turnMessages,
      ];

      // 每步都流式：最终回答逐字推送；工具调用 JSON 在完整返回前不透出 delta，
      // 避免前端出现半截 {"tool":...} 文本
      let stepBuffer = '';
      const { content } = await chatCompletion({
        messages,
        maxTokens: 4096,
        stream: true,
        onDelta: (text: string) => {
          stepBuffer += text;
          if (looksLikeJson(stepBuffer.trim())) return;
          emit({ type: 'delta', text });
        },
      });

      const contentText = (content || '').trim();
      if (!contentText) {
        throw new Error('LLM 返回空内容，请重试');
      }

      const toolCall = tryParseToolCall(contentText);
      if (!toolCall?.tool) {
        // 工具调用形状但解析失败（截断/损坏的 JSON）→ 回喂模型重试，绝不让损坏的
        // JSON 落最终回答出口（否则用户直接看到原始截断文本，如 {"tool":...,"args":{"）
        if (looksLikeJson(contentText) && parseJsonLike(contentText) === null) {
          corrections++;
          if (corrections > MAX_CORRECTION_STEPS) break;
          const feedback = '【格式错误】你的输出是 JSON 形状但无法解析为合法工具调用（可能被截断）。请重新输出严格 JSON：{"tool":"<工具名>","args":{...}}；或改为输出纯文本最终回答。';
          turnMessages.push({ role: 'user', content: feedback });
          await appendAgentMessage(sessionId, 'system', feedback);
          continue;
        }
        // 最终回答：剥离误附的工具 JSON → 截断检测 → markdown 修复
        const formatted = formatFinalAnswer(stripToolProtocolFromAnswer(contentText));
        reply = formatted.text;
        await appendAgentMessage(sessionId, 'assistant', reply);
        await touchAgentSession(sessionId);
        emit({
          type: 'done',
          sessionId,
          reply,
          steps: llmCalls,
          toolLog,
          truncated: formatted.truncated,
          userMessageId,
        });
        return { sessionId, reply, steps: llmCalls, toolLog, truncated: formatted.truncated, userMessageId };
      }

      const tool = getTool(toolCall.tool);
      if (!tool) {
        corrections++;
        if (corrections > MAX_CORRECTION_STEPS) break;
        const feedback = `【工具不存在】工具 "${toolCall.tool}" 未注册。可用工具：${buildToolPrompt().split('\n').map((l) => l.split(':')[0]).join(', ')}。请重试。`;
        turnMessages.push({ role: 'user', content: feedback });
        await appendAgentMessage(sessionId, 'system', feedback);
        continue;
      }

      const argError = validateToolArgs(tool, toolCall.args || {});
      if (argError) {
        corrections++;
        if (corrections > MAX_CORRECTION_STEPS) break;
        const feedback = `【参数错误】工具 "${tool.name}" 参数无效：${argError}。请按参数 schema 重新构造：{"tool":"${tool.name}","args":{...}}。`;
        turnMessages.push({ role: 'user', content: feedback });
        await appendAgentMessage(sessionId, 'system', feedback);
        continue;
      }

      if (toolSteps >= maxToolSteps) break;

      emit({ type: 'tool_start', tool: tool.name, args: toolCall.args || {} });

      let resultText: string;
      let ok = true;
      try {
        resultText = await tool.execute(toolCall.args || {});
        if (resultText.length > TOOL_RESULT_MAX_CHARS) {
          resultText = resultText.slice(0, TOOL_RESULT_MAX_CHARS) + '\n…(结果过长已截断)';
        }
      } catch (err) {
        ok = false;
        resultText = `工具执行失败: ${(err as Error).message}`;
      }
      toolSteps++;
      const summary = resultText.split('\n')[0].slice(0, 100);
      toolLog.push({
        name: tool.name,
        args: toolCall.args || {},
        ok,
        summary,
      });
      emit({ type: 'tool_end', tool: tool.name, ok, summary });

      const meta = { toolCall: { name: tool.name, args: toolCall.args || {}, status: ok ? 'done' : 'error' } };
      await appendAgentMessage(sessionId, 'assistant', contentText, meta);
      await appendAgentMessage(sessionId, 'user', `【工具 ${tool.name} 结果】\n${resultText}`, { toolResult: { name: tool.name, ok, content: resultText.slice(0, 200) } });

      turnMessages.push({ role: 'assistant', content: contentText });
      turnMessages.push({ role: 'user', content: `【工具 ${tool.name} 结果】\n${resultText}` });
    }

    // 触顶：追加一次「仅总结、禁止再调工具」的 LLM 调用，避免只返回空提示
    llmCalls++;
    const synthMessages = [
      { role: 'system', content: `${AGENT_SYSTEM_PROMPT}\n\n可用工具：\n${buildToolPrompt()}` },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      ...turnMessages,
      {
        role: 'user',
        content:
          '【系统】单轮工具调用已达上限。请基于以上工具结果直接给出最终回答（纯文本 markdown，禁止再输出工具 JSON）。',
      },
    ];
    let synthBuffer = '';
    const { content: synthContent } = await chatCompletion({
      messages: synthMessages,
      maxTokens: 4096,
      stream: true,
      onDelta: (text: string) => {
        synthBuffer += text;
        if (looksLikeJson(synthBuffer.trim())) return;
        emit({ type: 'delta', text });
      },
    });
    const formatted = formatFinalAnswer(stripToolProtocolFromAnswer((synthContent || '').trim()));
    reply = formatted.text.trim()
      ? `${TRUNCATED_REPLY_PREFIX}\n\n${formatted.text}`
      : `已达到单轮工具调用上限（${maxToolSteps} 次工具调用），暂未生成总结。请点击「继续分析」或追问。`;
    await appendAgentMessage(sessionId, 'assistant', reply);
    await touchAgentSession(sessionId);
    emit({ type: 'done', sessionId, reply, steps: llmCalls, toolLog, truncated: true, userMessageId });
    return { sessionId, reply, steps: llmCalls, toolLog, truncated: true, userMessageId };
  } catch (err) {
    // 错误时携带已创建的 sessionId：客户端失败重试可续用同一会话，避免孤儿会话
    if (sessionId != null) (err as Error & { sessionId?: number }).sessionId = sessionId;
    throw err;
  }
}
