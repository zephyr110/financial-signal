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
  const NOW = '2026-08-23T10:00:00.000Z'

  it('true when last fetch older than threshold', () => {
    expect(isDataStale('2026-08-23T07:30:00.000Z', NOW, 2 * 3600_000)).toBe(true)
  })

  it('false when fresh', () => {
    expect(isDataStale('2026-08-23T09:00:00.000Z', NOW, 2 * 3600_000)).toBe(false)
  })

  it('false when exactly at threshold (not strictly greater)', () => {
    expect(isDataStale('2026-08-23T08:00:00.000Z', NOW, 2 * 3600_000)).toBe(false)
  })

  it('true when last fetch is null (never fetched)', () => {
    expect(isDataStale(null, NOW, 2 * 3600_000)).toBe(true)
  })

  it('parses sqlite space-separated timestamps as UTC', () => {
    expect(isDataStale('2026-08-23 07:30:00', NOW, 2 * 3600_000)).toBe(true)
  })
})
