/**
 * 预警深挖：有界 ReAct + 确定性 supervisor。
 * LLM 只在预算内调用只读工具；结论置信度、证据强度与引用由代码计算。
 */
import crypto from 'crypto'
import { getDb } from '../db'
import { chatCompletion } from '../llm/client'
import { getEffectiveLlmConfig, PRICING } from '../llm/config'
import { tryParseToolCall } from '../agent/tool-call'
import { todayShanghai } from '../cockpit/format'
import type {
  DeskConfidence,
  InvestigationBudget,
  InvestigationFeedback,
  InvestigationStatus,
  InvestigationStepView,
  InvestigationView,
} from './types'

type Row = Record<string, unknown>

export const MANUAL_BUDGET: InvestigationBudget = { maxSteps: 8, timeoutMs: 90_000 }
export const AUTO_BUDGET: InvestigationBudget = { maxSteps: 6, timeoutMs: 45_000 }

const AUTO_MIN_SCORE = 3
const MAX_CONCLUSION_CHARS = 700

interface EvidenceRef {
  ref: string
  kind: string
  label: string
  value: string
}

interface EvidenceBundle {
  refs: EvidenceRef[]
  digest: string
  lines: string[]
}

interface ToolResult {
  text: string
  refs: EvidenceRef[]
}

function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value)
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function confidenceOf(refs: EvidenceRef[]): DeskConfidence {
  const kinds = new Set(refs.map((ref) => ref.kind)).size
  if (refs.length >= 4 && kinds >= 3) return 'high'
  if (refs.length >= 2) return 'medium'
  return 'low'
}

function strengthOf(refs: EvidenceRef[]): 'thin' | 'moderate' | 'strong' {
  const kinds = new Set(refs.map((ref) => ref.kind)).size
  if (refs.length >= 4 && kinds >= 3) return 'strong'
  if (refs.length >= 2) return 'moderate'
  return 'thin'
}

/** 工具重复返回同一引用时，置信度不能靠重复计数抬高。 */
function dedupeRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>()
  return refs.filter((ref) => {
    if (seen.has(ref.ref)) return false
    seen.add(ref.ref)
    return true
  })
}

/** 触发评分：严重度、类别、证据数量与行业覆盖共同决定是否自动深挖。 */
export function investigationTrigger(alert: {
  severity: string
  category: string
  industry?: string
  evidence?: unknown[]
}): { score: number; reasons: string[] } {
  const reasons: string[] = []
  let score = 0
  if (alert.severity === 'critical') { score += 2; reasons.push('关键级预警') }
  else if (alert.severity === 'important') { score += 1; reasons.push('重要预警') }
  if (['policy', 'announcement', 'market', 'market_breadth', 'industry_move', 'document'].includes(alert.category)) {
    score += 1
    reasons.push('政策/公告/市场级事件')
  }
  if ((alert.evidence?.length || 0) >= 2) { score += 1; reasons.push('多条证据') }
  if (alert.industry) { score += 1; reasons.push('可落到行业') }
  return { score, reasons }
}

