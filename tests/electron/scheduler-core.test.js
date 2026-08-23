import { describe, it, expect } from 'vitest'
import {
  PIPELINE_JOBS,
  buildJobSequence,
  isLlmConfigured,
} from '../../electron/scheduler-core'

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
    expect(isLlmConfigured({})).toBe(false)
    expect(isLlmConfigured({ llm_api_key: '' })).toBe(false)
  })
})
