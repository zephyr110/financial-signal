import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  DEFAULT_AGENT_MAX_STEPS,
  getAgentMaxSteps,
  isTruncatedAgentReply,
} from './limits'

describe('getAgentMaxSteps', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('默认 12 步', () => {
    delete process.env.AGENT_MAX_STEPS
    expect(getAgentMaxSteps()).toBe(DEFAULT_AGENT_MAX_STEPS)
    expect(DEFAULT_AGENT_MAX_STEPS).toBe(12)
  })

  it('环境变量覆盖，越界回退默认', () => {
    vi.stubEnv('AGENT_MAX_STEPS', '16')
    expect(getAgentMaxSteps()).toBe(16)
    vi.stubEnv('AGENT_MAX_STEPS', '99')
    expect(getAgentMaxSteps()).toBe(12)
    vi.stubEnv('AGENT_MAX_STEPS', 'abc')
    expect(getAgentMaxSteps()).toBe(12)
  })
})

describe('isTruncatedAgentReply', () => {
  it('识别触顶前缀', () => {
    expect(isTruncatedAgentReply('> 本轮工具调用较多，以下为…')).toBe(true)
    expect(isTruncatedAgentReply('已达到单轮工具调用上限（12 次）')).toBe(true)
    expect(isTruncatedAgentReply('正常回答')).toBe(false)
  })
})