export async function collectEvidence(input: {
  alertId?: string
  judgmentId?: string
  industry?: string
  symbolCode?: string
}): Promise<EvidenceBundle> {
  const db = await getDb()
  const refs: EvidenceRef[] = []
  const lines: string[] = []

  if (input.alertId) {
    const res = await db.execute({ sql: 'SELECT * FROM alerts WHERE id = ?', args: [input.alertId] })
    const row = res.rows[0]
    if (row) {
      refs.push({ ref: `alert:${input.alertId}`, kind: 'alert', label: '预警', value: str(row.title) })
      lines.push(`预警：${str(row.title)}｜${str(row.summary)}｜触发原因：${str(row.why_now)}`)
      for (const item of parseJson<Array<{ label?: string; value?: string; id?: string }>>(row.evidence_json, [])) {
        const ref = item.id ? `alert-evidence:${item.id}` : `alert-evidence:${refs.length}`
        refs.push({ ref, kind: 'alert-evidence', label: item.label || '证据', value: item.value || '' })
      }
    }
  }

  if (input.judgmentId) {
    const res = await db.execute({ sql: 'SELECT * FROM judgments WHERE id = ?', args: [input.judgmentId] })
    const row = res.rows[0]
    if (row) {
      refs.push({ ref: `judgment:${input.judgmentId}`, kind: 'judgment', label: '判断', value: str(row.headline) })
      lines.push(`判断：${str(row.headline)}｜${str(row.summary)}`)
    }
  }

  if (input.industry) {
    const res = await db.execute({
      sql: `SELECT * FROM industry_daily WHERE industry = ? ORDER BY trade_date DESC LIMIT 5`,
      args: [input.industry],
    })
    for (const row of res.rows as unknown as Row[]) {
      const ref = `industry:${str(row.industry)}:${str(row.trade_date)}`
      refs.push({
        ref,
        kind: 'industry',
        label: `${str(row.industry)} ${str(row.trade_date)}`,
        value: `涨跌均值 ${num(row.avg_pct)}%，广度 ${num(row.breadth)}%，成交额 ${num(row.amount)}`,
      })
      lines.push(`${ref}｜均值 ${num(row.avg_pct)}%｜广度 ${num(row.breadth)}%｜5日动量 ${num(row.momentum_5d)}%`)
    }
  }

  // 没有行业/标的时不做 LIKE '%' 全表扫，否则只会捞到无关的最新文档。
  const filter = input.symbolCode || input.industry
  if (filter) {
    const like = `%${filter}%`
    const docs = await db.execute({
      sql: `SELECT id, title, source_id, published_at, doc_type FROM source_documents
            WHERE (title LIKE ? OR metadata_json LIKE ?)
            ORDER BY published_at DESC LIMIT 6`,
      args: [like, like],
    })
    for (const row of docs.rows as unknown as Row[]) {
      const ref = `doc:${str(row.id)}`
      refs.push({
        ref,
        kind: 'document',
        label: str(row.title),
        value: `${str(row.source_id)} ${str(row.published_at)}`,
      })
      lines.push(`${ref}｜${str(row.published_at)}｜${str(row.title)}`)
    }
  }

  if (refs.some((ref) => ref.kind === 'industry')) {
    const overseas = await db.execute({
      sql: `SELECT * FROM (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY trade_time DESC) AS rn
              FROM overseas_quotes
            ) WHERE rn = 1 ORDER BY symbol LIMIT 4`,
      args: [],
    })
    for (const row of overseas.rows as unknown as Row[]) {
      const ref = `overseas:${str(row.symbol)}:${str(row.trade_time)}`
      refs.push({
        ref,
        kind: 'overseas',
        label: str(row.symbol),
        value: `${num(row.change_pct)}% @ ${str(row.trade_time)}`,
      })
      lines.push(`${ref}｜${str(row.symbol)} ${num(row.change_pct)}%（延迟 ${num(row.delay_minutes)} 分钟）`)
    }
  }

  return {
    refs,
    digest: lines.join('\n') || '没有检索到可用证据。',
    lines,
  }
}

