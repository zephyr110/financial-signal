/**
 * 研究 Agent — 会话上下文管理（spec §10.3 阶段 B）
 *
 *  - Session Note 式持久记忆：历史消息存 SQLite（agent_message 表），跨会话保留
 *  - 上下文自动压缩：消息总量超过预算时，把最旧消息用 LLM 压成一条 system 摘要，
 *    保留最近消息完整（Mini-Agent 式 token 控制）
 */
import { getAgentMessages, compactAgentMessages } from '../db';
import { chatCompletion } from '../llm/client';
import { LLM_CONFIG } from '../llm/config';
import type { AgentMessage } from './types';

/** 上下文 token 软预算（超出后触发压缩） */
const CONTEXT_BUDGET_TOKENS = 12000;
/** 压缩时保留的最近完整消息数 */
const KEEP_RECENT_MESSAGES = 8;
/** 压缩摘要的 LLM 调用最大输出 */
const SUMMARY_MAX_TOKENS = 800;

/**
 * 粗略 token 估算：中文约 1 token/字 的 2/3，英文约 1 token/4 字符。
 * 取保守值 1 token ≈ 1.5 字符，保证不超预算。
 */
function estimateTokens(messages: AgentMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 1.5);
}

const SUMMARIZE_PROMPT = `你是一个财经研究助手的上下文压缩器。请把用户与助手的历史对话压缩成一段中文摘要（200字以内），
保留：用户关心的问题、助手给出的关键结论、引用过的数据（行业、公司、事件线索ID、时间），
不要遗漏尚未解决的问题。只输出摘要本身，不要任何前缀。`;

async function summarizeMessages(messages: AgentMessage[]): Promise<string> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content.slice(0, 300)}`)
    .join('\n');
  const { content } = await chatCompletion({
    systemPrompt: SUMMARIZE_PROMPT,
    userMessage: `历史对话：\n${transcript}`,
    maxTokens: SUMMARY_MAX_TOKENS,
  });
  return content.slice(0, 500);
}

/**
 * 加载会话上下文（含自动压缩）。
 * 返回可直接拼入 messages 数组的历史消息列表。
 * 压缩为异步副作用：超预算时先返回"待压缩"标记，由调用方决定是否等待压缩结果。
 * 简化策略：同步等待压缩（研究场景可接受一次 LLM 延迟）。
 */
export async function loadAgentContext(sessionId: number): Promise<AgentMessage[]> {
  const rows = await getAgentMessages(sessionId);
  const messages: AgentMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    ...(r.meta?.toolCall ? { toolCall: r.meta.toolCall } : {}),
    ...(r.meta?.toolResult ? { toolResult: r.meta.toolResult } : {}),
  }));

  if (estimateTokens(messages) <= CONTEXT_BUDGET_TOKENS) return messages;

  const keep = messages.slice(-KEEP_RECENT_MESSAGES);
  const toSummarize = messages.slice(0, -KEEP_RECENT_MESSAGES);
  if (toSummarize.length === 0) return messages; // 消息不足 KEEP_RECENT 条，无需压缩
  console.log(`[agent] Context ${messages.length} msgs exceeds budget — summarizing ${toSummarize.length} old messages.`);

  try {
    const summary = await summarizeMessages(toSummarize);
    const summaryContent = `（历史对话已压缩）${summary}`;
    // 原子落库:追加摘要 + 删除被压缩的旧消息(事务内完成)。
    // 摘要 id 大于所有被删消息 id,保留的最近消息(id 更大)不受影响。
    const summaryId = await compactAgentMessages(sessionId, toSummarize[toSummarize.length - 1].id, summaryContent);
    const compressed: AgentMessage = { id: summaryId, role: 'user', content: summaryContent };
    return [compressed, ...keep];
  } catch (err) {
    console.warn('[agent] Context summarization failed, keeping full history:', err.message);
    return messages; // 宁可上下文超预算，不可丢消息
  }
}
