import { describe, it, expect } from 'vitest'
import {
  filterPaletteCommands,
  groupPaletteCommands,
  nextIndex,
  type PaletteFilterable,
} from '@/lib/command-palette'

const commands: Array<PaletteFilterable & { id: string }> = [
  { id: 'page:cockpit', label: '驾驶舱', group: '页面', keywords: ['/'] },
  { id: 'page:desk', label: '投研台', group: '页面', keywords: ['/desk', 'market'] },
  { id: 'symbol:600519', label: '贵州茅台 600519', group: '标的', keywords: ['600519', '贵州茅台'] },
  { id: 'action:refresh', label: '刷新驾驶舱数据', group: '操作', keywords: ['刷新', '更新'] },
]

describe('命令过滤', () => {
  it('空查询返回全部命令', () => {
    expect(filterPaletteCommands(commands, '   ')).toHaveLength(commands.length)
  })

  it('多个词必须全部命中，任一字段均可', () => {
    expect(filterPaletteCommands(commands, '茅台 600519').map((item) => item.id)).toEqual(['symbol:600519'])
    expect(filterPaletteCommands(commands, '页面 desk').map((item) => item.id)).toEqual(['page:desk'])
  })

  it('大小写不敏感', () => {
    expect(filterPaletteCommands(commands, 'DESK').map((item) => item.id)).toEqual(['page:desk'])
  })

  it('无匹配返回空数组', () => {
    expect(filterPaletteCommands(commands, '不存在')).toEqual([])
  })
})

describe('键盘索引', () => {
  it('上下移动循环，空列表返回 -1', () => {
    expect(nextIndex(0, 4, 1)).toBe(1)
    expect(nextIndex(3, 4, 1)).toBe(0)
    expect(nextIndex(0, 4, -1)).toBe(3)
    expect(nextIndex(0, 0, 1)).toBe(-1)
  })
})

describe('分组', () => {
  it('只合并相邻同组，保持选中顺序', () => {
    expect(groupPaletteCommands(commands).map((group) => [group.group, group.items.length])).toEqual([
      ['页面', 2],
      ['标的', 1],
      ['操作', 1],
    ])
  })

  it('空列表返回空分组', () => {
    expect(groupPaletteCommands([])).toEqual([])
  })
})
