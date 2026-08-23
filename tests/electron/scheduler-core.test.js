import { describe, it, expect } from 'vitest'
import {
  PIPELINE_JOBS,
  buildJobSequence,
  isLlmConfigured,
} from '../../electron/scheduler-core'

describe('PIPELINE_JOBS 与 lib/pipeline.ts 保持一致', () => {
  it('electron 侧与 web 侧的任务序列不漂移', async () => {
    const web = await import('../../lib/pipeline')
    expect(PIPELINE_JOBS).toEqual([...web.PIPELINE_JOBS])
  })
})

describe('buildJobSequence', () => {
  it('runs full pipeline when LLM configured', () => {
    expect(buildJobSequence({ llmConfigured: true })).toEqual(PIPELINE_JOBS)
  })

  it('runs fetch-only when LLM not configured', () => {
    expect(buildJobSequence({ llmConfigured: false })).toEqual(['fetch'])
  })
})

describe('isLlmConfigured', () => {
  it('true when llm_api_key set', () => {
    expect(isLlmConfigured({ llm_api_key: 'sk-xxx' })).toBe(true)
  })

  it('false when missing or empty', () => {
    const saved = { llm: process.env.LLM_API_KEY, deep: process.env.DEEPSEEK_API_KEY }
    try {
      delete process.env.LLM_API_KEY
      delete process.env.DEEPSEEK_API_KEY
      expect(isLlmConfigured({})).toBe(false)
      expect(isLlmConfigured({ llm_api_key: '' })).toBe(false)
    } finally {
      if (saved.llm === undefined) delete process.env.LLM_API_KEY
      else process.env.LLM_API_KEY = saved.llm
      if (saved.deep === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = saved.deep
    }
  })

  it('回退到环境变量(与 lib/llm/config.ts 一致)', () => {
    const saved = { llm: process.env.LLM_API_KEY, deep: process.env.DEEPSEEK_API_KEY }
    try {
      delete process.env.LLM_API_KEY
      delete process.env.DEEPSEEK_API_KEY
      expect(isLlmConfigured({})).toBe(false)
      process.env.LLM_API_KEY = 'sk-env'
      expect(isLlmConfigured({})).toBe(true)
      delete process.env.LLM_API_KEY
      process.env.DEEPSEEK_API_KEY = 'sk-deep'
      expect(isLlmConfigured({})).toBe(true)
      // settings 优先级:db 值存在时环境变量无关紧要
      expect(isLlmConfigured({ llm_api_key: 'sk-db' })).toBe(true)
    } finally {
      if (saved.llm === undefined) delete process.env.LLM_API_KEY
      else process.env.LLM_API_KEY = saved.llm
      if (saved.deep === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = saved.deep
    }
  })
})
