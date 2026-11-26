import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import AnalysisNewsCard from '@/components/AnalysisNewsCard'

const item = {
  analysis_id: 1,
  signal_score: 4,
  category: 'industry',
  sentiment: 'positive',
  source: 'cls',
  summary: '测试摘要',
  content: '测试正文',
  industries: ['半导体', '存储'],
  companies: ['中芯国际'],
  published_at: '2026-11-26T10:00:00+08:00',
}

function badgeOf(text: string) {
  const badge = screen.getByText(text).closest('[data-slot="badge"]')
  expect(badge).not.toBeNull()
  return badge as HTMLElement
}

describe('信号时间线卡片底部标签', () => {
  it('分类、情绪、来源、行业共用同一套基础样式', () => {
    const { container } = render(<AnalysisNewsCard item={item} />)
    const badges = Array.from(container.querySelectorAll('[data-slot="badge"]'))

    expect(badges).toHaveLength(5)
    badges.forEach((badge) => {
      expect(badge).toHaveClass(
        'h-[18px]',
        'rounded-full',
        'px-1.5',
        'py-0',
        'text-[11px]',
        'font-medium',
      )
      // 不再有实心 secondary 混入
      expect(badge).not.toHaveClass('bg-secondary')
    })
  })

  it('仅通过语义色区分：分类蓝、利好红、来源与行业为中性色', () => {
    render(<AnalysisNewsCard item={item} />)

    expect(badgeOf('行业')).toHaveClass('border-blue-500/30', 'bg-blue-500/10', 'text-blue-700')
    expect(badgeOf('利好')).toHaveClass('border-red-500/30', 'bg-red-500/10', 'text-red-700')
    expect(badgeOf('财联社')).toHaveClass('border-border', 'text-muted-foreground')
    expect(badgeOf('半导体')).toHaveClass('border-border', 'text-muted-foreground')
  })

  it('未知分类回退为中性色而不是默认实心样式', () => {
    render(<AnalysisNewsCard item={{ ...item, category: 'unknown' }} />)

    const badge = badgeOf('unknown')
    expect(badge).toHaveClass('border-border', 'text-muted-foreground')
    expect(badge).not.toHaveClass('bg-primary')
  })
})
