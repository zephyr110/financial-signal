/** 单轮默认最大工具调用步数（LLM 发起并成功执行工具的次数） */
export const DEFAULT_AGENT_MAX_STEPS = 12;

/** 格式/参数纠错轮次上限（不计入工具步数，防止模型反复输出坏 JSON 占满配额） */
export const MAX_CORRECTION_STEPS = 4;

/** 环境变量 AGENT_MAX_STEPS 可覆盖，合法范围 4–24 */
export function getAgentMaxSteps(): number {
  const n = Number(process.env.AGENT_MAX_STEPS);
  if (Number.isFinite(n) && n >= 4 && n <= 24) return Math.floor(n);
  return DEFAULT_AGENT_MAX_STEPS;
}

/** 助手回复是否因触顶而截断（历史重放推断） */
export function isTruncatedAgentReply(content: string): boolean {
  const t = content.trim();
  return (
    t.includes("已达到单轮工具调用上限") ||
    t.startsWith("> 本轮工具调用较多")
  );
}
