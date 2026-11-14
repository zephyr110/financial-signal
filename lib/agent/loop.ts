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
import {
  appendAgentMessage,
  createAgentSession,
  touchAgentSession,
  editAgentMessage,
  logEvent,
  agentSessionExists,
  EVENT_TYPES,
  startAgentTurn,
  recordAgentTurnUsage,
  finishAgentTurn,
} from '../db';
import { chatCompletion } from '../llm/client';
import { getEffectiveLlmConfig, PRICING } from '../llm/config';
import type { AgentTurnResult } from './types';
import { getTool, buildToolPrompt } from './tools';
import { loadAgentContext, estimateContextTokens, loadAgentMemoryPrompt } from './session';
import { looksLikeJson, parseJsonLike, formatFinalAnswer, stripToolProtocolFromAnswer, validateToolArgs } from './format';
import { getAgentMaxSteps, MAX_CORRECTION_STEPS } from './limits';
import { AGENT_SYSTEM_PROMPT, buildAgentSystemPrompt } from './prompts';
import { acquireAgentSessionLock } from './lock';
import { findActionableTradeInstruction } from '../cockpit/validators';

export { AGENT_SYSTEM_PROMPT } from './prompts';

/** 工具结果文本长度上限（防止工具输出撑爆上下文） */
const TOOL_RESULT_MAX_CHARS = 3000;

const TRUNCATED_REPLY_PREFIX =
  '> 本轮工具调用较多，以下为基于已收集信息的总结。如需继续深入，请点击「继续分析」或追问。';

// prompt 正文在 ./prompts 的 registry 中，改措辞需递增版本。

import { tryParseToolCall } from './tool-call';
export { tryParseToolCall };

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
  | {
      type: 'done';
      sessionId: number;
      turnId: string | null;
      reply: string;
      steps: number;
      toolLog: AgentTurnResult['toolLog'];
      truncated: boolean;
      userMessageId: number;
      stats: AgentTurnStats;
    };

export interface AgentTurnStats {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costMicros: number;
  contextTokens: number;
  compacted: boolean;
}