async function searchDocuments(args: Record<string, unknown>): Promise<ToolResult> {
  const query = String(args.query || '').trim()
  if (query.length < 2) return { text: 'query 至少 2 个字符', refs: [] }
  const days = Math.max(1, Math.min(30, num(args.days, 14)))
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT id, title, source_id, published_at FROM source_documents
          WHERE published_at >= datetime('now', ?)
            AND (title LIKE ? OR full_text LIKE ? OR metadata_json LIKE ?)
          ORDER BY published_at DESC LIMIT 8`,
    args: [`-${days} days`, `%${query}%`, `%${query}%`, `%${query}%`],
  })
  if (!res.rows.length) return { text: '没有匹配文档。', refs: [] }
  const refs: EvidenceRef[] = []
  const lines = (res.rows as unknown as Row[]).map((row) => {
    const ref = `doc:${str(row.id)}`
    refs.push({ ref, kind: 'document', label: str(row.title), value: `${str(row.source_id)} ${str(row.published_at)}` })
    return `${ref}｜${str(row.published_at)}｜${str(row.title)}｜来源 ${str(row.source_id)}`
  })
  return { text: lines.join('\n'), refs }
}

async function industryMetrics(args: Record<string, unknown>): Promise<ToolResult> {
  const industry = String(args.industry || '').trim()
  if (!industry) return { text: 'industry 必填', refs: [] }
  const days = Math.max(1, Math.min(20, num(args.days, 5)))
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT * FROM industry_daily WHERE industry = ? ORDER BY trade_date DESC LIMIT ?`,
    args: [industry, days],
  })
  if (!res.rows.length) return { text: `没有 ${industry} 的行业聚合数据。`, refs: [] }
  const refs: EvidenceRef[] = []
  const lines = (res.rows as unknown as Row[]).map((row) => {
    const ref = `industry:${str(row.industry)}:${str(row.trade_date)}`
    refs.push({ ref, kind: 'industry', label: `${industry} ${str(row.trade_date)}`, value: `均值 ${num(row.avg_pct)}%` })
    return `${ref}｜均值 ${num(row.avg_pct)}%｜中位 ${num(row.median_pct)}%｜广度 ${num(row.breadth)}%｜成交额 ${num(row.amount)}｜领涨 ${str(row.leader_name)} ${num(row.leader_pct)}%`
  })
  return { text: lines.join('\n'), refs }
}

async function overseasQuotes(): Promise<ToolResult> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY trade_time DESC) AS rn
            FROM overseas_quotes
          ) WHERE rn = 1 ORDER BY symbol`,
    args: [],
  })
  if (!res.rows.length) return { text: '没有外盘行情（可能未刷新或来源不可用）。', refs: [] }
  const refs: EvidenceRef[] = []
  const lines = (res.rows as unknown as Row[]).map((row) => {
    const ref = `overseas:${str(row.symbol)}:${str(row.trade_time)}`
    refs.push({ ref, kind: 'overseas', label: str(row.symbol), value: `${num(row.change_pct)}%` })
    return `${ref}｜${str(row.symbol)} ${num(row.change_pct)}%｜延迟 ${num(row.delay_minutes)} 分钟`
  })
  return { text: lines.join('\n'), refs }
}

const TOOLS: Record<string, (args: Record<string, unknown>) => Promise<ToolResult>> = {
  search_documents: searchDocuments,
  get_industry_metrics: industryMetrics,
  get_overseas_quotes: overseasQuotes,
}

function buildSystemPrompt(budget: InvestigationBudget): string {
  return `你是A股预警深挖分析师。只做事实核查与条件推演，不给交易指令。

预算：最多 ${budget.maxSteps} 次工具调用，最长 ${Math.round(budget.timeoutMs / 1000)} 秒。

工具调用协议（需要信息时只输出 JSON）：
{"tool":"<工具名>","args":{...}}
可用工具：
- search_documents {query:string, days?:number} 检索公告/政策/新闻文档
- get_industry_metrics {industry:string, days?:number} 行业聚合与领涨股
- get_overseas_quotes {} 最新外盘行情

