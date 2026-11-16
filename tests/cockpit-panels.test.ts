import { describe, it, expect } from 'vitest'
import {
  COCKPIT_PANELS,
  COCKPIT_PANEL_KEYS,
  COCKPIT_PANEL_STORAGE_KEY,
  isPanelKey,
  loadPanelKeys,
  sanitizePanelKeys,
  savePanelKeys,
  togglePanelKey,
} from '@/lib/cockpit-panels'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value)
    },
  }
}

describe('面板清单', () => {
  it('固定五块且标签与键一一对应', () => {
    expect(COCKPIT_PANELS.map((panel) => panel.key)).toEqual([...COCKPIT_PANEL_KEYS])
    expect(COCKPIT_PANELS.map((panel) => panel.label)).toEqual([
      '今日简报',
      '市场脉搏',
      '自选异动',
      '持仓暴露',
      '今日任务',
    ])
  })

  it('isPanelKey 只接受清单内的字符串', () => {
    expect(isPanelKey('brief')).toBe(true)
    expect(isPanelKey('bogus')).toBe(false)
    expect(isPanelKey(null)).toBe(false)
    expect(isPanelKey(1)).toBe(false)
  })
})

describe('面板显隐', () => {
  it('非法或空数组回退到全部显示', () => {
    expect(sanitizePanelKeys(null)).toEqual([...COCKPIT_PANEL_KEYS])
    expect(sanitizePanelKeys([])).toEqual([...COCKPIT_PANEL_KEYS])
    expect(sanitizePanelKeys(['bogus'])).toEqual([...COCKPIT_PANEL_KEYS])
  })

  it('去重并按固定顺序输出', () => {
    expect(sanitizePanelKeys(['tasks', 'brief', 'tasks', 'bogus'])).toEqual(['brief', 'tasks'])
  })

  it('至少保留一块：最后一块不能隐藏', () => {
    expect(togglePanelKey(['brief'], 'brief')).toEqual(['brief'])
  })

  it('隐藏后重新显示回到固定顺序', () => {
    const hidden = togglePanelKey([...COCKPIT_PANEL_KEYS], 'pulse')
    expect(hidden).toEqual(['brief', 'watchlist', 'portfolio', 'tasks'])
    expect(togglePanelKey(hidden, 'pulse')).toEqual([...COCKPIT_PANEL_KEYS])
  })
})

describe('本地持久化', () => {
  it('无存储或解析失败时回退全部显示', () => {
    expect(loadPanelKeys(null)).toEqual([...COCKPIT_PANEL_KEYS])
    expect(loadPanelKeys(memoryStorage({ [COCKPIT_PANEL_STORAGE_KEY]: '{oops' }))).toEqual([...COCKPIT_PANEL_KEYS])
  })

  it('保存前清洗非法值，读回保持一致', () => {
    const storage = memoryStorage()
    savePanelKeys(storage, ['tasks', 'bogus'] as any)
    expect(JSON.parse(storage.getItem(COCKPIT_PANEL_STORAGE_KEY) as string)).toEqual(['tasks'])
    expect(loadPanelKeys(storage)).toEqual(['tasks'])
  })

  it('存储抛异常时静默降级，不阻断界面', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadPanelKeys(broken)).toEqual([...COCKPIT_PANEL_KEYS])
    expect(() => savePanelKeys(broken, [...COCKPIT_PANEL_KEYS])).not.toThrow()
  })
})
