import crypto from 'crypto'
import { getDb } from '../db'
import { chatCompletion } from '../llm/client'
import { getEffectiveLlmConfig, PRICING } from '../llm/config'
import { findAdviceLanguage } from './validators'
import type { TodayPayload } from './types'

/**
 * 可选叙述层：模型只解释事实包里的关系，数字、来源与置信度仍由确定性代码给出。
 * 未配置 Key、校验失败或调用失败时安静降级，不影响简报发布。
 */

export const NARRATIVE_PROMPT_VERSION = 'daily-narrative-v1'
const NARRATIVE_MAX = 320
const STRONG_ADVICE = /建议|推荐|操作|买入|卖出|加仓|减仓|清仓|抄底|逃顶|止损|止盈|目标价/

export interface NarrativeResult {
  text: string
  model: string
  promptVersion: string
  costMicros: number
  promptTokens: number
  completionTokens: number
}

export async function llmConfigured(): Promise<boolean> {
  try {
    const cfg = await getEffectiveLlmConfig()
    return Boolean(cfg.apiKey)
  } catch {
    return false
  }
}

function textIsSafe(text: string, maxLen: number, forbidDigits = false): boolean {
  if (!text || text.length > maxLen) return false
  if (forbidDigits && /\d/.test(text)) return false
  return findAdviceLanguage(text).length === 0 && !STRONG_ADVICE.test(text)
}