准则：
- 先核实预警是否成立，再给出可能的影响路径与验证条件
- 最终回答用中文 markdown，600 字以内，必须引用证据引用号（如 doc:12、industry:半导体:2026-11-14）
- 明确区分已确认事实、推测与数据缺口；不得出现买入/卖出/加仓/目标价等交易指令`
}

function fallbackConclusion(bundle: EvidenceBundle, question: string): string {
  const industryLines = bundle.refs.filter((ref) => ref.kind === 'industry').slice(0, 3)
  const docLines = bundle.refs.filter((ref) => ref.kind === 'document').slice(0, 3)
  const parts = [`针对「${question}」，本次共收集 ${bundle.refs.length} 条可核对证据。`]
  if (docLines.length) parts.push(`相关文档：${docLines.map((ref) => `${ref.ref}（${ref.label}）`).join('；')}。`)
  if (industryLines.length) parts.push(`行业信号：${industryLines.map((ref) => `${ref.ref}（${ref.value}）`).join('；')}。`)
  parts.push('结论：证据不足以形成高置信判断，建议继续观察后续公告与行业广度变化，待更多同向证据再确认。')
  return parts.join('\n\n')
}

function withCitations(text: string, refs: EvidenceRef[]): string {
  const citations = refs.slice(0, 10).map((ref) => `- ${ref.ref}｜${ref.label}`).join('\n')
  return `${text.trim().slice(0, MAX_CONCLUSION_CHARS)}\n\n证据引用：\n${citations || '- 无可用证据'}`
}

export interface RunInvestigationOptions {
  onProgress?: (progress: number, label: string) => void | Promise<void>
}

export async function runInvestigation(
  investigationId: string,
  opts: RunInvestigationOptions = {},
): Promise<InvestigationView> {
  const db = await getDb()
  const rowRes = await db.execute({ sql: 'SELECT * FROM desk_investigations WHERE id = ?', args: [investigationId] })
  const row = rowRes.rows[0] as Row | undefined
  if (!row) throw new Error('调查不存在')
  if (str(row.status) === 'succeeded') return getInvestigation(investigationId) as Promise<InvestigationView>

  const budget = parseJson<InvestigationBudget>(row.budget_json, MANUAL_BUDGET)
  const startedAt = new Date().toISOString()
  // 失败重试时步骤已存在，必须从现有最大编号继续，否则主键冲突让调查永远无法恢复。
  const stepRes = await db.execute({
    sql: 'SELECT COALESCE(MAX(step_no), 0) AS n FROM desk_investigation_steps WHERE investigation_id = ?',
    args: [investigationId],
  })
  let stepNo = num(stepRes.rows[0]?.n)
  let tokens = 0
  let costMicros = 0
  let refs: EvidenceRef[] = []
  let timedOut = false

  const mark = async (progress: number, label: string) => {
    await db.execute({
      sql: "UPDATE desk_investigations SET progress = ?, heartbeat_at = datetime('now') WHERE id = ?",
      args: [Math.max(0, Math.min(100, Math.round(progress))), investigationId],
    })
    await opts.onProgress?.(progress, label)
  }

  const addStep = async (input: {
    kind: string
    tool?: string
    args?: Record<string, unknown>
    digest: string
    refs?: EvidenceRef[]
    ok?: boolean
    durationMs?: number
    stepTokens?: number
  }) => {
    stepNo++
    await db.execute({
      sql: `INSERT INTO desk_investigation_steps
              (investigation_id, step_no, kind, tool, args_json, digest, refs_json, ok, duration_ms, tokens, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        investigationId,
        stepNo,
        input.kind,
        input.tool ?? null,
        input.args ? JSON.stringify(input.args) : null,
        input.digest.slice(0, 1000),
        JSON.stringify((input.refs || []).map((ref) => ref.ref)),
        input.ok === false ? 0 : 1,
        input.durationMs ?? null,
        input.stepTokens ?? 0,
        new Date().toISOString(),
      ],
    })
  }

  await db.execute({
    sql: `UPDATE desk_investigations SET status = 'running', started_at = ?, heartbeat_at = datetime('now') WHERE id = ?`,
    args: [startedAt, investigationId],
  })
  await mark(5, '读取预警与判断')

  try {
    // 行业上下文从预警/判断本身取：创建时不再另存副本
    let industry = ''
    let symbolCode = ''
    if (str(row.alert_id)) {
      const alert = await db.execute({ sql: 'SELECT industry, symbol_code FROM alerts WHERE id = ?', args: [str(row.alert_id)] })
      industry = str(alert.rows[0]?.industry)
      symbolCode = str(alert.rows[0]?.symbol_code)
    }
    if (!industry && str(row.judgment_id)) {
      const judgment = await db.execute({ sql: 'SELECT industry FROM judgments WHERE id = ?', args: [str(row.judgment_id)] })
      industry = str(judgment.rows[0]?.industry)
    }

    const bundle = await collectEvidence({
      alertId: str(row.alert_id) || undefined,
      judgmentId: str(row.judgment_id) || undefined,
      industry: industry || undefined,
      symbolCode: symbolCode || undefined,
    })
    refs = bundle.refs
    await addStep({ kind: 'evidence', digest: bundle.digest, refs: bundle.refs })
    await mark(15, `整理 ${bundle.refs.length} 条证据`)

    const cfg = await getEffectiveLlmConfig()
    let conclusion = ''
    const deadline = Date.now() + budget.timeoutMs

    if (cfg.apiKey && bundle.refs.length > 0) {
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: buildSystemPrompt(budget) },
        {
          role: 'user',
          content: `深挖问题：${str(row.question)}\n\n初始证据：\n${bundle.digest}`,
        },
      ]
      try {
        // 每一轮模型输出（含拒答/未知工具）都计入预算，避免未知工具导致死循环
        for (let turn = 0; turn < budget.maxSteps; turn++) {
          if (Date.now() > deadline) { timedOut = true; break }
          const result = await chatCompletion({ messages, maxTokens: 1200, temperature: 0.2 })
          const usage = (result.usage || {}) as Record<string, unknown>
          const promptTokens = num(usage.prompt_tokens)
          const completionTokens = num(usage.completion_tokens)
          tokens += promptTokens + completionTokens
          costMicros += promptTokens * PRICING.inputPerMillion + completionTokens * PRICING.outputPerMillion
          const text = (result.content || '').trim()
          if (!text) throw new Error('模型返回空内容')

          const call = tryParseToolCall(text)
          if (!call?.tool) {
            conclusion = text
            break
          }
          const tool = TOOLS[call.tool]
          if (!tool) {
            await addStep({ kind: 'reason', digest: `未知工具 ${call.tool}，已拒绝`, ok: false, stepTokens: promptTokens + completionTokens })
            messages.push({ role: 'assistant', content: text })
            messages.push({ role: 'user', content: `【工具 ${call.tool} 不存在】可用工具：${Object.keys(TOOLS).join(', ')}` })
            continue
          }
          const toolStarted = Date.now()
          let toolResult: ToolResult
          let ok = true
          try {
            toolResult = await tool(call.args || {})
          } catch (err) {
            ok = false
            toolResult = { text: `工具失败：${(err as Error).message}`, refs: [] }
          }
          refs.push(...toolResult.refs)
          await addStep({
            kind: 'tool',
            tool: call.tool,
            args: call.args || {},
            digest: toolResult.text,
            refs: toolResult.refs,
            ok,
            durationMs: Date.now() - toolStarted,
            stepTokens: promptTokens + completionTokens,
          })
          await mark(15 + ((turn + 1) / budget.maxSteps) * 65, `工具 ${turn + 1}/${budget.maxSteps}：${call.tool}`)
          messages.push({ role: 'assistant', content: text })
          messages.push({ role: 'user', content: `【工具 ${call.tool} 结果】\n${toolResult.text.slice(0, 3000)}` })
        }
      } catch (err) {
        await addStep({ kind: 'fallback', digest: `模型深挖中断，改用证据摘要：${(err as Error).message}`, ok: false })
      }
    }
    if (!conclusion) conclusion = fallbackConclusion(bundle, str(row.question))

    refs = dedupeRefs(refs)
    const finalConclusion = withCitations(conclusion, refs)
    const confidence = confidenceOf(refs)
    const evidenceStrength = strengthOf(refs)
    await addStep({ kind: 'conclusion', digest: finalConclusion, refs })
    await mark(90, '生成结论')

    await db.execute({
      sql: `UPDATE desk_investigations SET
              status = 'succeeded', progress = 100, steps_used = ?, tokens_used = ?, cost_micros = ?,
              conclusion = ?, confidence = ?, evidence_strength = ?, finished_at = ?
            WHERE id = ?`,
      args: [
        stepNo,
        tokens,
        Math.round(costMicros),
        finalConclusion,
        confidence,
        evidenceStrength,
        new Date().toISOString(),
        investigationId,
      ],
    })
    if (timedOut) {
      await addStep({ kind: 'budget', digest: `超出 ${Math.round(budget.timeoutMs / 1000)} 秒预算，已用初始证据收口`, ok: false })
    }
    await mark(100, '完成')
    return getInvestigation(investigationId) as Promise<InvestigationView>
  } catch (err) {
    await db.execute({
      sql: `UPDATE desk_investigations SET status = 'failed', error_message = ?, finished_at = ? WHERE id = ?`,
      args: [(err as Error).message, new Date().toISOString(), investigationId],
    })
    throw err
  }
}

