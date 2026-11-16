import { describe, it, expect } from 'vitest'
import {
  EMPTY_SELECTION,
  hasSelection,
  normalizeSymbol,
  normalizeThread,
  parseSelectionQuery,
  withSelectionQuery,
} from '@/lib/selection'

describe('深链参数清洗', () => {
  it('标的允许字母数字与 ._-（外盘快照用 _SPX 这类符号）', () => {
    expect(normalizeSymbol('600519')).toBe('600519')
    expect(normalizeSymbol('_SPX')).toBe('_SPX')
    expect(normalizeSymbol('BRK.B')).toBe('BRK.B')
    expect(normalizeSymbol(' 600519 ')).toBe('600519')
  })

  it('标的拒绝空值、超长与注入字符', () => {
    expect(normalizeSymbol('')).toBeNull()
    expect(normalizeSymbol('   ')).toBeNull()
    expect(normalizeSymbol('600519;drop')).toBeNull()
    expect(normalizeSymbol('x'.repeat(21))).toBeNull()
    expect(normalizeSymbol(undefined)).toBeNull()
  })

  it('数组参数取第一项，数字转字符串', () => {
    expect(normalizeSymbol(['600519', '000001'])).toBe('600519')
    expect(normalizeSymbol(600519)).toBe('600519')
  })

  it('线索 ID 只接受正安全整数', () => {
    expect(normalizeThread('42')).toBe(42)
    expect(normalizeThread('0')).toBeNull()
    expect(normalizeThread('-1')).toBeNull()
    expect(normalizeThread('4.2')).toBeNull()
    expect(normalizeThread('abc')).toBeNull()
    expect(normalizeThread(42)).toBe(42)
  })
})

describe('parseSelectionQuery', () => {
  it('符号与线索同时存在时以标的为准', () => {
    expect(parseSelectionQuery({ symbol: '600519', thread: '7' })).toEqual({ symbol: '600519', thread: null })
  })

  it('标的非法时回退到线索', () => {
    expect(parseSelectionQuery({ symbol: 'bad code', thread: '7' })).toEqual({ symbol: null, thread: 7 })
  })

  it('都缺省时返回空选中', () => {
    expect(parseSelectionQuery({})).toEqual(EMPTY_SELECTION)
    expect(hasSelection(parseSelectionQuery({}))).toBe(false)
  })
})

describe('withSelectionQuery', () => {
  it('写入选中时保留其它查询参数，并清理旧键', () => {
    expect(withSelectionQuery({ tab: 'movers', symbol: 'old', thread: '3' }, { symbol: '600519', thread: null })).toEqual({
      tab: 'movers',
      symbol: '600519',
    })
  })

  it('线索 ID 以字符串写入 URL', () => {
    expect(withSelectionQuery({}, { symbol: null, thread: 12 })).toEqual({ thread: '12' })
  })

  it('空选中移除去重后不留脏参数', () => {
    expect(withSelectionQuery({ tab: 'a', symbol: '600519' }, EMPTY_SELECTION)).toEqual({ tab: 'a' })
  })
})
