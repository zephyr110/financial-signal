import { describe, it, expect } from 'vitest'
import {
  computeConfidence,
  containsNumericClaim,
  findAdviceLanguage,
  findStrongAdvice,
  validateBriefPayload,
  validateThesis,
} from '../lib/cockpit/validators'
import type { TodayPayload } from '../lib/cockpit/types'

const source = { id: 'demo-source', name: '示例数据源', tier: 2 as const, asOf: '2026-10-22T08:00:00.000Z' }

function validPayload(): TodayPayload {
  const confidence = computeConfidence({
    completeness: 0.9,
    freshness: 1,
    agreement: 0.6,
    sourceQuality: 0.5,
  })
  return {
    tradeDate: '2026-10-22',
    issueNo: 1,
    session: 'post',
    hero: {
      claim: '指数收涨，但上涨家数不足，赚钱效应偏弱。',
      confidence,
      evidence: [
        { id: 'fact:index:000001.SH', kind: 'fact', label: '上证指数收盘', value: '3201.42', source },
        { id: 'inference:breadth', kind: 'inference', label: '上涨家数占比不足一半，广度弱于指数。' },
        { id: 'counter:turnover', kind: 'counter', label: '成交额放大，分歧同步上升。', source },
        { id: 'conclusion:posture', kind: 'conclusion', label: '维持观察，等待广度修复。' },
      ],
    },
    indices: [{
      code: '000001.SH', name: '上证指数', close: 3201.42, changePct: 0.82,
      sparkline: [3180, 3190, 3201.42], source,
    }],
    breadth: { up: 2100, flat: 180, down: 2400, limitUp: 38, limitDown: 9, source },
    turnover: { value: 8942, changePct: 6.2, source },
    impacts: [],
    documents: [],
    tomorrow: ['关注成交额能否维持在 8000 亿以上。'],
    dataQuality: [{ id: 'demo-source', name: '示例数据源', tier: 2, status: 'demo', message: '示例数据' }],
    isDemo: true,
    generatedAt: '2026-10-22T08:00:00.000Z',
  }
}

describe('confidence', () => {
  it('按固定权重计算并夹紧输入', () => {
    expect(computeConfidence({ completeness: 1, freshness: 1, agreement: 1, sourceQuality: 1 })).toMatchObject({ score: 1, label: '高' })
    const c = computeConfidence({ completeness: 0.5, freshness: 0.5, agreement: 0.5, sourceQuality: 0.5 })
    expect(c.score).toBe(0.5)
    expect(c.label).toBe('低')
    expect(computeConfidence({ completeness: 2, freshness: 1, agreement: 1, sourceQuality: 1 }).inputs.completeness).toBe(1)
  })
})

describe('no-advice', () => {
  it('拦截交易动作与价格目标，但允许观察性措辞', () => {
    expect(findAdviceLanguage('建议买入并设置目标价')).not.toHaveLength(0)
    expect(findAdviceLanguage('关注批价变化，复核论点失效条件')).toHaveLength(0)
  })
})

describe('narrative guards', () => {
  it('全角数字、中文数字与仓位姿态都命中', () => {
    expect(containsNumericClaim('涨幅１２％')).toBe(true)
    expect(containsNumericClaim('成交额放大三成')).toBe(true)
    expect(containsNumericClaim('百分之五的换手')).toBe(true)
    expect(containsNumericClaim('观点一致，仍需一定时间验证')).toBe(false)
    expect(findStrongAdvice('建议继续持有并观望')).toBe(true)
    expect(findStrongAdvice('关注批价变化，复核失效条件')).toBe(false)
  })
})

describe('validateBriefPayload', () => {
  it('完整的四节点证据脊柱通过', () => {
    const payload = validPayload()
    const result = validateBriefPayload(payload, new Set(['fact:index:000001.SH']), new Set(['demo-source']))
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('缺反证、未知事实、未知来源或交易指令都失败', () => {
    const noCounter = validPayload()
    noCounter.hero.evidence = noCounter.hero.evidence.filter((e) => e.kind !== 'counter')
    expect(validateBriefPayload(noCounter, new Set(['fact:index:000001.SH']), new Set(['demo-source'])).ok).toBe(false)

    const unknownFact = validPayload()
    unknownFact.hero.evidence[0].id = 'fact:not-in-pack'
    expect(validateBriefPayload(unknownFact, new Set(['fact:index:000001.SH']), new Set(['demo-source'])).ok).toBe(false)

    const unknownSource = validPayload()
    unknownSource.hero.evidence[1].source = { ...source, id: 'missing-source' }
    expect(validateBriefPayload(unknownSource, new Set(['fact:index:000001.SH']), new Set(['demo-source'])).ok).toBe(false)

    const advice = validPayload()
    advice.hero.claim = '建议买入并等待目标价。'
    expect(validateBriefPayload(advice, new Set(['fact:index:000001.SH']), new Set(['demo-source'])).ok).toBe(false)
  })

  it('叙述层的全角数字与持仓指令同样失败', () => {
    for (const text of ['涨幅１２％，量能配合。', '建议继续持有并观望。']) {
      const payload = validPayload()
      payload.narrative = { text, model: 'mock-model', promptVersion: 'v1' }
      expect(validateBriefPayload(payload, new Set(['fact:index:000001.SH']), new Set(['demo-source'])).ok).toBe(false)
    }
  })
})

describe('validateThesis', () => {
  it('必须写失效条件', () => {
    expect(validateThesis({ title: '需求韧性', claim: '高端需求仍有韧性。', invalidation: [] }).ok).toBe(false)
    expect(validateThesis({ title: '需求韧性', claim: '高端需求仍有韧性。', invalidation: ['单季营收连续两季负增长'] }).ok).toBe(true)
  })
})
