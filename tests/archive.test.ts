import { describe, it, expect } from 'vitest'
import { fetchLiveNews } from '../lib/archive'

describe('fetchLiveNews', () => {
  it('returns an array', async () => {
    const items = await fetchLiveNews()
    expect(Array.isArray(items)).toBe(true)
  }, 30000)

  it('returns items with expected shape', async () => {
    const items = await fetchLiveNews()
    if (items.length > 0) {
      const item = items[0]
      expect(item).toHaveProperty('id')
      expect(item).toHaveProperty('rich_text')
      expect(item).toHaveProperty('published_at')
      expect(item).toHaveProperty('source')
    }
  }, 30000)

  it('returns items sorted by time desc', async () => {
    const items = await fetchLiveNews()
    if (items.length >= 2) {
      for (let i = 0; i < items.length - 1; i++) {
        const a = items[i].published_at || ''
        const b = items[i + 1].published_at || ''
        expect(a >= b).toBe(true)
      }
    }
  }, 30000)

  it('has valid source values', async () => {
    const items = await fetchLiveNews()
    const validSources = ['sina', '10jqka', 'wallstreetcn', 'eastmoney', 'cls']
    for (const item of items) {
      expect(validSources).toContain(item.source)
    }
  }, 30000)
})
