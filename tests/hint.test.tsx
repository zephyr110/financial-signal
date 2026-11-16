import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Hint } from '@/components/ui/hint'

describe('Hint', () => {
  it('无内容时原样返回子元素，不插入包装节点', () => {
    const { container } = render(
      <Hint content={undefined}>
        <span>指标</span>
      </Hint>,
    )
    expect(container.innerHTML).toBe('<span>指标</span>')
  })

  it('内容以 Tooltip 呈现，不写原生 title', async () => {
    render(
      <Hint content="说明文字">
        <button type="button">触发</button>
      </Hint>,
    )
    const trigger = screen.getByRole('button', { name: '触发' })
    expect(trigger).not.toHaveAttribute('title')
    fireEvent.focus(trigger)
    expect(await screen.findByText('说明文字')).toBeInTheDocument()
  })
})
