import { describe, it, expect } from 'vitest'
import { normalizeCode } from '../lib/cockpit/codes'

/**
 * 六位代码补交易所后缀：北交所 4/8/920、沪市 5/6/9/11/7，其余深市。
 * ETF、B 股与转债都不能被误判成深市。
 */
describe('normalizeCode', () => {
  it.each([
    ['600519', '600519.SH'],
    ['688001', '688001.SH'],
    ['510300', '510300.SH'],
    ['900901', '900901.SH'],
    ['110059', '110059.SH'],
    ['000001', '000001.SZ'],
    ['300750', '300750.SZ'],
    ['920001', '920001.BJ'],
    ['430047', '430047.BJ'],
    ['830799', '830799.BJ'],
    ['SH600519', '600519.SH'],
    ['sz000001', '000001.SZ'],
    ['bj920001', '920001.BJ'],
    ['600519.SH', '600519.SH'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeCode(input)).toBe(expected)
  })

  it.each(['60051', '600519.XX', 'ABC123', '', '  ', null, undefined, 600519])('拒绝非法输入 %j', (input) => {
    expect(normalizeCode(input)).toBeNull()
  })
})
