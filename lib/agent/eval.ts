/**
 * 研究 Agent 的确定性出口评估。
 * 不替代人工评测，只拦住“没引用、没边界、漏出工具 JSON”的明显问题。
 */
import { findActionableTradeInstruction } from '../cockpit/validators';

export interface AgentEvalInput {
  question: string;
  reply: string;
  toolLog?: { name: string; ok: boolean; summary?: string }[];
}

export interface AgentEvalCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AgentEvalResult {
  passed: boolean;
  score: number;
  checks: AgentEvalCheck[];
}

const UNCERTAINTY = /可能|待验证|不确定|置信度|推测|条件|尚需|观察|缺口/;
const CITATION = /#\d+|信号\s*id|事件\s*id|条信号|来源|截至|今日|上周|月/;

export function evaluateAgentReply(input: AgentEvalInput): AgentEvalResult {
  const reply = (input.reply || '').trim();
  const usedTools = (input.toolLog || []).filter((tool) => tool.ok);
  const checks: AgentEvalCheck[] = [
    {
      name: 'non_empty',
      ok: reply.length >= 20,
      detail: '回答至少 20 字，避免空壳回复',
    },
    {
      name: 'no_trade_instruction',
      ok: !findActionableTradeInstruction(reply),
      detail: '不出现买卖动作、仓位比例或目标价',
    },
    {
      name: 'no_tool_protocol',
      ok: !/^\s*\{[\s\S]*"tool"\s*:/.test(reply),
      detail: '最终回答不得漏出工具调用 JSON',
    },
    {
      name: 'cites_sources',
      ok: usedTools.length === 0 || CITATION.test(reply),
      detail: '调用过工具时，回答要引用 id、时间或来源',
    },
    {
      name: 'states_uncertainty',
      ok: UNCERTAINTY.test(reply),
      detail: '说明置信度、验证条件或数据缺口',
    },
    {
      name: 'length_bounded',
      ok: reply.length <= 4000,
      detail: '回答控制在 4000 字以内，避免长篇堆砌',
    },
  ];
  const passed = checks.filter((check) => check.ok).length;
  return {
    passed: checks.every((check) => check.ok),
    score: Math.round((passed / checks.length) * 100) / 100,
    checks,
  };
}
