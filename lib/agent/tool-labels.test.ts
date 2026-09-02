import { describe, it, expect } from 'vitest'
import { RESEARCH_TOOLS } from './tools'
import { getToolLabel, TOOL_LABELS } from './tool-labels'

describe('getToolLabel', () => {
  it('每个注册工具都有中文展示名', () => {
    for (const t of RESEARCH_TOOLS) {
      expect(TOOL_LABELS[t.name]).toBeTruthy()
      expect(getToolLabel(t.name)).not.toBe(t.name)
    }
  })

  it('未知工具名原样返回', () => {
    expect(getToolLabel('unknown_tool')).toBe('unknown_tool')
  })
})
