import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import BrandLogo from '@/components/BrandLogo'

describe('BrandLogo', () => {
  it('默认作为装饰图，不重复播报相邻的品牌文字', () => {
    const { container } = render(<BrandLogo />)
    expect(container.querySelector('img')).toHaveAttribute('alt', '')
  })
})
