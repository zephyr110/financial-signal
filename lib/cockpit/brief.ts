import crypto from 'crypto'
import { getDb } from '../db'
import { dateShanghai, formatSignedPct, thesisStatusLabel } from './format'
import { computeConfidence, findAdviceLanguage, validateBriefPayload } from './validators'
import { buildFactPack } from './facts'
import { generateBriefNarrative, type NarrativeResult } from './narrative'
import type {
  EvidenceItem,
  FactPack,
  SourceRef,
  SourceTier,
  TodayPayload,
} from './types'

export const PROMPT_VERSION = 'daily-brief-v1'

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function tierScore(tier: SourceTier): number {
  return [1, 0.85, 0.55, 0.2][tier] ?? 0.2
}

function sourceQuality(facts: FactPack): number {
  const sources = new Map<string, SourceRef>()
  for (const index of facts.indices) sources.set(index.source.id, index.source)
  sources.set(facts.breadth.source.id, facts.breadth.source)
  sources.set(facts.turnover.source.id, facts.turnover.source)
  for (const doc of facts.documents) sources.set(doc.source.id, doc.source)
  if (sources.size === 0) return 0.2
  return [...sources.values()].reduce((sum, source) => sum + tierScore(source.tier), 0) / sources.size
}


function sourceEvidence(id: string, label: string, source: SourceRef, value?: string): EvidenceItem {
  return { id, kind: 'fact', label, value, source }
}

/** 用户写的论点标题可能含“止损”等词；不能让它把整份系统简报卡在发布校验上。 */
function safeThesisTitle(title: string): string {
  return findAdviceLanguage(title).length > 0 ? '相关论点' : title
}

/**
 * 确定性简报：先算事实与置信度，再组织四段证据。LLM 只可作为后续叙述层，
 * 不能改写这里的数字、来源和置信度。
 */
