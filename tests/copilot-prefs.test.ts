import { describe, it, expect } from 'vitest'
import {
  COPILOT_OPEN_KEY,
  COPILOT_SEEN_KEY,
  markCopilotSeen,
  readCopilotPrefs,
  resolveCopilotOpen,
  writeCopilotPrefs,
} from '@/lib/copilot-prefs'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
    removeItem: (key: string) => {
      data.delete(key)
    },
  }
}

describe('Copilot 默认状态', () => {
  it('移动端无论偏好如何都默认关闭', () => {
    expect(resolveCopilotOpen(true, false, true)).toBe(false)
    expect(resolveCopilotOpen(null, true, true)).toBe(false)
  })

  it('桌面端首次进入展开一次', () => {
    expect(resolveCopilotOpen(null, true, false)).toBe(true)
  })

  it('桌面端记住用户上次选择', () => {
    expect(resolveCopilotOpen(false, true, false)).toBe(false)
    expect(resolveCopilotOpen(true, false, false)).toBe(true)
  })

  it('老用户没有存储偏好时默认收起', () => {
    expect(resolveCopilotOpen(null, false, false)).toBe(false)
  })
})

describe('Copilot 偏好读写', () => {
  it('存储不可用时按首次访问处理', () => {
    expect(readCopilotPrefs(null)).toEqual({ stored: null, firstVisit: true })
  })

  it('写展开状态时同时标记已见过', () => {
    const storage = memoryStorage()
    writeCopilotPrefs(storage, true)
    expect(storage.getItem(COPILOT_OPEN_KEY)).toBe('1')
    expect(storage.getItem(COPILOT_SEEN_KEY)).toBe('1')
    expect(readCopilotPrefs(storage)).toEqual({ stored: true, firstVisit: false })
  })

  it('首次自动展开只记已见过，不写展开偏好', () => {
    const storage = memoryStorage()
    markCopilotSeen(storage)
    expect(storage.getItem(COPILOT_OPEN_KEY)).toBeNull()
    expect(readCopilotPrefs(storage)).toEqual({ stored: null, firstVisit: false })
  })

  it('未知值按未设置处理', () => {
    const storage = memoryStorage({ [COPILOT_OPEN_KEY]: 'yes' })
    expect(readCopilotPrefs(storage).stored).toBeNull()
  })
})
