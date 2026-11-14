/**
 * 研究 Agent 的 prompt registry。
 * 改措辞必须同时递增版本，eval 与遥测才能按版本比较效果。
 */

export const AGENT_PROMPT_ID = 'research-agent';

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
- 可以给出趋势判断（早期/发酵/扩散/定价）和研究层面的关注方向、验证条件、风险提示
- 禁止交易动作指令、仓位比例、目标价或收益承诺（如买入/卖出/加仓/减仓/止损/止盈）
- 若工具没有数据，明确说明数据缺口，不要编造`;

export interface PromptSpec {
  id: string;
  version: string;
  text: string;
  notes: string;
}

export const PROMPT_REGISTRY: Record<string, PromptSpec> = {
  [AGENT_PROMPT_ID]: {
    id: AGENT_PROMPT_ID,
    version: 'v2',
    text: AGENT_SYSTEM_PROMPT,
    notes: '允许研究层面的关注方向与验证条件；硬交易指令仍禁止。',
  },
};

/** 拼装本轮 system prompt（正文 + 长期记忆 + 动态工具清单）。 */
export function buildAgentSystemPrompt(toolPrompt: string, memoryPrompt = ''): string {
  const memory = memoryPrompt.trim()
    ? `\n\n长期记忆（用户此前的偏好与结论，冲突时以用户本轮说法为准）：\n${memoryPrompt.trim()}`
    : '';
  return `${PROMPT_REGISTRY[AGENT_PROMPT_ID].text}${memory}\n\n可用工具：\n${toolPrompt}`;
}
