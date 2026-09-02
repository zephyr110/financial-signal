import { describe, it, expect } from 'vitest'
import {
  FILTER_KEYWORDS,
  CATEGORY_LABELS, CATEGORY_COLORS, SCORE_COLORS, SCORE_TO_IMPACT,
  sourceDisplayName,
} from '../lib/constants'

describe('FILTER_KEYWORDS', () => {
  it('contains expected keywords', () => {
    expect(FILTER_KEYWORDS).toContain('比特币')
    expect(FILTER_KEYWORDS).toContain('疫苗')
  })
})

describe('CATEGORY_LABELS', () => {
  it('has all 6 categories', () => {
    const cats = ['policy', 'geopolitics', 'industry', 'company', 'macro', 'market_rumor']
    for (const c of cats) {
      expect(CATEGORY_LABELS[c]).toBeTruthy()
    }
  })
})

describe('SCORE_TO_IMPACT', () => {
  it('maps scores correctly', () => {
    expect(SCORE_TO_IMPACT[5]).toBe('critical')
    expect(SCORE_TO_IMPACT[4]).toBe('significant')
    expect(SCORE_TO_IMPACT[3]).toBe('moderate')
    expect(SCORE_TO_IMPACT[2]).toBe('minor')
    expect(SCORE_TO_IMPACT[1]).toBe('noise')
  })
})

describe('SCORE_COLORS', () => {
  it('has colors for all scores 1-5', () => {
    for (let i = 1; i <= 5; i++) {
      expect(SCORE_COLORS[i]).toBeTruthy()
    }
  })
})

describe('sourceDisplayName', () => {
  it('maps known source ids to Chinese labels', () => {
    expect(sourceDisplayName('10jqka')).toBe('同花顺')
    expect(sourceDisplayName('sina')).toBe('新浪')
    expect(sourceDisplayName('wallstreetcn')).toBe('华尔街见闻')
  })

  it('falls back to raw id or 未知', () => {
    expect(sourceDisplayName('custom_feed')).toBe('custom_feed')
    expect(sourceDisplayName(null)).toBe('未知')
  })
})