function usageStats(usage: unknown): { prompt: number; completion: number; cached: number } {
  const u = (usage || {}) as Record<string, unknown>;
  const prompt = Number(u.prompt_tokens || 0);
  const completion = Number(u.completion_tokens || 0);
  const cached =
    Number((u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens || 0) ||
    Number(u.prompt_cache_hit_tokens || 0);
  return {
    prompt: Number.isFinite(prompt) ? prompt : 0,
    completion: Number.isFinite(completion) ? completion : 0,
    cached: Number.isFinite(cached) ? cached : 0,
  };
}

/**
 * 执行一轮研究对话：入库 → 循环 → 持久化。
 * 无 sessionId 时自动创建新会话。
 *
 * 流式：opts.onEvent 提供后，工具调用与最终回答的生成过程实时推送
 * （最终回答经 chatCompletion stream 逐字回调）。
 */
export async function runAgentTurn(
  input: RunTurnOptions,
): Promise<AgentTurnResult & { sessionId: number; turnId: string | null; stats: AgentTurnStats }> {
  const { apiKey, model: configuredModel } = await getEffectiveLlmConfig();
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
    const release = await acquireAgentSessionLock(sessionId);
    let turnId: string | null = null;
    let turnStatus: 'succeeded' | 'failed' = 'failed';
    let turnError: string | null = null;
    let model = configuredModel;
    let compacted = false;
    let contextTokens = 0;
    const stats: AgentTurnStats = {
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costMicros: 0,
      contextTokens: 0,
      compacted: false,
    };
    const maxToolSteps = getAgentMaxSteps();
    const toolLog: AgentTurnResult['toolLog'] = [];
    const turnMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    let toolSteps = 0;
    let corrections = 0;
    let llmCalls = 0;
    /** 工具步 + 纠错 + 触顶总结，硬顶防失控 */
    const maxLlmCalls = maxToolSteps + MAX_CORRECTION_STEPS + 2;
    let reply = '';

    const recordCall = async (result: { usage?: unknown; model?: string }, latencyMs: number) => {
      const u = usageStats(result.usage);
      model = result.model || model;
      stats.promptTokens += u.prompt;
      stats.completionTokens += u.completion;
      stats.cachedTokens += u.cached;
      stats.costMicros += u.prompt * PRICING.inputPerMillion + u.completion * PRICING.outputPerMillion;
      if (!turnId) return;
      await recordAgentTurnUsage({
        turnId,
        model,
        promptTokens: u.prompt,
        completionTokens: u.completion,
        costMicros: u.prompt * PRICING.inputPerMillion + u.completion * PRICING.outputPerMillion,
        latencyMs,
      }).catch((err) => console.warn('[agent] usage telemetry failed:', (err as Error).message));
    };

    const finishTurn = async () => {
      if (!turnId) return;
      stats.contextTokens = contextTokens;
      stats.compacted = compacted;
      await finishAgentTurn(turnId, {
        status: turnStatus,
        model,
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        cachedTokens: stats.cachedTokens,
        costMicros: stats.costMicros,
        contextTokens,
        compacted,
        toolCalls: toolLog.length,
        steps: llmCalls,
        errorMessage: turnError,
      }).catch((err) => console.warn('[agent] turn finalize failed:', (err as Error).message));
    };

    try {
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
    turnId = await startAgentTurn(sessionId, model).catch((err) => {
      console.warn('[agent] turn telemetry start failed:', (err as Error).message);
      return null;
    });

    // history 已包含刚持久化的当前用户消息；压缩过程通过 onCompact 推送 SSE，完成后继续主循环
    const history = await loadAgentContext(sessionId, {
      onCompact: (e) => {
        if (e.type === 'start') emit({ type: 'context_compact_start', messageCount: e.messageCount });
        else if (e.type === 'end') {
          if (!e.failed) compacted = true;
          emit({
            type: 'context_compact_end',
            messageCount: e.messageCount,
            summary: e.summary,
            ...(e.failed ? { failed: true } : {}),
          });
        }
      },
    });
    contextTokens = estimateContextTokens(history);
    const memoryPrompt = await loadAgentMemoryPrompt();
    const systemPrompt = buildAgentSystemPrompt(buildToolPrompt(), memoryPrompt);

    while (llmCalls < maxLlmCalls) {
      llmCalls++;
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        ...turnMessages,
      ];

      // 每步都流式：最终回答逐字推送；工具调用 JSON 在完整返回前不透出 delta，
      // 避免前端出现半截 {"tool":...} 文本
      let stepBuffer = '';
      const callStartedAt = Date.now();
      const llmResult = await chatCompletion({
        messages,
        maxTokens: 4096,
        stream: true,
        onDelta: (text: string) => {
          stepBuffer += text;
          if (looksLikeJson(stepBuffer.trim())) return;
          emit({ type: 'delta', text });
        },
      });
      await recordCall(llmResult, Date.now() - callStartedAt);
      const content = llmResult.content;

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
        // 硬交易指令仍拒绝；研究层面的“建议关注/等待验证”不拦。先给一次改写机会。
        const violatesTradePolicy = findActionableTradeInstruction(formatted.text);
        if (violatesTradePolicy && corrections < MAX_CORRECTION_STEPS) {
          corrections++;
          const feedback =
            '【合规】回答中出现了交易动作或仓位指令（如买入/卖出/加仓/目标价）。请改为研究层面表述：趋势阶段、关注方向、验证条件与风险，不要给交易动作。';
          turnMessages.push({ role: 'user', content: feedback });
          await appendAgentMessage(sessionId, 'system', feedback);
          continue;
        }
        reply = violatesTradePolicy
          ? '模型回答包含交易动作指令，已拦截。可以继续询问行业趋势、政策影响或风险验证条件。'
          : formatted.text;
        const truncated = violatesTradePolicy ? false : formatted.truncated;
        await appendAgentMessage(sessionId, 'assistant', reply, turnId ? { turnId } : undefined);
        await touchAgentSession(sessionId);
        turnStatus = 'succeeded';
        stats.contextTokens = contextTokens;
        stats.compacted = compacted;
        emit({
          type: 'done',
          sessionId,
          turnId,
          reply,
          steps: llmCalls,
          toolLog,
          truncated,
          userMessageId,
          stats,
        });
        return { sessionId, turnId, reply, steps: llmCalls, toolLog, truncated, userMessageId, stats };
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
        resultText = await tool.execute(toolCall.args || {}, { sessionId, turnId });
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
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      ...turnMessages,
      {
        role: 'user',
        content:
          '【系统】单轮工具调用已达上限。请基于以上工具结果直接给出最终回答（纯文本 markdown，禁止再输出工具 JSON）。',
      },
    ];
    let synthBuffer = '';
    const synthStartedAt = Date.now();
    const synthResult = await chatCompletion({
      messages: synthMessages,
      maxTokens: 4096,
      stream: true,
      onDelta: (text: string) => {
        synthBuffer += text;
        if (looksLikeJson(synthBuffer.trim())) return;
        emit({ type: 'delta', text });
      },
    });
    await recordCall(synthResult, Date.now() - synthStartedAt);
    const synthContent = synthResult.content;
    const formatted = formatFinalAnswer(stripToolProtocolFromAnswer((synthContent || '').trim()));
    reply = formatted.text.trim()
      ? `${TRUNCATED_REPLY_PREFIX}\n\n${formatted.text}`
      : `已达到单轮工具调用上限（${maxToolSteps} 次工具调用），暂未生成总结。请点击「继续分析」或追问。`;
    if (findActionableTradeInstruction(reply)) {
      reply = `已达到单轮工具调用上限（${maxToolSteps} 次工具调用）。模型总结包含交易动作指令，已拦截；请继续追问行业趋势或风险验证条件。`;
    }
    await appendAgentMessage(sessionId, 'assistant', reply, turnId ? { turnId } : undefined);
    await touchAgentSession(sessionId);
    turnStatus = 'succeeded';
    stats.contextTokens = contextTokens;
    stats.compacted = compacted;
    emit({ type: 'done', sessionId, turnId, reply, steps: llmCalls, toolLog, truncated: true, userMessageId, stats });
    return { sessionId, turnId, reply, steps: llmCalls, toolLog, truncated: true, userMessageId, stats };
    } catch (err) {
      turnStatus = 'failed';
      turnError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await finishTurn();
      release();
    }
  } catch (err) {
    // 错误时携带已创建的 sessionId：客户端失败重试可续用同一会话，避免孤儿会话
    if (sessionId != null) (err as Error & { sessionId?: number }).sessionId = sessionId;
    throw err;
  }
}
