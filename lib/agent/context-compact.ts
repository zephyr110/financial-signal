/**
 * 压缩摘要的纯字符串辅助，供浏览器侧（types/agent-chat.ts）复用；
 * 不能放进 session.ts —— 那里依赖 db/llm，会把 Node 模块带进客户端包。
 */

/** 压缩摘要消息前缀（落库与历史识别） */
export const CONTEXT_COMPACT_PREFIX = '（历史对话已压缩）';

export function stripContextCompactPrefix(content: string): string {
  return content.startsWith(CONTEXT_COMPACT_PREFIX)
    ? content.slice(CONTEXT_COMPACT_PREFIX.length)
    : content;
}