export function buildDailyBrief(facts: FactPack): TodayPayload {
  const index = facts.indices[0]
  const avgChange = facts.indices.length
    ? facts.indices.reduce((sum, item) => sum + item.changePct, 0) / facts.indices.length
    : 0
  const totalBreadth = facts.breadth.up + facts.breadth.flat + facts.breadth.down
  const hasBreadth = totalBreadth > 0
  const upRatio = hasBreadth ? facts.breadth.up / totalBreadth : 0

  const indexCompleteness = Math.min(1, facts.indices.length / 3)
  const stockCompleteness = Math.min(1, facts.stocks.length / 5)
  const docCompleteness = facts.documents.length > 0 ? 1 : 0.5
  const completeness =
    (0.5 * indexCompleteness + 0.35 * stockCompleteness + 0.15 * docCompleteness) *
    (facts.isDemo ? 0.85 : 1)
  const freshness = dateShanghai(facts.asOf) === facts.tradeDate ? 1 : 0.6
  // 缺失广度不等于 0% 上涨：没有数据时不参与背离判断，只降低一致性。
  const divergent = hasBreadth &&
    ((avgChange > 0.1 && upRatio < 0.45) || (avgChange < -0.1 && upRatio > 0.55))
  const agreement = facts.indices.length === 0 ? 0.2 : !hasBreadth ? 0.55 : divergent ? 0.45 : 0.8
  const confidence = computeConfidence({
    completeness,
    freshness,
    agreement,
    sourceQuality: sourceQuality(facts),
  })

  let claim: string
  if (!index) {
    claim = '指数行情缺失，今日只保留数据质量记录，不形成方向判断。'
  } else if (!hasBreadth) {
    claim = avgChange > 0.1
      ? '指数收涨，但涨跌家数缺失，无法验证广度，赚钱效应待数据补齐确认。'
      : avgChange < -0.1
        ? '指数回落，但涨跌家数缺失，无法判断个股是否同步走弱。'
        : '指数窄幅整理，涨跌家数缺失，方向证据不足。'
  } else if (avgChange > 0.1 && upRatio < 0.45) {
    claim = '指数收涨，但上涨家数占比不足一半，赚钱效应偏弱。'
  } else if (avgChange > 0.1) {
    claim = '指数与上涨广度同向，风险偏好较前一日回升。'
  } else if (avgChange < -0.1 && upRatio > 0.55) {
    claim = '指数回落但多数个股上涨，权重与题材出现分化。'
  } else if (avgChange < -0.1) {
    claim = '指数走弱，上涨家数同步收缩，止跌证据尚未出现。'
  } else {
    claim = '指数窄幅整理，方向证据不足，继续等待广度与量能确认。'
  }

  const evidence: EvidenceItem[] = []
  if (index) {
    evidence.push(sourceEvidence(
      `fact:index:${index.code}`,
      `${index.name}收于 ${index.close.toFixed(2)}，${formatSignedPct(index.changePct)}`,
      index.source,
      index.close.toFixed(2),
    ))
  } else {
    evidence.push(sourceEvidence(
      'fact:breadth:up',
      `上涨家数 ${facts.breadth.up} 家，指数行情尚未到位`,
      facts.breadth.source,
      String(facts.breadth.up),
    ))
  }
  evidence.push({
    id: 'inference:breadth',
    kind: 'inference',
    label: hasBreadth
      ? `上涨家数占比 ${(upRatio * 100).toFixed(1)}%，${upRatio < 0.5 ? '广度弱于指数' : '广度与指数同向'}。`
      : '涨跌家数缺失，无法判断市场广度。',
  })
  evidence.push({
    id: 'counter:turnover',
    kind: 'counter',
    label: facts.turnover.changePct >= 3
      ? `成交额较前一日放大 ${facts.turnover.changePct.toFixed(1)}%，放量分化使趋势确认度下降。`
      : facts.turnover.changePct <= -3
        ? `成交额较前一日收缩 ${Math.abs(facts.turnover.changePct).toFixed(1)}%，缩量使方向信号变弱。`
        : `成交额变化 ${formatSignedPct(facts.turnover.changePct, 1)}，量能未给出额外确认。`,
    source: facts.turnover.source,
  })
  evidence.push({
    id: 'conclusion:posture',
    kind: 'conclusion',
    label: !hasBreadth
      ? '维持中性观察；先补齐涨跌家数数据，再验证指数方向是否有广度支撑。'
      : upRatio < 0.5
        ? '维持中性观察；明日先验证上涨家数占比能否回到 50% 以上。'
        : '维持中性观察；明日验证上涨宽度能否延续，以及领涨方向是否扩散。',
  })

  const stockMap = new Map(facts.stocks.map((stock) => [stock.code, stock]))
  const thesisMap = new Map(facts.theses.map((thesis) => [thesis.code, thesis]))
  const totalPositionValue = facts.positions.reduce((sum, position) => {
    const stock = stockMap.get(position.code)
    return sum + (stock ? Math.round(stock.price * 100) * position.shares : 0)
  }, 0)

  const impactPositions = facts.positions.filter((position) => stockMap.has(position.code))
  const impactSource = impactPositions.length > 0
    ? impactPositions.slice(0, 3).map((position) => ({ position, stock: stockMap.get(position.code)! }))
    : facts.stocks.slice(0, 3).map((stock) => ({ position: null, stock }))

  const impacts = impactSource.map(({ position, stock }) => {
    const thesis = thesisMap.get(stock.code)
    const docs = facts.documents.filter((doc) => doc.subjectCode === stock.code)
    const impactEvidence: EvidenceItem[] = [
      sourceEvidence(
        `fact:stock:${stock.code}`,
        `${stock.name}收盘 ${stock.price.toFixed(2)}，${formatSignedPct(stock.changePct)}`,
        stock.source,
        stock.price.toFixed(2),
      ),
    ]
    if (docs[0]) {
      impactEvidence.push(sourceEvidence(
        `document:${docs[0].id}`,
        docs[0].title,
        docs[0].source,
      ))
    }

    if (!position || totalPositionValue <= 0) {
      return {
        code: stock.code,
        name: stock.name,
        headline: `${stock.name} ${formatSignedPct(stock.changePct)}`,
        detail: `自选股收盘 ${stock.price.toFixed(2)} 元。${thesis ? `关联论点「${safeThesisTitle(thesis.title)}」当前为${thesisStatusLabel(thesis.status)}。` : '尚未建立论点。'}`,
        thesisStatus: thesis?.status,
        evidence: impactEvidence,
      }
    }

    const weight = (Math.round(stock.price * 100) * position.shares / totalPositionValue) * 100
    const contribution = (weight * stock.changePct) / 100
    return {
      code: stock.code,
      name: stock.name,
      headline: `${stock.name} ${formatSignedPct(stock.changePct)}`,
      detail: `持仓 ${position.shares} 股，权重 ${weight.toFixed(1)}%，今日对组合贡献 ${contribution >= 0 ? '+' : ''}${round2(contribution).toFixed(2)} 个百分点。${thesis ? `关联论点状态：${thesisStatusLabel(thesis.status)}。` : ''}`,
      thesisStatus: thesis?.status,
      evidence: impactEvidence,
    }
  })

  const weakened = facts.theses.find((thesis) => thesis.status === 'weakened' || thesis.status === 'broken')
  const tomorrow = [
    !hasBreadth
      ? '先补齐涨跌家数数据，再验证指数方向是否有广度支撑。'
      : upRatio < 0.5
        ? '验证上涨家数占比能否回到 50% 以上，确认指数上涨是否有广度支撑。'
        : '验证上涨宽度能否延续，以及领涨方向是否从少数标的扩散。',
    facts.turnover.changePct >= 3
      ? '观察成交额放大后能否维持，放量分化需要后续方向确认。'
      : '观察成交额是否配合方向变化；缩量或量能背离时降低置信度。',
    weakened
      ? `复核「${safeThesisTitle(weakened.title)}」的失效条件，逐条对照新公告与价格。`
      : '逐条复核持仓论点，记录支持与反对证据，不因单日涨跌改结论。',
  ]

  return {
    tradeDate: facts.tradeDate,
    issueNo: 1,
    session: 'post',
    hero: { claim, confidence, evidence },
    indices: facts.indices,
    breadth: facts.breadth,
    turnover: facts.turnover,
    impacts,
    documents: facts.documents.slice(0, 4),
    tomorrow,
    dataQuality: facts.dataQuality,
    isDemo: facts.isDemo,
    generatedAt: new Date().toISOString(),
  }
}

