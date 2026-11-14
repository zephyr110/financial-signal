import { describe, expect, it } from 'vitest'
import { evaluateAgentReply } from '../lib/agent/eval'
import { findActionableTradeInstruction, findTradeInstruction } from '../lib/cockpit/validators'

describe('agent reply eval', () => {
  it('引用来源并说明验证条件的回答通过', () => {
    const result = evaluateAgentReply({
      question: '存储涨价到哪一步了？',
      reply: '信号 #42 与事件 #7 指向存储涨价处于扩散阶段，但能否延续仍需观察下游开工率，置信度中等。',
      toolLog: [{ name: 'search_news', ok: true }],
    })
    expect(result.passed).toBe(true)
    expect(result.score).toBe(1)
  })

  it('硬交易指令与漏出的工具 JSON 不通过', () => {
    const result = evaluateAgentReply({
      question: '存储现在能买吗？',
      reply: '{"tool":"search_news","args":{}} 建议买入并设置目标价，预计翻倍。',
      toolLog: [{ name: 'search_news', ok: true }],
    })
    expect(result.passed).toBe(false)
    expect(result.checks.find((check) => check.name === 'no_trade_instruction')?.ok).toBe(false)
    expect(result.checks.find((check) => check.name === 'no_tool_protocol')?.ok).toBe(false)
  })
})

describe('trade instruction split', () => {
  it('研究层面的建议给空间，交易动作仍拦截', () => {
    expect(findActionableTradeInstruction('建议关注存储链条，等待批价验证')).toBe(false)
    expect(findTradeInstruction('建议关注存储链条，等待批价验证')).toBe(false)
    expect(findActionableTradeInstruction('建议买入存储龙头')).toBe(true)
    expect(findActionableTradeInstruction('不构成买入建议，注意回撤风险')).toBe(false)
  })
})