export async function createInvestigation(input: {
  alertId?: string
  judgmentId?: string
  question?: string
  triggerReason?: string
  manual?: boolean
}): Promise<{ investigation: InvestigationView; created: boolean }> {
  if (!input.alertId && !input.judgmentId) throw new Error('需要 alertId 或 judgmentId')
  const db = await getDb()
  const budget = input.manual === false ? AUTO_BUDGET : MANUAL_BUDGET
  const kind = input.manual === false ? 'auto' : 'manual'
  const target = input.alertId || input.judgmentId
  const dedupeKey = `${kind}:${target}:${todayShanghai()}`

  let question = (input.question || '').trim()
  if (input.alertId) {
    const alert = await db.execute({ sql: 'SELECT title FROM alerts WHERE id = ?', args: [input.alertId] })
    const row = alert.rows[0]
    if (!row) throw new Error('预警不存在')
    if (!question) question = `核实预警「${str(row.title)}」：触发原因是否成立，影响路径与验证条件是什么？`
  }
  if (!question) question = '核实该判断的证据强度与失效条件。'
  const triggerReason = input.triggerReason || (input.manual === false ? '自动触发' : '手动深挖')

  const id = crypto.randomUUID()
  // 去重键唯一：并发创建时只有一条能插入，另一条读取既有记录，避免 select-then-insert 竞争。
  const inserted = await db.execute({
    sql: `INSERT INTO desk_investigations
            (id, alert_id, judgment_id, lane, status, trigger_reason, question, budget_json, dedupe_key, created_at)
          VALUES (?, ?, ?, 'interactive', 'queued', ?, ?, ?, ?, ?)
          ON CONFLICT(dedupe_key) DO NOTHING`,
    args: [
      id,
      input.alertId ?? null,
      input.judgmentId ?? null,
      triggerReason,
      question,
      JSON.stringify(budget),
      dedupeKey,
      new Date().toISOString(),
    ],
  })
  if (Number(inserted.rowsAffected) > 0) {
    return { investigation: (await getInvestigation(id)) as InvestigationView, created: true }
  }

  const existing = await db.execute({
    sql: 'SELECT id, status FROM desk_investigations WHERE dedupe_key = ?',
    args: [dedupeKey],
  })
  const existingRow = existing.rows[0]
  if (!existingRow) throw new Error('调查入队失败')
  const existingId = str(existingRow.id)
  // 手动深挖允许当天重试失败/取消的调查；自动深挖保持一天一次，避免失败循环。
  if (input.manual !== false && (str(existingRow.status) === 'failed' || str(existingRow.status) === 'canceled')) {
    await db.execute({
      sql: `UPDATE desk_investigations SET status = 'queued', progress = 0, error_message = NULL,
            started_at = NULL, finished_at = NULL, heartbeat_at = NULL, steps_used = 0,
            trigger_reason = ?, question = ? WHERE id = ?`,
      args: [triggerReason, question, existingId],
    })
    return { investigation: (await getInvestigation(existingId)) as InvestigationView, created: true }
  }
  return { investigation: (await getInvestigation(existingId)) as InvestigationView, created: false }
}

