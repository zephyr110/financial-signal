import { confidenceLabel } from './format'
import type {
  Confidence,
  ConfidenceInputs,
  TodayPayload,
  ValidationIssue,
  ValidationResult,
} from './types'

const ADVICE_PATTERNS: Array<{ re: RegExp; message: string }> = [
  { re: /买入|卖出|加仓|减仓|清仓|抄底|逃顶|满仓|空仓/, message: '出现交易动作指令' },
  { re: /目标价|止盈|止损|预期收益|翻倍/, message: '出现价格目标或收益承诺' },
  { re: /(建议|推荐)(买|卖|持有|加仓|减仓)/, message: '出现直接买卖建议' },
]

/** 返回命中的违规片段；空数组表示通过。只检查生成内容，不检查页脚免责声明。 */
export function findAdviceLanguage(text: string): string[] {
  if (!text) return []
  const hits: string[] = []
  for (const { re, message } of ADVICE_PATTERNS) {
    if (re.test(text)) hits.push(message)
  }
  return hits
}

export function assertNoAdvice(text: string): string[] {
  return findAdviceLanguage(text)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * 置信度由服务端输入决定，LLM 只能解释不能修改：
 * 完整度 35% + 新鲜度 25% + 口径一致 25% + 来源质量 15%。
 */
export function computeConfidence(inputs: ConfidenceInputs): Confidence {
  const safe: ConfidenceInputs = {
    completeness: clamp01(inputs.completeness),
    freshness: clamp01(inputs.freshness),
    agreement: clamp01(inputs.agreement),
    sourceQuality: clamp01(inputs.sourceQuality),
  }
  const score =
    0.35 * safe.completeness +
    0.25 * safe.freshness +
    0.25 * safe.agreement +
    0.15 * safe.sourceQuality
  const rounded = Math.round(score * 1000) / 1000
  return { score: rounded, label: confidenceLabel(rounded), inputs: safe }
}

function issue(issues: ValidationIssue[], code: string, message: string, severity: 'warn' | 'fail' = 'fail') {
  issues.push({ code, message, severity })
}

function checkText(issues: ValidationIssue[], code: string, text: string, maxLen = 240) {
  if (!text || !text.trim()) {
    issue(issues, code, '内容为空')
    return
  }
  if (text.length > maxLen) issue(issues, code, `内容超过 ${maxLen} 字`, 'warn')
  for (const hit of findAdviceLanguage(text)) issue(issues, `${code}.advice`, hit)
}

function validConfidence(c: Confidence, issues: ValidationIssue[]) {
  if (!c || !Number.isFinite(c.score) || c.score < 0 || c.score > 1) {
    issue(issues, 'confidence.score', '置信度必须在 0..1')
    return
  }
  for (const key of ['completeness', 'freshness', 'agreement', 'sourceQuality'] as const) {
    const v = c.inputs?.[key]
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      issue(issues, `confidence.${key}`, '置信度分项必须在 0..1')
    }
  }
  if (c.label !== confidenceLabel(c.score)) {
    issue(issues, 'confidence.label', '置信度标签与分数不一致')
  }
}

/**
 * 简报发布前校验：来源可追溯、事实节点存在、必须有反证、结论收尾、
 * 置信度字段完整，且不出现交易指令。校验失败时调用方应降级为 facts only。
 */
