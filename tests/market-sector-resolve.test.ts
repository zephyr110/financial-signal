import { describe, expect, it } from 'vitest'
import { industryMatches, pickSectorBoard, selectThreadMarket } from '../lib/market'

/**
 * 市场反应面板依赖行业名 → 东方财富板块的解析：
 * 只要候选里没有可信同名板块就返回 null，宁可空着也不猜错板块。
 */
describe('pickSectorBoard', () => {
  it('同名板块优先，避免“银行”被解析到“银行IT”', () => {
    expect(pickSectorBoard('银行', [
      { Classify: 'BK', Code: 'BK9999', Name: '银行IT' },
      { Classify: 'BK', Code: 'BK0475', Name: '银行' },
    ])).toEqual({ code: 'BK0475', name: '银行' })
  })

  it('申万二级名带后缀时按包含关系命中', () => {
    expect(pickSectorBoard('中药', [
      { Classify: 'BK', Code: 'BK1040', Name: '中药Ⅱ' },
    ])).toEqual({ code: 'BK1040', name: '中药Ⅱ' })
  })

  it('多个包含命中时取最短名，概念板块不能抢走行业本体', () => {
    expect(pickSectorBoard('锂电', [
      { Classify: 'BK', Code: 'BK0574', Name: '锂电池概念' },
      { Classify: 'BK', Code: 'BK1303', Name: '锂电池' },
      { Classify: 'BK', Code: 'BK1304', Name: '锂电专用设备' },
    ])).toEqual({ code: 'BK1303', name: '锂电池' })
  })

  it('个股和无关板块不参与，候选为空时返回 null', () => {
    expect(pickSectorBoard('管道运输', [
      { Classify: 'AStock', Code: '600001', Name: '管道运输股份' },
    ])).toBeNull()
    expect(pickSectorBoard('风电', [])).toBeNull()
  })
})

describe('industryMatches', () => {
  it('后缀与省略写法都能互相命中', () => {
    expect(industryMatches('银行Ⅱ', ['银行'])).toBe(true)
    expect(industryMatches('电力', ['电力'])).toBe(true)
    expect(industryMatches('电子化学品', ['电子化学品Ⅱ'])).toBe(true)
  })

  it('不相干行业不命中', () => {
    expect(industryMatches('钢铁', ['电力', '银行'])).toBe(false)
    expect(industryMatches('新能源车', ['新能源汽车'])).toBe(false)
  })
})

describe('selectThreadMarket', () => {
  const rows = [
    { code: 'BK0737', name: '软件开发', change_pct: 2.1 },
    { code: 'BK0428', name: '电力', change_pct: 0.5 },
    { code: 'BK0429', name: '电力设备', change_pct: -1.2 },
    { code: 'BK0900', name: '新能源车', change_pct: 3.3 },
  ]

  it('已解析行业按代码命中，允许行业名与板块名不同', () => {
    expect(selectThreadMarket(rows, ['软件服务'], { 软件服务: { code: 'BK0737' } }))
      .toEqual([rows[0]])
  })

  it('已解析行业不再走名称包含，避免带出相邻板块', () => {
    expect(selectThreadMarket(rows, ['电力'], { 电力: { code: 'BK0428' } }))
      .toEqual([rows[1]])
  })

  it('已解析板块当天缺行情时只按板块自己的名字兜底，不带出兄弟板块', () => {
    expect(selectThreadMarket(rows, ['电力'], { 电力: { code: 'BK9999', name: '电力' } }))
      .toEqual([rows[1]])
  })

  it('未解析行业退回名称匹配', () => {
    expect(selectThreadMarket(rows, ['电力'], {}))
      .toEqual([rows[1], rows[2]])
  })

  it('空行业列表返回空', () => {
    expect(selectThreadMarket(rows, [], {})).toEqual([])
  })
})
