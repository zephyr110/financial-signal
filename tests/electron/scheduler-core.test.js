import { describe, it, expect } from 'vitest'
import {
  PIPELINE_JOBS,
  buildJobSequence,
  isLlmConfigured,
  isDataStale,
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

describe('isDataStale', () => {
  it('true when last fetch older than threshold', () => {
    const lastFetch = new Date(Date.now() - 3 * 3600_000).toISOString()
    expect(isDataStale(lastFetch, new Date().toISOString(), 2 * 3600_000)).toBe(true)
  })

  it('false when fresh', () => {
    const lastFetch = new Date(Date.now() - 3600_000).toISOString()
    expect(isDataStale(lastFetch, new Date().toISOString(), 2 * 3600_000)).toBe(false)
  })

  it('true when last fetch is null (never fetched)', () => {
    expect(isDataStale(null, new Date().toISOString(), 2 * 3600_000)).toBe(true)
  })
})