export function validateBriefPayload(
  payload: TodayPayload,
  knownFactIds: Set<string>,
  knownSourceIds: Set<string>,
): ValidationResult {
  const issues: ValidationIssue[] = []
  if (!payload || typeof payload !== 'object') {
    return { ok: false, issues: [{ code: 'payload', message: '简报为空', severity: 'fail' }] }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.tradeDate || '')) {
    issue(issues, 'tradeDate', '交易日格式必须为 YYYY-MM-DD')
  }
  if (!Array.isArray(payload.indices) || payload.indices.length === 0) {
    // 指数缺失时 buildDailyBrief 会降级为“不形成方向判断”，仍可发布数据质量记录。
    issue(issues, 'indices', '指数行情缺失，简报降级为数据质量记录', 'warn')
  }
  if (!Array.isArray(payload.dataQuality) || payload.dataQuality.length === 0) {
    issue(issues, 'dataQuality', '必须展示数据质量')
  }
  const b = payload.breadth
  if (!b || ![b.up, b.flat, b.down, b.limitUp, b.limitDown].every((n) => Number.isFinite(n) && n >= 0)) {
    issue(issues, 'breadth', '涨跌家数必须为非负数')
  }
  if (!payload.turnover || !Number.isFinite(payload.turnover.value) || payload.turnover.value < 0) {
    issue(issues, 'turnover', '成交额必须为非负数')
  }

  checkText(issues, 'hero.claim', payload.hero?.claim || '', 180)
  validConfidence(payload.hero?.confidence, issues)

  const evidence = payload.hero?.evidence || []
  if (evidence.length < 4) issue(issues, 'evidence.length', '证据脊柱至少需要 4 个节点', 'warn')
  const kinds = new Set(evidence.map((e) => e.kind))
  for (const kind of ['fact', 'inference', 'counter', 'conclusion'] as const) {
    if (!kinds.has(kind)) issue(issues, `evidence.${kind}`, `证据脊柱缺少 ${kind} 节点`)
  }
  if (evidence.length > 0 && evidence[evidence.length - 1].kind !== 'conclusion') {
    issue(issues, 'evidence.order', '证据脊柱必须以结论节点收尾')
  }
  for (const e of evidence) {
    checkText(issues, `evidence.${e.id || 'unknown'}`, e.label || '', 160)
    if (e.kind === 'fact') {
      if (!e.id || !knownFactIds.has(e.id)) {
        issue(issues, 'evidence.fact.ref', `事实节点 ${e.id || '(空)'} 不在事实包中`)
      }
      if (!e.source?.id) issue(issues, 'evidence.fact.source', '事实节点必须带来源')
    }
    if (e.source && !knownSourceIds.has(e.source.id)) {
      issue(issues, 'evidence.source', `来源 ${e.source.id} 未登记`)
    }
  }

  for (const d of payload.documents || []) {
    checkText(issues, `document.${d.id}`, d.title || '', 200)
    if (!d.source?.id || !knownSourceIds.has(d.source.id)) {
      issue(issues, 'document.source', `文档 ${d.id} 的来源未登记`)
    }
  }
  for (const impact of payload.impacts || []) {
    checkText(issues, `impact.${impact.code}`, impact.headline || '', 120)
    checkText(issues, `impact.${impact.code}.detail`, impact.detail || '', 260)
    for (const e of impact.evidence || []) {
      if (e.source && !knownSourceIds.has(e.source.id)) {
        issue(issues, 'impact.source', `个人影响 ${impact.code} 的来源未登记`)
      }
    }
  }
  for (const line of payload.tomorrow || []) checkText(issues, 'tomorrow', line, 120)
  if (!payload.tomorrow || payload.tomorrow.length === 0) {
    issue(issues, 'tomorrow.empty', '“明日看什么”不能为空', 'warn')
  }

  return { ok: issues.every((i) => i.severity !== 'fail'), issues }
}

export function validateThesis(thesis: { title: string; claim: string; invalidation: string[] }): ValidationResult {
  const issues: ValidationIssue[] = []
  checkText(issues, 'thesis.title', thesis.title || '', 80)
  checkText(issues, 'thesis.claim', thesis.claim || '', 300)
  if (!Array.isArray(thesis.invalidation) || thesis.invalidation.length === 0) {
    issue(issues, 'thesis.invalidation', '论点必须有至少一条失效条件')
  } else {
    for (const line of thesis.invalidation) checkText(issues, 'thesis.invalidation.line', line, 160)
  }
  return { ok: issues.every((i) => i.severity !== 'fail'), issues }
}
