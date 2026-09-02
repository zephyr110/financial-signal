/**
 * 研究 Agent — 会话上下文管理（spec §10.3 阶段 B）
 */
import { getAgentMessages, compactAgentMessages } from '../db';
import { chatCompletion } from '../llm/client';
import type { AgentMessage } from './types';

/** 上下文 token 软预算（超出后触发压缩） */
export const CONTEXT_BUDGET_TOKENS = 12000;
/** 压缩时保留的最近完整消息数 */
export const KEEP_RECENT_MESSAGES = 8;
/** 压缩摘要的 LLM 调用最大输出 */
const SUMMARY_MAX_TOKENS = 800;

/** 压缩摘要消息前缀（落库与历史识别） */
export const CONTEXT_COMPACT_PREFIX = '（历史对话已压缩）';

export type ContextCompactEvent =
  | { type: 'start'; messageCount: number }
  | { type: 'end'; messageCount: number; summary: string; failed?: boolean };

export interface LoadAgentContextOptions {
  onCompact?: (event: ContextCompactEvent) => void;
}

function estimateTokens(messages: AgentMessage[]): number {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return Math.ceil(chars / 1.5);
}

const SUMMARIZE_PROMPT = `你是一个财经研究助手的上下文压缩器。请把用户与助手的历史对话压缩成一段中文摘要（200字以内），
保留：用户关心的问题、助手给出的关键结论、引用过的数据（行业、公司、事件线索ID、时间），
不要遗漏尚未解决的问题。只输出摘要本身，不要任何前缀。`;

async function summarizeMessages(messages: AgentMessage[]): Promise<string> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '系统'}: ${m.content.slice(0, 300)}`)
    .join('\n');
  const { content } = await chatCompletion({
    systemPrompt: SUMMARIZE_PROMPT,
    userMessage: `历史对话：\n${transcript}`,
    maxTokens: SUMMARY_MAX_TOKENS,
  });
  return content.slice(0, 500);
}

export function stripContextCompactPrefix(content: string): string {
  return content.startsWith(CONTEXT_COMPACT_PREFIX)
    ? content.slice(CONTEXT_COMPACT_PREFIX.length)
    : content;
}

function isContextCompactRow(row: { role: unknown; content: unknown; meta?: { contextCompact?: boolean } | null }): boolean {
  return (
    (row.role === 'system' && row.meta?.contextCompact === true) ||
    String(row.content).startsWith(CONTEXT_COMPACT_PREFIX)
  );
}

/** 压缩摘要应排在保留的最近消息之前（落库 id 在 keep 之后，需重排） */
function orderMessagesForContext(
  rows: { role: unknown; content: unknown; meta?: { contextCompact?: boolean } | null }[],
  messages: AgentMessage[],
): AgentMessage[] {
  const compact: AgentMessage[] = [];
  const rest: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isContextCompactRow(rows[i])) compact.push(messages[i]);
    else rest.push(messages[i]);
  }
  return [...compact, ...rest];
}

/**
 * 加载会话上下文（含自动压缩）。
 * 压缩时通过 onCompact 回调通知调用方（用于 SSE 推送到前端 processing 块）。
 */
export async function loadAgentContext(
  sessionId: number,
  opts?: LoadAgentContextOptions,
): Promise<AgentMessage[]> {
  const rows = await getAgentMessages(sessionId);
  const mapped: AgentMessage[] = rows.map((r) => ({
    id: r.id,
    role: r.role as AgentMessage['role'],
    content: r.content,
    ...(r.meta?.toolCall ? { toolCall: r.meta.toolCall } : {}),
    ...(r.meta?.toolResult ? { toolResult: r.meta.toolResult } : {}),
  }));
  const messages = orderMessagesForContext(rows, mapped);

  if (estimateTokens(messages) <= CONTEXT_BUDGET_TOKENS) return messages;

  const keep = messages.slice(-KEEP_RECENT_MESSAGES);
  const toSummarize = messages.slice(0, -KEEP_RECENT_MESSAGES);
  if (toSummarize.length === 0) return messages;

  console.log(`[agent] Context ${messages.length} msgs exceeds budget — summarizing ${toSummarize.length} old messages.`);
  opts?.onCompact?.({ type: 'start', messageCount: toSummarize.length });

  try {
    const summary = await summarizeMessages(toSummarize);
    const summaryContent = `${CONTEXT_COMPACT_PREFIX}${summary}`;
    const summaryId = await compactAgentMessages(
      sessionId,
      toSummarize[toSummarize.length - 1].id!,
      summaryContent,
      { contextCompact: true, summarizedCount: toSummarize.length },
    );
    opts?.onCompact?.({ type: 'end', messageCount: toSummarize.length, summary });
    const compressed: AgentMessage = { id: summaryId, role: 'system', content: summaryContent };
    return [compressed, ...keep];
  } catch (err) {
    console.warn('[agent] Context summarization failed, keeping full history:', (err as Error).message);
    opts?.onCompact?.({ type: 'end', messageCount: toSummarize.length, summary: '', failed: true });
    return messages;
  }
}
