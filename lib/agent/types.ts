/**
 * 研究 Agent — 类型定义（spec §10.3 阶段 B）
 *
 * 设计：Mini-Agent 式 ReactLoop + "prompt 内 JSON 工具协议"
 *  - 循环：user 消息 → LLM → （JSON 工具调用 → 执行 → 结果回喂）→ 最终回答
 *  - 工具协议：模型输出 `{"tool":"<name>","args":{...}}` 视为工具调用，
 *    纯文本视为最终回答（对 DeepSeek 等 OpenAI 兼容 API 无需 native tool calling）
 */

export type Role = 'user' | 'assistant' | 'system';

export interface AgentMessage {
  /** 数据库行 id（加载自 agent_message；内存构造的摘要消息由压缩落库后回填） */
  id?: number;
  role: Role;
  content: string;
  /** assistant 消息的工具调用记录（用于展示/审计） */
  toolCall?: { name: string; args: Record<string, unknown> };
  /** 工具执行结果回喂消息 */
  toolResult?: { name: string; ok: boolean; content: string };
  timestamp?: string;
}

/** 工具定义：schema 注入 system prompt，execute 执行。 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 描述参数 */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

/** 单轮循环结果 */
export interface AgentTurnResult {
  /** 最终回复文本 */
  reply: string;
  /** 消耗的步数（LLM 调用次数） */
  steps: number;
  /** 工具调用日志（name + 简要结果），用于前端展示 */
  toolLog: { name: string; args: Record<string, unknown>; ok: boolean; summary: string }[];
  /** 是否因步数上限被截断 */
  truncated: boolean;
  /** 本轮用户消息的数据库 id（编辑重发时为被编辑消息的 id） */
  userMessageId: number;
}

/** 工具协议常量：模型输出的工具调用 JSON 格式 */
export const TOOL_CALL_JSON = `{"tool":"<工具名>","args":{...}}`;