function contentHash(facts: FactPack): string {
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}

/**
 * 简报不可变：同一天重复生成时更新版本号，旧版本保留自己的 fact_snapshot_id。
 * 校验失败不会写 published 报告，任务应把错误暴露给用户。
 */
export async function buildAndStoreDailyReport(
  tradeDate: string,
  options: {
    force?: boolean
    taskId?: string
    /** 显式传入则不再调用模型；null 表示本次不生成叙述层。 */
    narrative?: NarrativeResult | null
  } = {},
): Promise<{ reportId: number; payload: TodayPayload; version: number; narrative: NarrativeResult | null }> {
  const db = await getDb()

  if (!options.force) {
    const existing = await db.execute({
      sql: `SELECT id, version, payload_json FROM reports
            WHERE kind = 'daily_brief' AND subject_code = '' AND trade_date = ? AND status = 'published'
            ORDER BY version DESC LIMIT 1`,
      args: [tradeDate],
    })
    if (existing.rows[0]) {
      const payload = parseJson<TodayPayload | null>(existing.rows[0].payload_json, null)
      if (payload) {
        return {
          reportId: Number(existing.rows[0].id),
          version: Number(existing.rows[0].version),
          payload,
          narrative: null,
        }
      }
    }
  }

  const facts = await buildFactPack(tradeDate)
  const payload = buildDailyBrief(facts)
  const narrative = options.narrative === undefined
    ? await generateBriefNarrative(payload, options.taskId)
    : options.narrative
  if (narrative) {
    payload.narrative = {
      text: narrative.text,
      model: narrative.model,
      promptVersion: narrative.promptVersion,
    }
  }
  const knownFactIds = new Set(Object.keys(facts.facts))
  const knownSourceIds = new Set(facts.dataQuality.map((source) => source.id))
  const validation = validateBriefPayload(payload, knownFactIds, knownSourceIds)
  if (!validation.ok) {
    throw new Error(`简报校验失败：${validation.issues.filter((i) => i.severity === 'fail').map((i) => i.message).join('；')}`)
  }

  const hash = contentHash(facts)
  await db.execute({
    sql: `INSERT OR IGNORE INTO fact_snapshots
          (trade_date, as_of, universe, payload_json, content_hash, is_demo, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [tradeDate, facts.asOf, 'portfolio+watchlist+indices', JSON.stringify(facts), hash, facts.isDemo ? 1 : 0, new Date().toISOString()],
  })
  const snapshot = await db.execute({
    sql: 'SELECT id FROM fact_snapshots WHERE content_hash = ?',
    args: [hash],
  })
  const snapshotId = snapshot.rows[0] ? Number(snapshot.rows[0].id) : null

  const now = new Date().toISOString()
  // 版本号与期号必须和 INSERT 同一写事务：并行 worker 否则会同时算出 v1 撞唯一索引。
  const tx = await db.transaction('write')
  let version = 0
  let reportId = 0
  try {
    const maxVersionRes = await tx.execute({
      sql: `SELECT COALESCE(MAX(version), 0) AS v FROM reports
            WHERE kind = 'daily_brief' AND subject_code = '' AND trade_date = ?`,
      args: [tradeDate],
    })
    version = Number(maxVersionRes.rows[0]?.v || 0) + 1
    const countRes = await tx.execute({
      sql: "SELECT COUNT(*) AS n FROM reports WHERE kind = 'daily_brief'",
      args: [],
    })
    payload.issueNo = Number(countRes.rows[0]?.n || 0) + 1

    const inserted = await tx.execute({
      sql: `INSERT INTO reports
            (kind, subject_code, trade_date, version, status, payload_json, fact_snapshot_id,
             model, prompt_version, cost_micros, is_demo, created_at, published_at)
            VALUES ('daily_brief', '', ?, ?, 'published', ?, ?, ?, ?, 0, ?, ?, ?)`,
      args: [
        tradeDate,
        version,
        JSON.stringify(payload),
        snapshotId,
        narrative?.model || 'deterministic',
        narrative ? `${PROMPT_VERSION}+${narrative.promptVersion}` : PROMPT_VERSION,
        narrative?.costMicros || 0,
        facts.isDemo ? 1 : 0,
        now,
        now,
      ],
    })
    reportId = Number(inserted.lastInsertRowid)
    await tx.commit()
  } catch (err) {
    try { await tx.rollback() } catch { /* tx already closed */ }
    throw err
  }

  if (snapshotId !== null) {
    await db.execute({
      sql: `INSERT INTO validation_runs (snapshot_id, check_type, status, severity, detail_json, created_at)
            VALUES (?, 'brief', 'pass', 'info', ?, ?)`,
      args: [snapshotId, JSON.stringify({ issues: validation.issues }), now],
    })
  }

  return { reportId, payload, version, narrative }
}