/** 自动深挖：给最高分的几条预警入队，同一交易日同一预警只做一次。 */
export async function queueAutoInvestigations(tradeDate = todayShanghai()): Promise<string[]> {
  const db = await getDb()
  const res = await db.execute({
    sql: `SELECT * FROM alerts WHERE status = 'open' AND trade_date = ?
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'important' THEN 1 ELSE 2 END, triggered_at DESC
          LIMIT 4`,
    args: [tradeDate],
  })
  const ids: string[] = []
  for (const row of res.rows as unknown as Row[]) {
    const evidence = parseJson<unknown[]>(row.evidence_json, [])
    const trigger = investigationTrigger({
      severity: str(row.severity),
      category: str(row.category),
      industry: str(row.industry) || undefined,
      evidence,
    })
    if (trigger.score < AUTO_MIN_SCORE) continue
    const created = await createInvestigation({
      alertId: str(row.id),
      triggerReason: `自动深挖 ${trigger.score} 分：${trigger.reasons.join('、')}`,
      manual: false,
    })
    if (created.created) ids.push(created.investigation.id)
  }
  return ids
}

export async function getInvestigation(id: string): Promise<InvestigationView | null> {
  const db = await getDb()
  const res = await db.execute({ sql: 'SELECT * FROM desk_investigations WHERE id = ?', args: [id] })
  const row = res.rows[0] as Row | undefined
  if (!row) return null
  const stepsRes = await db.execute({
    sql: 'SELECT * FROM desk_investigation_steps WHERE investigation_id = ? ORDER BY step_no ASC',
    args: [id],
  })
  const steps: InvestigationStepView[] = (stepsRes.rows as unknown as Row[]).map((step) => ({
    stepNo: num(step.step_no),
    kind: str(step.kind),
    tool: str(step.tool) || undefined,
    digest: str(step.digest),
    refs: parseJson<string[]>(step.refs_json, []),
    ok: num(step.ok, 1) === 1,
    durationMs: step.duration_ms == null ? undefined : num(step.duration_ms),
    tokens: num(step.tokens),
    createdAt: str(step.created_at),
  }))
  return {
    id: str(row.id),
    alertId: str(row.alert_id) || undefined,
    judgmentId: str(row.judgment_id) || undefined,
    status: str(row.status) as InvestigationStatus,
    triggerReason: str(row.trigger_reason),
    question: str(row.question),
    progress: num(row.progress),
    stepsUsed: num(row.steps_used),
    tokensUsed: num(row.tokens_used),
    costMicros: num(row.cost_micros),
    conclusion: str(row.conclusion) || undefined,
    confidence: str(row.confidence) ? (str(row.confidence) as DeskConfidence) : undefined,
    evidenceStrength: str(row.evidence_strength) ? (str(row.evidence_strength) as InvestigationView['evidenceStrength']) : undefined,
    feedback: str(row.feedback) ? (str(row.feedback) as InvestigationFeedback) : undefined,
    errorMessage: str(row.error_message) || undefined,
    createdAt: str(row.created_at),
    startedAt: str(row.started_at) || undefined,
    finishedAt: str(row.finished_at) || undefined,
    steps,
  }
}

export async function listInvestigations(opts: { status?: string; limit?: number } = {}): Promise<InvestigationView[]> {
  const db = await getDb()
  const limit = Math.max(1, Math.min(50, opts.limit ?? 20))
  const res = opts.status
    ? await db.execute({
        sql: 'SELECT id FROM desk_investigations WHERE status = ? ORDER BY created_at DESC LIMIT ?',
        args: [opts.status, limit],
      })
    : await db.execute({
        sql: 'SELECT id FROM desk_investigations ORDER BY created_at DESC LIMIT ?',
        args: [limit],
      })
  const items: InvestigationView[] = []
  for (const row of res.rows as unknown as Row[]) {
    const item = await getInvestigation(str(row.id))
    if (item) items.push(item)
  }
  return items
}

export async function setInvestigationFeedback(
  id: string,
  feedback: InvestigationFeedback | null,
): Promise<boolean> {
  const db = await getDb()
  const r = await db.execute({
    sql: 'UPDATE desk_investigations SET feedback = ? WHERE id = ?',
    args: [feedback, id],
  })
  return r.rowsAffected > 0
}
