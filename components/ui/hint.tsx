import type { ReactElement, ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip'

/**
 * 原生 title 的替代品：无内容时不渲染任何包装，
 * 触发元素由 base-ui 克隆，不额外插入 DOM 节点。
 */
export function Hint({
  content,
  children,
  side = 'top',
}: {
  content?: ReactNode
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  if (content == null || content === '') return children
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side} className="">{content}</TooltipContent>
    </Tooltip>
  )
}