async function recordUsage(input: {
  taskId?: string
  model: string
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  costMicros: number
  latencyMs: number
}): Promise<void> {
  const db = await getDb()
  await db.execute({
    sql: `INSERT INTO llm_usage
          (id, task_id, model, prompt_tokens, completion_tokens, cost_micros, latency_ms, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      crypto.randomUUID(),
      input.taskId || null,
      input.model,
      Math.max(0, Math.floor(input.usage?.prompt_tokens || 0)),
      Math.max(0, Math.floor(input.usage?.completion_tokens || 0)),
      input.costMicros,
      input.latencyMs,
      new Date().toISOString(),
    ],
  }).catch((err) => {
    console.error('[cockpit/narrative] usage', err instanceof Error ? err.message : err)
  })
}

function costOf(usage?: { prompt_tokens?: number; completion_tokens?: number }): number {
  const prompt = Math.max(0, usage?.prompt_tokens || 0)
  const completion = Math.max(0, usage?.completion_tokens || 0)
  // 每百万 token 价格 × token 数，再换算成微元。
  return Math.round(prompt * PRICING.inputPerMillion + completion * PRICING.outputPerMillion)
}

export async function generateBriefNarrative(
  payload: TodayPayload,
  taskId?: string,
): Promise<NarrativeResult | null> {
  if (payload.isDemo) return null
  if (!await llmConfigured()) return null
  const started = Date.now()
  try {
    const evidence = payload.hero.evidence
      .slice(0, 6)
      .map((item) => `- [${item.kind}] ${item.label}${item.source ? `（${item.source.name}，T${item.source.tier}）` : ''}`)
      .join('\n')
    const result = await chatCompletion({
      systemPrompt: [
        '你是个人投研驾驶舱的叙述编辑。',
        '只解释给定事实之间的关系，不预测涨跌，不给出任何交易动作、建议、目标价或收益承诺。',
        '不要写任何阿拉伯数字、百分比或日期，数字由页面的事实区展示。',
        '用 2-3 句中文，说明事实之间是相互印证还是存在分歧；证据不足时直接说明不足。',
        '不要提到“模型”“提示词”或这段规则。',
      ].join('\n'),
      userMessage: [
        `交易日：${payload.tradeDate}`,
        `服务端结论：${payload.hero.claim}`,
        `证据：\n${evidence}`,
        `置信度分项：${JSON.stringify(payload.hero.confidence.inputs)}`,
        '请只写叙述，不要复述数字，不要加入新事实。',
      ].join('\n'),
      temperature: 0.2,
      maxTokens: 320,
    }) as { content?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string }
    const text = String(result.content || '').replace(/\s+/g, ' ').trim()
    const latencyMs = Date.now() - started
    const model = result.model || 'unknown'
    const costMicros = costOf(result.usage)
    await recordUsage({ taskId, model, usage: result.usage, costMicros, latencyMs })
    if (!textIsSafe(text, NARRATIVE_MAX, true)) return null
    return {
      text,
      model,
      promptVersion: NARRATIVE_PROMPT_VERSION,
      costMicros,
      promptTokens: result.usage?.prompt_tokens || 0,
      completionTokens: result.usage?.completion_tokens || 0,
    }
  } catch (err) {
    console.error('[cockpit/narrative]', err instanceof Error ? err.message : err)
    return null
  }
}

export interface AnswerResult {
  answer: string
  citations: Array<{ id: string; name: string; tier: number }>
  model: string | null
  fallbackReason?: string
}

function deterministicAnswer(payload: TodayPayload): AnswerResult {
  const evidence = payload.hero.evidence
  const citations = evidence
    .filter((item) => item.source)
    .map((item) => ({ id: item.source!.id, name: item.source!.name, tier: item.source!.tier }))
  return {
    answer: [
      payload.hero.claim,
      ...evidence.slice(0, 3).map((item) => `· ${item.label}`),
      `置信度：${payload.hero.confidence.label}（${payload.hero.confidence.score}）`,
    ].join('\n'),
    citations,
    model: null,
  }
}

/** 问答只引用当前简报的事实包；返回空引用列表时前端应提示信息不足。 */
export async function answerBriefQuestion(
  question: string,
  payload: TodayPayload,
  taskId?: string,
): Promise<AnswerResult> {
  const fallback = deterministicAnswer(payload)
  if (payload.isDemo || !await llmConfigured()) return fallback
  const started = Date.now()
  try {
    const context = {
      tradeDate: payload.tradeDate,
      claim: payload.hero.claim,
      confidence: payload.hero.confidence,
      evidence: payload.hero.evidence.map((item) => ({
        kind: item.kind,
        label: item.label,
        source: item.source ? { id: item.source.id, name: item.source.name, tier: item.source.tier } : null,
      })),
      indices: payload.indices.map((index) => ({ code: index.code, name: index.name, close: index.close, changePct: index.changePct })),
      breadth: payload.breadth,
      turnover: payload.turnover,
      documents: payload.documents.map((doc) => ({ id: doc.id, title: doc.title, source: doc.source.name })),
    }
    const result = await chatCompletion({
      systemPrompt: [
        '你是个人投研驾驶舱的问答助手。',
        '只能使用给定简报上下文，不得补充外部事实、新闻或数字。',
        '若上下文不足，直接回答“当前简报没有足够证据回答这个问题”。',
        '用中文回答，控制在 300 字以内；引用来源时在句末用【来源名】标注。',
        '禁止给出任何交易动作、买卖建议、目标价、收益承诺或仓位指令。',
      ].join('\n'),
      userMessage: `问题：${question}\n\n简报上下文：\n${JSON.stringify(context)}`,
      temperature: 0.1,
      maxTokens: 600,
    }) as { content?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string }
    const text = String(result.content || '').trim()
    const latencyMs = Date.now() - started
    const model = result.model || 'unknown'
    const costMicros = costOf(result.usage)
    await recordUsage({ taskId, model, usage: result.usage, costMicros, latencyMs })
    if (!textIsSafe(text, 600)) {
      return { ...fallback, fallbackReason: '模型回答未通过合规校验，已改用确定性证据摘要' }
    }
    return { answer: text, citations: fallback.citations, model }
  } catch (err) {
    console.error('[cockpit/narrative/ask]', err instanceof Error ? err.message : err)
    return { ...fallback, fallbackReason: '模型不可用，已改用确定性证据摘要' }
  }
}
